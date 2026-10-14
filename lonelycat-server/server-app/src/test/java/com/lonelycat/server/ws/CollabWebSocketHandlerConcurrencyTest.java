package com.lonelycat.server.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lonelycat.server.protocol.Message;
import com.lonelycat.server.session.DocumentService;
import com.lonelycat.server.session.DocumentSession;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 针对「并发提交时广播必须按 revision 定序」的回归测试。
 *
 * <p>修复前的缺陷：DocumentSession.receive 的锁只覆盖版本号分配，持久化、ack、广播都在
 * 锁外执行——两个线程拿到 rev=1 / rev=2 之后可能颠倒广播顺序，客户端收到超前版本会丢操作，
 * 内容永久分歧。修复方式是把「转换 + 持久化 + ack + 广播」整体放进文档锁。
 *
 * <p>测试手段：模拟「第一个操作的持久化特别慢」（在 mock 的 applyOperation 里 sleep），
 * 第二个操作在它之后立刻完成。修复前观察者会先收到 rev=2；修复后必定是 rev=1、rev=2。
 */
class CollabWebSocketHandlerConcurrencyTest {

    private final ObjectMapper mapper = new ObjectMapper();

    /** 一个 mock 的 WebSocketSession，把它收到的所有消息 payload 记下来 */
    private record Recorded(WebSocketSession session, List<String> messages) {
    }

    private Recorded recordingSession(String id) throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        List<String> messages = Collections.synchronizedList(new ArrayList<>());
        when(session.getId()).thenReturn(id);
        when(session.isOpen()).thenReturn(true);
        doAnswer(inv -> {
            messages.add(((TextMessage) inv.getArgument(0)).getPayload());
            return null;
        }).when(session).sendMessage(any());
        return new Recorded(session, messages);
    }

    private void send(CollabWebSocketHandler handler, WebSocketSession session, Message msg)
            throws Exception {
        handler.handleTextMessage(session, new TextMessage(mapper.writeValueAsString(msg)));
    }

    private void join(CollabWebSocketHandler handler, WebSocketSession session,
                      String docId, String name) throws Exception {
        Message join = Message.of("join");
        join.docId = docId;
        join.name = name;
        send(handler, session, join);
    }

    @Test
    void concurrentOperationsAreBroadcastInRevisionOrder() throws Exception {
        DocumentSession docSession = new DocumentSession("d1", "chat", 0);
        DocumentService documentService = mock(DocumentService.class);
        when(documentService.getSession("d1")).thenReturn(Optional.of(docSession));

        // 模拟不对称的持久化耗时：rev=1 的操作在「提交后」停 200ms，rev=2 立刻完成
        CountDownLatch firstApplied = new CountDownLatch(1);
        doAnswer(inv -> {
            DocumentSession s = inv.getArgument(0);
            DocumentSession.Applied applied = s.receive(inv.getArgument(1), inv.getArgument(2));
            if (applied.revision() == 1) {
                firstApplied.countDown();
                Thread.sleep(200);
            }
            return applied;
        }).when(documentService).applyOperation(any(), any(), anyInt(), any());

        CollabWebSocketHandler handler = new CollabWebSocketHandler(documentService);
        Recorded observer = recordingSession("observer");
        Recorded a = recordingSession("a");
        Recorded b = recordingSession("b");
        handler.afterConnectionEstablished(observer.session());
        handler.afterConnectionEstablished(a.session());
        handler.afterConnectionEstablished(b.session());
        join(handler, observer.session(), "d1", "观察者");
        join(handler, a.session(), "d1", "Alice");
        join(handler, b.session(), "d1", "Bob");
        observer.messages().clear();

        // A 先完成版本分配（拿到 rev=1），然后卡在持久化里；此时 B 的提交开始处理
        Thread ta = new Thread(() -> {
            Message op = Message.of("op");
            op.docId = "d1";
            op.revision = 0;
            op.op = List.of(1, -1, 2);
            try {
                send(handler, a.session(), op);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        ta.start();
        assertTrue(firstApplied.await(2, TimeUnit.SECONDS), "第一个操作应先完成版本分配");

        Thread tb = new Thread(() -> {
            Message op = Message.of("op");
            op.docId = "d1";
            op.revision = 0;
            op.op = List.of(4, "s");
            try {
                send(handler, b.session(), op);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        tb.start();
        ta.join(5000);
        tb.join(5000);
        assertFalse(ta.isAlive(), "A 的处理线程不应卡死");
        assertFalse(tb.isAlive(), "B 的处理线程不应卡死");

        // 观察者收到的操作广播必须严格按 revision 升序：修复前这里是 [2, 1]
        List<Integer> revisions = observer.messages().stream()
                .map(this::parse)
                .filter(m -> "op".equals(m.type))
                .map(m -> m.revision)
                .toList();
        assertEquals(List.of(1, 2), revisions,
                "同一文档的操作广播必须按 revision 定序，否则客户端会丢操作");
    }

    @Test
    void persistenceFailureIsAnsweredWithErrorMessage() throws Exception {
        DocumentSession docSession = new DocumentSession("d1", "chat", 0);
        DocumentService documentService = mock(DocumentService.class);
        when(documentService.getSession("d1")).thenReturn(Optional.of(docSession));
        when(documentService.applyOperation(any(), any(), anyInt(), any()))
                .thenThrow(new DataAccessResourceFailureException("db down"));

        CollabWebSocketHandler handler = new CollabWebSocketHandler(documentService);
        Recorded a = recordingSession("a");
        handler.afterConnectionEstablished(a.session());
        join(handler, a.session(), "d1", "Alice");
        a.messages().clear();

        // 持久化失败不能让异常逃出 handleTextMessage（否则装饰器直接关闭连接，客户端不知情）
        Message op = Message.of("op");
        op.docId = "d1";
        op.revision = 0;
        op.op = List.of(1, -1, 2);
        send(handler, a.session(), op);

        assertTrue(a.messages().stream().anyMatch(p -> p.contains("\"type\":\"error\"")),
                "持久化失败应给客户端回一条 error 消息");
    }

    private Message parse(String payload) {
        try {
            return mapper.readValue(payload, Message.class);
        } catch (Exception e) {
            throw new RuntimeException("消息解析失败: " + payload, e);
        }
    }
}
