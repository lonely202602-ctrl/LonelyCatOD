package com.lonelycat.server.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lonelycat.ot.TextOperation;
import com.lonelycat.server.protocol.Message;
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
                case "leave" -> leaveRoom(client);
                default -> send(client, Message.error("未知消息类型: " + msg.type));
            }
        } catch (IllegalArgumentException | IllegalStateException e) {
            // OT 校验失败（版本不对、长度不匹配等）：告知客户端，让它重新 join 拉全量
            log.warn("客户端 {} 的操作被拒绝: {}", client.clientId, e.getMessage());
            send(client, Message.error(e.getMessage()));
        }
    }

    // ------------------------------------------------------------------
    // 各类消息处理
    // ------------------------------------------------------------------

    /** 加入文档：回 snapshot，并通知房间里其他人 */
    private void onJoin(Client client, Message msg) {
        if (msg.docId == null) {
            send(client, Message.error("join 缺少 docId"));
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
        Set<Client> room = rooms.computeIfAbsent(msg.docId, k -> new CopyOnWriteArraySet<>());

        // 在会话锁内读取内容和版本，避免读到「内容已更新但版本还没加一」的中间态
        Message snapshot = Message.of("snapshot");
        synchronized (docSession) {
            snapshot.content = docSession.getContent();
            snapshot.revision = docSession.getRevision();
        }
        snapshot.docId = msg.docId;
        snapshot.clientId = client.clientId;
        List<Message.ClientInfo> others = new ArrayList<>();
        for (Client c : room) {
            others.add(new Message.ClientInfo(c.clientId, c.name));
        }
        snapshot.clients = others;
        send(client, snapshot);

        Message joined = Message.of("joined");
        joined.docId = msg.docId;
        joined.client = new Message.ClientInfo(client.clientId, client.name);
        broadcast(room, joined, client);

        room.add(client);
    }

    /** 客户端提交操作：OT 转换 → 持久化 → ack 给自己 → 广播给别人 */
    private void onOperation(Client client, Message msg) {
        if (client.docId == null || !client.docId.equals(msg.docId)) {
            send(client, Message.error("请先 join 文档再提交操作"));
            return;
        }
        if (msg.revision == null || msg.op == null) {
            send(client, Message.error("op 消息缺少 revision 或 op"));
            return;
        }
        DocumentSession docSession = documentService.getSession(client.docId).orElseThrow();
        TextOperation op = TextOperation.fromJson(msg.op);

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

        Client(WebSocketSession session, String clientId) {
            this.session = session;
            this.clientId = clientId;
            this.name = clientId;
        }
    }
}
