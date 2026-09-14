package com.lonelycat.server.session;

import com.lonelycat.ot.OtEngine;
import com.lonelycat.ot.TextOperation;

import java.util.ArrayList;
import java.util.List;

/**
 * 一个文档在内存中的实时状态：当前内容、版本号、操作历史。
 *
 * <p>这是 OT 服务器端的核心。所有方法都用 synchronized 串行化，
 * 保证同一个文档的操作是一个一个处理的，这样版本号才有意义。
 *
 * <p>版本号约定：revision = 已接受的操作数量。第 0 版是初始内容，
 * 应用第 1 个操作后是第 1 版。history.get(i) 是「把第 i 版变成第 i+1 版」的操作。
 */
public class DocumentSession {

    private final String docId;
    private String content;
    private int revision;

    /**
     * 操作历史。为了支持从快照恢复，history 里可能不包含最早的操作，
     * 所以用 historyStartRevision 记录 history.get(0) 对应的版本。
     * 客户端基于的版本如果比它还老，就拒绝（要求客户端重新 join）。
     */
    private final List<TextOperation> history = new ArrayList<>();
    private final int historyStartRevision;

    public DocumentSession(String docId, String content, int revision) {
        this.docId = docId;
        this.content = content;
        this.revision = revision;
        this.historyStartRevision = revision;
    }

    public String getDocId() {
        return docId;
    }

    public synchronized String getContent() {
        return content;
    }

    public synchronized int getRevision() {
        return revision;
    }

    /**
     * 接收客户端提交的操作。
     *
     * @param op      客户端的操作
     * @param baseRev 客户端生成这个操作时，本地文档所处的版本号
     * @return 转换到最新版本后的操作，以及它成为的新版本号
     * @throws IllegalArgumentException baseRev 非法（超前、太旧、或操作长度不匹配）
     */
    public synchronized Applied receive(TextOperation op, int baseRev) {
        if (baseRev > revision) {
            throw new IllegalArgumentException("客户端版本 " + baseRev + " 超前于服务器版本 " + revision);
        }
        if (baseRev < historyStartRevision) {
            throw new IllegalArgumentException("客户端版本 " + baseRev + " 太旧，服务器已无该段历史，请重新加入文档");
        }

        // 关键步骤：客户端基于第 baseRev 版生成操作，但服务器已经到了第 revision 版。
        // 中间的每一个并发操作 history[baseRev..revision) 都要和它做一次 transform，
        // 把它「搬」到最新版本上。约定客户端操作作为 transform 的第一个参数（见 OtEngine 说明）。
        TextOperation transformed = op;
        for (int r = baseRev; r < revision; r++) {
            TextOperation concurrent = history.get(r - historyStartRevision);
            transformed = OtEngine.transform(transformed, concurrent).aPrime();
        }

        if (transformed.getBaseLength() != content.length()) {
            throw new IllegalArgumentException(
                    "操作长度 " + transformed.getBaseLength() + " 与文档长度 " + content.length() + " 不一致");
        }

        content = transformed.apply(content);
        history.add(transformed);
        revision++;
        return new Applied(transformed, revision);
    }

    /** receive 的结果：转换后的操作和它对应的新版本号 */
    public record Applied(TextOperation op, int revision) {
    }
}
