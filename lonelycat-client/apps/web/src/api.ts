import { apiUrl } from './config';

/** 与后端 DocumentController.DocumentSummary 对应 */
export interface DocumentSummary {
  id: string;
  title: string;
  /** 同步引擎：ot（三状态机）或 crdt（RGA） */
  engine: 'ot' | 'crdt';
  snapshotRevision: number;
  createdAt: string;
  updatedAt: string;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const res = await fetch(apiUrl('/docs'));
  if (!res.ok) throw new Error(`获取文档列表失败: ${res.status}`);
  return res.json();
}

export async function getDocument(id: string): Promise<DocumentSummary | null> {
  const res = await fetch(apiUrl(`/docs/${id}`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`获取文档失败: ${res.status}`);
  return res.json();
}

export async function createDocument(title: string, engine: 'ot' | 'crdt' = 'ot'): Promise<DocumentSummary> {
  const res = await fetch(apiUrl('/docs'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content: '', engine }),
  });
  if (!res.ok) throw new Error(`创建文档失败: ${res.status}`);
  return res.json();
}

export async function renameDocument(id: string, title: string): Promise<void> {
  const res = await fetch(apiUrl(`/docs/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`重命名失败: ${res.status}`);
}

export async function deleteDocument(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/docs/${id}`), { method: 'DELETE' });
  if (!res.ok) throw new Error(`删除失败: ${res.status}`);
}

/** 一条操作日志（与后端 ReplayOp 对应）。op 的形状随引擎不同：OT 是数组，CRDT 是对象 */
export interface ReplayOp {
  revision: number;
  author: string;
  op: unknown;
  createdAt: string;
}

/** 后端 ReplayResponse：引擎 + 快照 + 全部操作日志，客户端自行推演每一版 */
export interface ReplayData {
  engine: 'ot' | 'crdt';
  baseContent: string;
  baseRevision: number;
  operations: ReplayOp[];
}

export async function getReplayData(id: string): Promise<ReplayData> {
  const res = await fetch(apiUrl(`/docs/${id}/replay`));
  if (!res.ok) throw new Error(`获取回放数据失败: ${res.status}`);
  return res.json();
}
