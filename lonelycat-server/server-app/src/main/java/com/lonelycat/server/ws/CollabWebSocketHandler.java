package com.lonelycat.server.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lonelycat.ot.TextOperation;
import com.lonelycat.server.protocol.Message;
import com.lonelycat.server.session.CrdtSession;
import com.lonelycat.server.session.DocumentService;
import com.lonelycat.server.session.DocumentSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * WebSocket 处理器：维护「连接 ↔ 客户端」和「文档 ↔ 在线连接」两张表，
 * 把客户端消息分发到对应处理逻辑，并把结果广播给同一文档的其他人。
 *
 * <p>一个连接同一时间只加入一个文档（简化模型，足够第一版使用）。
 */
@Component
public class CollabWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(CollabWebSocketHandler.class);

    private final DocumentService documentService;
    private final ObjectMapper mapper = new ObjectMapper();

    /** 连接 id -> 客户端状态 */
    private final Map<String, Client> clients = new ConcurrentHashMap<>();

    /** docId -> 在这个文档里的连接集合 */
    private final Map<String, Set<Client>> rooms = new ConcurrentHashMap<>();

    public CollabWebSocketHandler(DocumentService documentService) {
        this.documentService = documentService;
    }

    // ------------------------------------------------------------------
    // 连接生命周期
    // ------------------------------------------------------------------

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        // 用装饰器包一层：WebSocketSession 不允许并发 send，装饰器内部排队发送
        WebSocketSession safe = new ConcurrentWebSocketSessionDecorator(session, 5_000, 512 * 1024);
        Client client = new Client(safe, "c-" + UUID.randomUUID().toString().substring(0, 8));
        clients.put(session.getId(), client);
        log.info("连接建立 {} -> clientId {}", session.getId(), client.clientId);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        Client client = clients.remove(session.getId());
        if (client != null) {
            leaveRoom(client);
            log.info("连接关闭 {} ({})", client.clientId, status);
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage textMessage) {
        Client client = clients.get(session.getId());
        if (client == null) {
            return;
        }
        Message msg;
        try {
            msg = mapper.readValue(textMessage.getPayload(), Message.class);
        } catch (IOException e) {
            send(client, Message.error("消息格式错误: " + e.getMessage()));
            return;
        }
        try {
            switch (msg.type == null ? "" : msg.type) {
                case "join" -> onJoin(client, msg);
                case "op" -> onOperation(client, msg);
                case "cursor" -> onCursor(client, msg);
                case "typing" -> onTyping(client, msg);
                case "leave" -> leaveRoom(client);
                default -> send(client, Message.error("未知消息类型: " + msg.type));
            }
        } catch (Exception e) {
            // OT 校验失败（版本不对、长度不匹配）、持久化异常（事务回滚）等都从这里出去：
            // 告知客户端，让它重新 join 拉全量恢复。不捕获的话异常会沿装饰器链关闭连接，
            // 客户端只能靠断线重连恢复，而且收不到任何原因说明。
            log.warn("客户端 {} 的消息处理失败: {}", client.clientId, e.toString());
            send(client, Message.error(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
        }
    }

    // ------------------------------------------------------------------
    // 各类消息处理
    // ------------------------------------------------------------------

    /** 加入文档：回 snapshot，并通知房间里其他人。OT / CRDT 文档走两条分支 */
    private void onJoin(Client client, Message msg) {
        if (msg.docId == null) {
            send(client, Message.error("join 缺少 docId"));
            return;
        }
        var docEntity = documentService.findDocument(msg.docId).orElse(null);
        if (docEntity != null && "crdt".equals(docEntity.getEngine())) {
            joinCrdt(client, msg);
            return;
        }

        DocumentSession docSession = documentService.getSession(msg.docId).orElse(null);
        if (docSession == null) {
            send(client, Message.error("文档不存在: " + msg.docId));
            return;
        }

        leaveRoom(client); // 如果之前在别的文档里，先离开
        client.name = msg.name == null || msg.name.isBlank() ? client.clientId : msg.name.trim();
        client.docId = msg.docId;
        client.engine = "ot";
        Set<Client> room = rooms.computeIfAbsent(msg.docId, k -> new CopyOnWriteArraySet<>());

        // 整个加入过程放在文档锁内，和 onOperation 的广播共用同一把锁：
        // 「读快照 → 发快照 → 进房」是一个原子动作，不会出现「拿到旧快照、又错过进房前
        // 已提交的操作」——那种交错会让新客户端永远漏掉一个版本。
        synchronized (docSession) {
            Message snapshot = Message.of("snapshot");
            snapshot.content = docSession.getContent();
            snapshot.revision = docSession.getRevision();
            snapshot.docId = msg.docId;
            snapshot.clientId = client.clientId;
            List<Message.ClientInfo> others = new ArrayList<>();
            for (Client c : room) {
                others.add(new Message.ClientInfo(c.clientId, c.name));
            }
            snapshot.clients = others;
            send(client, snapshot);

            room.add(client);

            Message joined = Message.of("joined");
            joined.docId = msg.docId;
            joined.client = new Message.ClientInfo(client.clientId, client.name);
            broadcast(room, joined, client);
        }
    }

    /** CRDT 文档的加入：多带一份全量副本状态（字符身份证结构），其余与 OT 相同 */
    private void joinCrdt(Client client, Message msg) {
        CrdtSession crdtSession = documentService.getCrdtSession(msg.docId).orElseThrow();
        leaveRoom(client);
        client.name = msg.name == null || msg.name.isBlank() ? client.clientId : msg.name.trim();
        client.docId = msg.docId;
        client.engine = "crdt";
        Set<Client> room = rooms.computeIfAbsent(msg.docId, k -> new CopyOnWriteArraySet<>());

        synchronized (crdtSession) {
            Message snapshot = Message.of("snapshot");
            snapshot.content = crdtSession.getText();
            snapshot.revision = crdtSession.getRevision();
            snapshot.docId = msg.docId;
            snapshot.clientId = client.clientId;
            snapshot.crdtState = new ArrayList<>(crdtSession.getState());
            List<Message.ClientInfo> others = new ArrayList<>();
            for (Client c : room) {
                others.add(new Message.ClientInfo(c.clientId, c.name));
            }
            snapshot.clients = others;
            send(client, snapshot);

            room.add(client);

            Message joined = Message.of("joined");
            joined.docId = msg.docId;
            joined.client = new Message.ClientInfo(client.clientId, client.name);
            broadcast(room, joined, client);
        }
    }

    /** 客户端提交操作：按 join 时记住的引擎分流。CRDT 无 transform、无版本校验、无 ack */
    private void onOperation(Client client, Message msg) {
        if (client.docId == null || !client.docId.equals(msg.docId)) {
            send(client, Message.error("请先 join 文档再提交操作"));
            return;
        }
        if ("crdt".equals(client.engine)) {
            onCrdtOperation(client, msg);
            return;
        }
        if (msg.revision == null || !(msg.op instanceof List)) {
            send(client, Message.error("op 消息缺少 revision 或 op"));
            return;
        }
        DocumentSession docSession = documentService.getSession(client.docId).orElseThrow();
        @SuppressWarnings("unchecked")
        TextOperation op = TextOperation.fromJson((List<Object>) msg.op);

        // 「转换 + 持久化 + ack + 广播」必须在同一把文档锁内整体串行。
        // 只 synchronized receive 是不够的：那样版本号虽是按序分配的，
        // 两个线程仍可能颠倒广播顺序（rev=2 先于 rev=1 到达客户端），
        // 而客户端的 OT 状态机要求远端操作严格按 revision 逐个到来。
        // @Transactional 的提交发生在 applyOperation 返回之前，也在锁内，落库顺序与广播顺序一致。
        synchronized (docSession) {
            DocumentSession.Applied applied =
                    documentService.applyOperation(docSession, op, msg.revision, client.clientId);

            Message ack = Message.of("ack");
            ack.docId = client.docId;
            ack.revision = applied.revision();
            send(client, ack);

            Message broadcastMsg = Message.of("op");
            broadcastMsg.docId = client.docId;
            broadcastMsg.revision = applied.revision();
            broadcastMsg.op = applied.op().toJson();
            broadcastMsg.author = client.clientId;
            broadcast(rooms.getOrDefault(client.docId, Set.of()), broadcastMsg, client);
        }
    }

    /**
     * CRDT 操作：应用 → 持久化 → 广播，没了。
     * 这里的 synchronized 只让日志顺序与广播顺序一致（重放舒服），删掉它收敛性不受影响——
     * 与上面 OT 分支「拿掉锁就塌」对照着看，正是两种引擎的分水岭。
     */
    private void onCrdtOperation(Client client, Message msg) {
        if (!(msg.op instanceof Map)) {
            send(client, Message.error("CRDT 操作格式错误：应为对象"));
            return;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> crdtOp = (Map<String, Object>) msg.op;
        CrdtSession crdtSession = documentService.getCrdtSession(client.docId).orElseThrow();
        synchronized (crdtSession) {
            int revision = documentService.applyCrdtOperation(crdtSession, crdtOp, client.clientId);
            if (revision < 0) {
                return; // 重复投递（幂等命中），静默跳过
            }
            Message broadcastMsg = Message.of("op");
            broadcastMsg.docId = client.docId;
            broadcastMsg.revision = revision;
            broadcastMsg.op = crdtOp;
            broadcastMsg.author = client.clientId;
            broadcast(rooms.getOrDefault(client.docId, Set.of()), broadcastMsg, client);
        }
    }

    /** 光标位置：不经过服务器状态，直接转发。客户端收到后自行随本地未确认操作做转换。 */
    private void onCursor(Client client, Message msg) {
        if (client.docId == null || msg.cursor == null) {
            return;
        }
        Message out = Message.of("cursor");
        out.docId = client.docId;
        out.author = client.clientId;
        out.cursor = msg.cursor;
        broadcast(rooms.getOrDefault(client.docId, Set.of()), out, client);
    }

    /** 「正在输入」心跳：纯转发，无服务器状态。客户端自己节流发送、超时隐藏。 */
    private void onTyping(Client client, Message msg) {
        if (client.docId == null) {
            return;
        }
        Message out = Message.of("typing");
        out.docId = client.docId;
        out.author = client.clientId;
        broadcast(rooms.getOrDefault(client.docId, Set.of()), out, client);
    }

    /**
     * 文档被 REST 删除时通知房间里的所有人并就地清房。
     * 不走 leaveRoom 逐个广播 left（那会对每个成员发一遍离开消息），一条 deleted 说清楚。
     */
    public void broadcastDocDeleted(String docId) {
        Set<Client> room = rooms.remove(docId);
        if (room == null) {
            return;
        }
        Message out = Message.of("deleted");
        out.docId = docId;
        for (Client c : room) {
            c.docId = null;
            send(c, out);
        }
    }

    private void leaveRoom(Client client) {
        String docId = client.docId;
        if (docId == null) {
            return;
        }
        client.docId = null;
        Set<Client> room = rooms.get(docId);
        if (room == null) {
            return;
        }
        room.remove(client);
        Message left = Message.of("left");
        left.docId = docId;
        left.clientId = client.clientId;
        broadcast(room, left, client);
        if (room.isEmpty()) {
            rooms.remove(docId);
            // 最后一个人离开时写一次快照，减少下次恢复要重放的操作数
            documentService.getSession(docId).ifPresent(documentService::saveSnapshot);
        }
    }

    // ------------------------------------------------------------------
    // 发送工具
    // ------------------------------------------------------------------

    private void send(Client client, Message msg) {
        try {
            String json = mapper.writeValueAsString(msg);
            if (client.session.isOpen()) {
                client.session.sendMessage(new TextMessage(json));
            }
        } catch (IOException e) {
            log.warn("发送给 {} 失败: {}", client.clientId, e.getMessage());
        }
    }

    private void broadcast(Set<Client> room, Message msg, Client except) {
        for (Client c : room) {
            if (c != except) {
                send(c, msg);
            }
        }
    }

    /** 一个 WebSocket 连接对应的客户端状态 */
    private static final class Client {
        final WebSocketSession session;
        final String clientId;
        volatile String name;
        volatile String docId;
        /** 加入文档时记住引擎类型，之后每个 op 不用再查库分流 */
        volatile String engine = "ot";

        Client(WebSocketSession session, String clientId) {
            this.session = session;
            this.clientId = clientId;
            this.name = clientId;
        }
    }
}
