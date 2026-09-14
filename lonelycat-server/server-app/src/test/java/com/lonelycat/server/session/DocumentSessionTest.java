package com.lonelycat.server.session;

import com.lonelycat.ot.TextOperation;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * 模拟两个客户端基于同一版本并发提交，验证服务器端的转换逻辑。
 */
class DocumentSessionTest {

    @Test
    void concurrentOperationsAreTransformedAgainstHistory() {
        DocumentSession session = new DocumentSession("doc", "chat", 0);

        // A 基于第 0 版：删掉 h
        TextOperation a = new TextOperation().retain(1).delete(1).retain(2);
        DocumentSession.Applied appliedA = session.receive(a, 0);
        assertEquals(1, appliedA.revision());
        assertEquals("cat", session.getContent());

        // B 也基于第 0 版：在 t 后面加 s。到达时服务器已经是第 1 版，需要转换
        TextOperation b = new TextOperation().retain(4).insert("s");
        DocumentSession.Applied appliedB = session.receive(b, 0);
        assertEquals(2, appliedB.revision());
        assertEquals("cats", session.getContent());
        // 广播出去的是转换后的操作：retain 3, insert s
        assertEquals(java.util.List.of(3, "s"), appliedB.op().toJson());
    }

    @Test
    void rejectsRevisionAheadOfServer() {
        DocumentSession session = new DocumentSession("doc", "abc", 0);
        TextOperation op = new TextOperation().retain(3).insert("d");
        assertThrows(IllegalArgumentException.class, () -> session.receive(op, 5));
    }

    @Test
    void rejectsRevisionOlderThanHistory() {
        // 从快照第 10 版恢复，history 里没有更早的操作
        DocumentSession session = new DocumentSession("doc", "abc", 10);
        TextOperation op = new TextOperation().retain(3).insert("d");
        assertThrows(IllegalArgumentException.class, () -> session.receive(op, 9));
        // 基于第 10 版则正常
        assertEquals(11, session.receive(op, 10).revision());
    }

    @Test
    void rejectsLengthMismatch() {
        DocumentSession session = new DocumentSession("doc", "abc", 0);
        TextOperation op = new TextOperation().retain(5); // 文档只有 3 个字符
        assertThrows(IllegalArgumentException.class, () -> session.receive(op, 0));
    }
}
