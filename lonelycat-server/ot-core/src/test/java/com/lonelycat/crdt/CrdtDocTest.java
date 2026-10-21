package com.lonelycat.crdt;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * CRDT 教学版的核心验证：收敛性与到达顺序无关。
 * 对照 OT 的 RandomConvergenceTest 看——那边靠 transform 函数兜收敛，这边靠身份证 + 同源定序。
 */
class CrdtDocTest {

    private static void apply(CrdtDoc doc, Map<String, Object> op) {
        if ("i".equals(op.get("t"))) {
            doc.applyInsertJson(op);
        } else {
            doc.applyDeleteJson(op);
        }
    }

    @Test
    void 并发同位置插入_两个副本不同接收顺序_文本一致() {
        // A、B 各自在空文档开头打一个词，操作交叉/成组两种顺序到达第三个副本
        CrdtDoc a = new CrdtDoc("siteA");
        CrdtDoc b = new CrdtDoc("siteB");
        var opsA = a.localReplace(0, 0, "hello");
        var opsB = b.localReplace(0, 0, "world");

        CrdtDoc c1 = new CrdtDoc("c1");
        CrdtDoc c2 = new CrdtDoc("c2");
        // 交叉顺序：A1 B1 A2 B2 ...
        for (int i = 0; i < 5; i++) {
            apply(c1, opsA.get(i));
            apply(c1, opsB.get(i));
        }
        // 成组顺序：先 A 全部，再 B 全部
        opsA.forEach(op -> apply(c2, op));
        opsB.forEach(op -> apply(c2, op));

        assertEquals(c1.getText(), c2.getText(), "不同到达顺序必须得到同一文本");
        assertEquals(10, c1.getText().length());
    }

    @Test
    void 接力编辑_操作传回去_双方一致() {
        CrdtDoc a = new CrdtDoc("siteA");
        CrdtDoc b = new CrdtDoc("siteB");

        var opsA = a.localReplace(0, 0, "ab");
        opsA.forEach(op -> apply(b, op));
        assertEquals("ab", b.getText());

        // B 在末尾接着打（origin = 最后一个字符的身份证）
        var opsB = b.localReplace(2, 0, "cd");
        opsB.forEach(op -> apply(a, op));
        assertEquals("abcd", a.getText());
        assertEquals("abcd", b.getText());
    }

    @Test
    void 删除打墓碑_两边一致_且不挡后续插入() {
        CrdtDoc a = new CrdtDoc("siteA");
        CrdtDoc b = new CrdtDoc("siteB");
        var opsA = a.localReplace(0, 0, "abc");
        opsA.forEach(op -> apply(b, op));

        var del = a.localReplace(1, 1, ""); // 删 b
        apply(b, del.get(0));
        assertEquals("ac", a.getText());
        assertEquals("ac", b.getText());

        // 在被删字符的位置继续插入，origin 指向的是墓碑也没关系
        var more = a.localReplace(1, 0, "X");
        more.forEach(op -> apply(b, op));
        assertEquals("aXc", a.getText());
        assertEquals("aXc", b.getText());
    }

    @Test
    void 重复投递幂等() {
        CrdtDoc doc = new CrdtDoc("siteA");
        var ops = doc.localReplace(0, 0, "hi");
        apply(doc, ops.get(0)); // 同一个插入投两次
        apply(doc, ops.get(0));
        assertEquals(2, doc.visibleLength());
    }

    @Test
    void 副本状态可以整体搬家() {
        CrdtDoc a = new CrdtDoc("siteA");
        a.localReplace(0, 0, "hello");
        a.localReplace(1, 1, "E"); // 改一个字符，留一个墓碑

        CrdtDoc b = new CrdtDoc("siteB");
        b.loadState(a.stateToJson());
        assertEquals(a.getText(), b.getText());
        assertEquals(a.getEntries().size(), b.getEntries().size(), "墓碑结构也要一致");
    }
}
