import { apiUrl } from './config';

/** 与后端 DocumentController.DocumentSummary 对应 */
export interface DocumentSummary {
  id: string;
  title: string;
  snapshotRevision: number;
  createdAt: string;
  updatedAt: string;
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const res = await fetch(apiUrl('/docs'));
  if (!res.ok) throw new Error(`获取文档列表失败: ${res.status}`);
  return res.json();
}

export async function createDocument(title: string): Promise<DocumentSummary> {
  const res = await fetch(apiUrl('/docs'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content: '' }),
  });
  if (!res.ok) throw new Error(`创建文档失败: ${res.status}`);
  return res.json();
}
