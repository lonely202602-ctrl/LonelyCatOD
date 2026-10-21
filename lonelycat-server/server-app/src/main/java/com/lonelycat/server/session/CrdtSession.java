package com.lonelycat.server.session;

import com.lonelycat.crdt.CrdtDoc;

import java.util.List;
import java.util.Map;

/**
 * CRDT 文档的服务端会话：一份普通的服务器副本 + 一个日志计数。
 *
 * <p>和 {@link DocumentSession}（OT）对比着看，消失的东西比留下的多：
 * <ul>
 *   <li>没有 transform——操作天生适用于任意副本，直接进 {@link CrdtDoc#applyInsertJson}；</li>
 *   <li>没有版本号校验——客户端不基于"版本号"提交，服务器也不拒绝任何时序；</li>
 *   <li>没有客户端单在途约束——想发几条发几条，乱序到达也收敛；</li>
 *   <li>没有为正确性而设的锁——下面的 synchronized 只是为了让「应用顺序、
 *       日志 revision、广播顺序」三者一致，读日志重放时舒服一点，拿掉它收敛性不受影响。</li>
 * </ul>
 * 服务器在这里就是个「中转站 + 存储」：应用一份副本用于持久化和给新成员发全量状态。
 */
public class CrdtSession {

    private final String docId;
    private final CrdtDoc doc = new CrdtDoc("server");
    /** 日志条数。CRDT 收敛不依赖它，但持久化顺序、快照节奏还用它 */
    private int revision = 0;

    private CrdtSession(String docId) {
        this.docId = docId;
    }

    /** 从全部操作日志重建副本（CRDT 文档的快照列只存展示用纯文本，重建必须重放日志） */
    public static CrdtSession restore(String docId, List<Map<String, Object>> opsInLogOrder) {
        CrdtSession s = new CrdtSession(docId);
        for (Map<String, Object> op : opsInLogOrder) {
            s.apply(op);
            s.revision++;
        }
        return s;
    }

    /**
     * 应用一个远端操作。返回应用后的日志版本；重复投递（幂等命中）返回 -1，调用方跳过持久化与广播。
     */
    public synchronized int apply(Map<String, Object> opJson) {
        String t = String.valueOf(opJson.get("t"));
        int r = "i".equals(t) ? doc.applyInsertJson(opJson) : doc.applyDeleteJson(opJson);
        if (r >= 0) {
            revision++;
        }
        return r >= 0 ? revision : -1;
    }

    public synchronized String getText() {
        return doc.getText();
    }

    /** 全量副本状态：随 snapshot 发给新成员（光有文本不够，别人要引用字符的身份证） */
    public synchronized List<List<Object>> getState() {
        return doc.stateToJson();
    }

    public synchronized int getRevision() {
        return revision;
    }

    public String getDocId() {
        return docId;
    }
}
