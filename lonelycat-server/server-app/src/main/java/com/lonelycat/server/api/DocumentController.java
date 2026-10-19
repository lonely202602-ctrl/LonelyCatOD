package com.lonelycat.server.api;

import com.lonelycat.server.persistence.DocumentEntity;
import com.lonelycat.server.session.DocumentService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.List;

/**
 * 文档管理 REST 接口。实时编辑走 WebSocket，这里只负责列表和创建。
 *
 * <pre>
 *   GET  /api/docs        文档列表
 *   POST /api/docs        创建文档  body: { "title": "...", "content": "..." }
 *   GET  /api/docs/{id}   文档元信息
 * </pre>
 */
@RestController
@RequestMapping("/api/docs")
public class DocumentController {

    private final DocumentService documentService;

    public DocumentController(DocumentService documentService) {
        this.documentService = documentService;
    }

    @GetMapping
    public List<DocumentSummary> list() {
        return documentService.listDocuments().stream().map(DocumentSummary::from).toList();
    }

    @PostMapping
    public ResponseEntity<DocumentSummary> create(@RequestBody(required = false) CreateRequest req) {
        String title = req == null ? null : req.title();
        String content = req == null ? null : req.content();
        DocumentEntity created = documentService.createDocument(title, content);
        return ResponseEntity.status(HttpStatus.CREATED).body(DocumentSummary.from(created));
    }

    @GetMapping("/{id}")
    public ResponseEntity<DocumentSummary> get(@PathVariable("id") String id) {
        return documentService.findDocument(id)
                .map(DocumentSummary::from)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    public record CreateRequest(String title, String content) {
    }

    /** 对外暴露的文档摘要，不带全文（全文通过 WebSocket snapshot 获取） */
    public record DocumentSummary(String id, String title, int snapshotRevision,
                                  Instant createdAt, Instant updatedAt) {
        static DocumentSummary from(DocumentEntity e) {
            return new DocumentSummary(e.getId(), e.getTitle(), e.getSnapshotRevision(),
                    e.getCreatedAt(), e.getUpdatedAt());
        }
    }
}
