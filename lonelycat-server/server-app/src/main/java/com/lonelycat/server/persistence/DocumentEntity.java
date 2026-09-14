package com.lonelycat.server.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * 文档表：保存文档的元信息和「快照」。
 *
 * <p>快照 = 某个版本号时的完整内容。服务重启时先加载快照，再重放快照之后的操作日志，
 * 就能恢复到最新版本，不用从第 0 版开始重放全部历史。
 */
@Entity
@Table(name = "documents")
public class DocumentEntity {

    @Id
    @Column(length = 36)
    private String id;

    @Column(nullable = false)
    private String title;

    /** 快照内容 */
    @Lob
    @Column(nullable = false)
    private String content = "";

    /** 快照对应的版本号，快照之后的操作要从 operations 表重放 */
    @Column(nullable = false)
    private int snapshotRevision = 0;

    @Column(nullable = false)
    private Instant createdAt = Instant.now();

    @Column(nullable = false)
    private Instant updatedAt = Instant.now();

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getContent() {
        return content;
    }

    public void setContent(String content) {
        this.content = content;
    }

    public int getSnapshotRevision() {
        return snapshotRevision;
    }

    public void setSnapshotRevision(int snapshotRevision) {
        this.snapshotRevision = snapshotRevision;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Instant createdAt) {
        this.createdAt = createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(Instant updatedAt) {
        this.updatedAt = updatedAt;
    }
}
