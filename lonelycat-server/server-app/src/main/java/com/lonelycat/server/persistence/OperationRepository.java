package com.lonelycat.server.persistence;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface OperationRepository extends JpaRepository<OperationEntity, Long> {

    /** 取出某个版本之后的全部操作，用于重放恢复 */
    List<OperationEntity> findByDocIdAndRevisionGreaterThanOrderByRevisionAsc(String docId, int revision);
}
