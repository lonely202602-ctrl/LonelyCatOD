package com.lonelycat.server.persistence;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * 操作日志表：每一个被服务器接受的操作都追加一行，按 (docId, revision) 唯一。
 *
 * <p>revision 是该操作应用之后文档的版本号：第 1 个操作让文档从 0 版变成 1 版，revision = 1。
 * 服务重启时按 revision 升序重放快照之后的操作即可恢复内容。
 */
@Entity
@Table(name = "operations",
        indexes = @Index(name = "idx_operations_doc_rev", columnList = "docId, revision", unique = true))
public class OperationEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 36)
    private String docId;

    @Column(nullable = false)
    private int revision;

    /** 操作的紧凑 JSON，例如 [1,-1,2] */
    @Lob
    @Column(nullable = false)
    private String opJson;

    /** 提交者的 clientId */
    @Column(length = 64)
    private String author;

    @Column(nullable = false)
    private Instant createdAt = Instant.now();

    public Long getId() {
        return id;
    }

    public String getDocId() {
        return docId;
    }

    public void setDocId(String docId) {
        this.docId = docId;
    }

    public int getRevision() {
        return revision;
    }

    public void setRevision(int revision) {
        this.revision = revision;
    }

    public String getOpJson() {
        return opJson;
    }

    public void setOpJson(String opJson) {
        this.opJson = opJson;
    }

    public String getAuthor() {
        return author;
    }

    public void setAuthor(String author) {
        this.author = author;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Instant createdAt) {
        this.createdAt = createdAt;
    }
}
