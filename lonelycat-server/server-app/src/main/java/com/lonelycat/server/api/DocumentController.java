package com.lonelycat.server.api;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lonelycat.server.persistence.DocumentEntity;
import com.lonelycat.server.persistence.OperationEntity;
import com.lonelycat.server.session.DocumentService;
import com.lonelycat.server.session.DocumentService.ReplayData;
import com.lonelycat.server.ws.CollabWebSocketHandler;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.List;

/**
 * 文档管理 REST 接口。实时编辑走 WebSocket，这里负责列表、创建、重命名、删除和回放数据。
 *
 * <pre>
 *   GET    /api/docs             文档列表
 *   POST   /api/docs             创建文档  body: { "title": "...", "content": "..." }
 *   GET    /api/docs/{id}        文档元信息
 *   PATCH  /api/docs/{id}        重命名    body: { "title": "..." }
 *   DELETE /api/docs/{id}        删除文档（同时通知在线的 WebSocket 房间）
 *   GET    /api/docs/{id}/replay 时光回放数据：快照 + 全部操作日志
 * </pre>
 */
@RestController
@RequestMapping("/api/docs")
public class DocumentController {

    private final DocumentService documentService;
    private final CollabWebSocketHandler wsHandler;
    private final ObjectMapper mapper = new ObjectMapper();

    public DocumentController(DocumentService documentService, CollabWebSocketHandler wsHandler) {
        this.documentService = documentService;
        this.wsHandler = wsHandler;
    }

    @GetMapping
    public List<DocumentSummary> list() {
        return documentService.listDocuments().stream().map(DocumentSummary::from).toList();
    }

    @PostMapping
    public ResponseEntity<DocumentSummary> create(@RequestBody(required = false) CreateRequest req) {
        String title = req == null ? null : req.title();
        String content = req == null ? null : req.content();
        String engine = req == null ? null : req.engine();
        DocumentEntity created = documentService.createDocument(title, content, engine);
        return ResponseEntity.status(HttpStatus.CREATED).body(DocumentSummary.from(created));
    }

    @GetMapping("/{id}")
    public ResponseEntity<DocumentSummary> get(@PathVariable("id") String id) {
        return documentService.findDocument(id)
                .map(DocumentSummary::from)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @PatchMapping("/{id}")
    public ResponseEntity<DocumentSummary> rename(@PathVariable("id") String id,
                                                  @RequestBody RenameRequest req) {
        return documentService.renameDocument(id, req == null ? null : req.title())
                .map(DocumentSummary::from)
                .map(ResponseEntity::<DocumentSummary>ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable("id") String id) {
        boolean deleted = documentService.deleteDocument(id);
        if (deleted) {
            // 正在编辑的人收到 deleted 后跳回列表，避免对着幽灵文档继续编辑
            wsHandler.broadcastDocDeleted(id);
        }
        return deleted ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }

    @GetMapping("/{id}/replay")
    public ResponseEntity<ReplayResponse> replay(@PathVariable("id") String id) {
        return documentService.getReplayData(id)
                .map(data -> ResponseEntity.ok(ReplayResponse.from(mapper, data)))
                .orElse(ResponseEntity.notFound().build());
    }

    public record CreateRequest(String title, String content, String engine) {
    }

    public record RenameRequest(String title) {
    }

    /** 一条操作日志的对外形状。op 解析成真正的 JSON（OT 是数组、CRDT 是对象），客户端拿来即用 */
    public record ReplayOp(int revision, String author, Object op, Instant createdAt) {
        static ReplayOp from(ObjectMapper mapper, OperationEntity e) {
            try {
                Object op = mapper.readValue(e.getOpJson(), Object.class);
                return new ReplayOp(e.getRevision(), e.getAuthor(), op, e.getCreatedAt());
            } catch (JsonProcessingException ex) {
                throw new IllegalStateException("操作日志损坏: " + e.getOpJson(), ex);
            }
        }
    }

    public record ReplayResponse(String engine, String baseContent, int baseRevision, List<ReplayOp> operations) {
        static ReplayResponse from(ObjectMapper mapper, ReplayData data) {
            return new ReplayResponse(
                    data.engine(),
                    data.content(),
                    data.snapshotRevision(),
                    data.operations().stream().map(e -> ReplayOp.from(mapper, e)).toList());
        }
    }

    /** 对外暴露的文档摘要，不带全文（全文通过 WebSocket snapshot 获取） */
    public record DocumentSummary(String id, String title, String engine, int snapshotRevision,
                                  Instant createdAt, Instant updatedAt) {
        static DocumentSummary from(DocumentEntity e) {
            return new DocumentSummary(e.getId(), e.getTitle(), e.getEngine(), e.getSnapshotRevision(),
                    e.getCreatedAt(), e.getUpdatedAt());
        }
    }
}
