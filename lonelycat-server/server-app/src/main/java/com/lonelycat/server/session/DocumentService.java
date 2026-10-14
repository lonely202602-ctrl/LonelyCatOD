package com.lonelycat.server.session;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lonelycat.ot.TextOperation;
import com.lonelycat.server.config.LonelyCatProperties;
import com.lonelycat.server.persistence.DocumentEntity;
import com.lonelycat.server.persistence.DocumentRepository;
import com.lonelycat.server.persistence.OperationEntity;
import com.lonelycat.server.persistence.OperationRepository;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 文档服务：管理内存中的 {@link DocumentSession}，并负责和数据库之间的加载与持久化。
 *
 * <p>职责划分：
 * <ul>
 *   <li>{@link DocumentSession} 只管 OT 逻辑，不知道数据库的存在</li>
 *   <li>本类负责「第一次访问时从数据库恢复」和「每次操作后写日志、定期写快照」</li>
 * </ul>
 */
@Service
public class DocumentService {

    private static final Logger log = LoggerFactory.getLogger(DocumentService.class);

    private final DocumentRepository documentRepository;
    private final OperationRepository operationRepository;
    private final LonelyCatProperties props;
    private final ObjectMapper mapper = new ObjectMapper();

    /** docId -> 内存中的实时会话。只有被打开过的文档才会加载进来。 */
    private final Map<String, DocumentSession> sessions = new ConcurrentHashMap<>();

    public DocumentService(DocumentRepository documentRepository,
                           OperationRepository operationRepository,
                           LonelyCatProperties props) {
        this.documentRepository = documentRepository;
        this.operationRepository = operationRepository;
        this.props = props;
    }

    // ------------------------------------------------------------------
    // 文档元信息（REST 用）
    // ------------------------------------------------------------------

    public List<DocumentEntity> listDocuments() {
        return documentRepository.findAllByOrderByUpdatedAtDesc();
    }

    public Optional<DocumentEntity> findDocument(String id) {
        return documentRepository.findById(id);
    }

    @Transactional
    public DocumentEntity createDocument(String title, String initialContent) {
        DocumentEntity doc = new DocumentEntity();
        doc.setId(UUID.randomUUID().toString());
        doc.setTitle(title == null || title.isBlank() ? "未命名文档" : title.trim());
        doc.setContent(initialContent == null ? "" : initialContent);
        doc.setSnapshotRevision(0);
        return documentRepository.save(doc);
    }

    // ------------------------------------------------------------------
    // 实时会话
    // ------------------------------------------------------------------

    /**
     * 取得文档会话；不在内存时从数据库恢复：加载快照，再重放快照之后的操作日志。
     *
     * @return 文档不存在时返回 empty
     */
    public Optional<DocumentSession> getSession(String docId) {
        DocumentSession existing = sessions.get(docId);
        if (existing != null) {
            return Optional.of(existing);
        }
        return documentRepository.findById(docId).map(entity ->
                sessions.computeIfAbsent(docId, id -> restore(entity)));
    }

    private DocumentSession restore(DocumentEntity entity) {
        String content = entity.getContent();
        int revision = entity.getSnapshotRevision();

        List<OperationEntity> tail =
                operationRepository.findByDocIdAndRevisionGreaterThanOrderByRevisionAsc(entity.getId(), revision);
        for (OperationEntity opEntity : tail) {
            TextOperation op = parseOp(opEntity.getOpJson());
            content = op.apply(content);
            revision = opEntity.getRevision();
        }
        log.info("恢复文档 {}：快照版本 {}，重放 {} 个操作，当前版本 {}",
                entity.getId(), entity.getSnapshotRevision(), tail.size(), revision);
        return new DocumentSession(entity.getId(), content, revision);
    }

    /**
     * 处理客户端提交的操作：交给会话做 OT，然后写操作日志，按间隔写快照。
     *
     * <p>持久化失败时事务会回滚，但 {@link DocumentSession#receive} 已经修改了内存
     * （内容、版本号、历史）。此时把会话踢出内存：下次访问从数据库重新恢复——
     * 重放「最后一次成功提交」之前的操作日志总能得到一致的状态，
     * 否则内存会永远领先于数据库，重启后文档内容倒退。
     */
    @Transactional
    public DocumentSession.Applied applyOperation(DocumentSession session, TextOperation op,
                                                  int baseRev, String author) {
        try {
            DocumentSession.Applied applied = session.receive(op, baseRev);

            OperationEntity entity = new OperationEntity();
            entity.setDocId(session.getDocId());
            entity.setRevision(applied.revision());
            entity.setOpJson(toJson(applied.op()));
            entity.setAuthor(author);
            operationRepository.save(entity);

            if (applied.revision() % props.snapshotInterval() == 0) {
                saveSnapshot(session);
            }
            return applied;
        } catch (IllegalArgumentException e) {
            // 客户端错误（版本超前/太旧、长度不匹配）：receive 在修改内存之前就拒绝了，
            // 会话仍然一致，照常拒绝即可，不要把会话踢出内存
            throw e;
        } catch (RuntimeException e) {
            sessions.remove(session.getDocId());
            throw e;
        }
    }

    /** 把会话当前内容写成快照 */
    @Transactional
    public void saveSnapshot(DocumentSession session) {
        documentRepository.findById(session.getDocId()).ifPresent(doc -> {
            // 在会话锁内一次性读取内容和版本，保证两者对应同一时刻
            synchronized (session) {
                doc.setContent(session.getContent());
                doc.setSnapshotRevision(session.getRevision());
            }
            doc.setUpdatedAt(Instant.now());
            documentRepository.save(doc);
        });
    }

    /** 服务关闭时把所有内存中的文档写一次快照，下次启动无需重放 */
    @PreDestroy
    public void flushAll() {
        sessions.values().forEach(this::saveSnapshot);
    }

    // ------------------------------------------------------------------
    // JSON 工具
    // ------------------------------------------------------------------

    public TextOperation parseOp(String json) {
        try {
            return TextOperation.fromJson(mapper.readValue(json, List.class));
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("操作 JSON 解析失败: " + json, e);
        }
    }

    public String toJson(TextOperation op) {
        try {
            return mapper.writeValueAsString(op.toJson());
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
