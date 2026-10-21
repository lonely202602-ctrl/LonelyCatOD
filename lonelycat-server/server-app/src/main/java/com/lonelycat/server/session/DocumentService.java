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

    /** docId -> CRDT 文档的服务端会话，与 OT 会话并行存在、互不干扰 */
    private final Map<String, CrdtSession> crdtSessions = new ConcurrentHashMap<>();

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
    public DocumentEntity createDocument(String title, String initialContent, String engine) {
        DocumentEntity doc = new DocumentEntity();
        doc.setId(UUID.randomUUID().toString());
        doc.setTitle(title == null || title.isBlank() ? "未命名文档" : title.trim());
        doc.setContent(initialContent == null ? "" : initialContent);
        doc.setSnapshotRevision(0);
        doc.setEngine("crdt".equals(engine) ? "crdt" : "ot"); // 只认这两个值，默认 ot
        return documentRepository.save(doc);
    }

    /** 重命名文档。编辑中的会话不感知（下次进文档或刷新列表时看到新标题） */
    @Transactional
    public Optional<DocumentEntity> renameDocument(String id, String title) {
        return documentRepository.findById(id).map(doc -> {
            doc.setTitle(title == null || title.isBlank() ? doc.getTitle() : title.trim());
            doc.setUpdatedAt(Instant.now());
            return documentRepository.save(doc);
        });
    }

    /**
     * 删除文档：清操作日志、删文档行、把内存会话踢出。
     * 在线客户端由 WebSocket 层广播 deleted 消息（见 CollabWebSocketHandler.broadcastDocDeleted）。
     */
    @Transactional
    public boolean deleteDocument(String id) {
        if (!documentRepository.existsById(id)) {
            return false;
        }
        operationRepository.deleteByDocId(id);
        documentRepository.deleteById(id);
        sessions.remove(id);
        crdtSessions.remove(id);
        return true;
    }

    /** 时光回放数据：引擎类型 + 快照 + 全部操作日志（客户端自行推演出每一版内容） */
    public Optional<ReplayData> getReplayData(String id) {
        return documentRepository.findById(id).map(entity -> new ReplayData(
                entity.getEngine(),
                entity.getContent(),
                entity.getSnapshotRevision(),
                operationRepository.findByDocIdOrderByRevisionAsc(id)));
    }

    /** 时光回放的载荷：引擎类型 + 快照（content@snapshotRevision）+ 全量操作日志 */
    public record ReplayData(String engine, String content, int snapshotRevision, List<OperationEntity> operations) {
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

    // ------------------------------------------------------------------
    // CRDT 会话：服务器只是一份普通副本（中转站 + 存储）
    // ------------------------------------------------------------------

    /**
     * 取得 CRDT 文档会话；不在内存时从数据库重放全部操作日志重建副本。
     * 不用快照列重建——快照里只有纯文本，丢了字符的身份证，别人后续的操作就没法落座。
     */
    public Optional<CrdtSession> getCrdtSession(String docId) {
        CrdtSession existing = crdtSessions.get(docId);
        if (existing != null) {
            return Optional.of(existing);
        }
        return documentRepository.findById(docId).map(entity -> {
            if (!"crdt".equals(entity.getEngine())) {
                throw new IllegalArgumentException("文档 " + docId + " 不是 CRDT 引擎");
            }
            return crdtSessions.computeIfAbsent(docId, id -> {
                List<Map<String, Object>> ops = operationRepository
                        .findByDocIdOrderByRevisionAsc(id).stream()
                        .map(e -> parseCrdtOp(e.getOpJson()))
                        .toList();
                CrdtSession session = CrdtSession.restore(id, ops);
                log.info("恢复 CRDT 文档 {}：重放 {} 个操作，当前 {} 字符", id, ops.size(), session.getText().length());
                return session;
            });
        });
    }

    /**
     * 处理 CRDT 操作：应用 → 写日志 → 按间隔写快照。返回日志版本；重复投递返回 -1（调用方跳过广播）。
     * synchronized 只保证「应用顺序 = 日志顺序 = 广播顺序」，拿掉它收敛性依然成立——
     * 这正是 CRDT 和 OT（§P0 竞态）最本质的差别。
     */
    @Transactional
    public int applyCrdtOperation(CrdtSession session, Map<String, Object> opJson, String author) {
        try {
            int revision = session.apply(opJson);
            if (revision < 0) {
                return -1;
            }
            OperationEntity entity = new OperationEntity();
            entity.setDocId(session.getDocId());
            entity.setRevision(revision);
            entity.setOpJson(toJson(opJson));
            entity.setAuthor(author);
            operationRepository.save(entity);

            if (revision % props.snapshotInterval() == 0) {
                documentRepository.findById(session.getDocId()).ifPresent(docRow -> {
                    synchronized (session) {
                        docRow.setContent(session.getText());
                        docRow.setSnapshotRevision(revision);
                    }
                    docRow.setUpdatedAt(Instant.now());
                    documentRepository.save(docRow);
                });
            }
            return revision;
        } catch (RuntimeException e) {
            crdtSessions.remove(session.getDocId());
            throw e;
        }
    }

    /** 服务关闭时把所有内存中的文档写一次快照，下次启动无需重放 */
    @PreDestroy
    public void flushAll() {
        sessions.values().forEach(this::saveSnapshot);
        // CRDT 会话没有可写的快照（身份证结构不在快照列里），但内容列要保持新鲜供列表/回放展示
        for (CrdtSession session : crdtSessions.values()) {
            documentRepository.findById(session.getDocId()).ifPresent(doc -> {
                synchronized (session) {
                    doc.setContent(session.getText());
                    doc.setSnapshotRevision(session.getRevision());
                }
                doc.setUpdatedAt(Instant.now());
                documentRepository.save(doc);
            });
        }
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

    /** CRDT 操作日志的 JSON -> Map（线路格式见 CrdtDoc 类注释） */
    @SuppressWarnings("unchecked")
    public Map<String, Object> parseCrdtOp(String json) {
        try {
            return mapper.readValue(json, Map.class);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("CRDT 操作 JSON 解析失败: " + json, e);
        }
    }

    public String toJson(Map<String, Object> crdtOp) {
        try {
            return mapper.writeValueAsString(crdtOp);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
