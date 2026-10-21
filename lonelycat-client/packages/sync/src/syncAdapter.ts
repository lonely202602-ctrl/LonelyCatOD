import type { TextOperation } from '@lonelycat/ot-core';

/**
 * 同步层对外接口。编辑器只依赖这个接口，不关心底层是 OT 还是 CRDT。
 * 第一版实现是 OtSyncAdapter（OT + WebSocket）；以后换 CRDT 时写一个 YjsSyncAdapter 替换即可。
 */

/** 连接状态 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface RemoteClient {
  clientId: string;
  name: string;
}

export interface RemoteCursor {
  clientId: string;
  /** 选区起点 */
  anchor: number;
  /** 光标位置（选区终点） */
  head: number;
}

/** 同步层向编辑器发出的事件（用 type 而不是 interface，这样才满足 Emitter 的索引签名约束） */
export type SyncEvents = {
  /** 加入文档成功，或重连后重新拉取全文。编辑器应当用 content 整体替换当前内容 */
  snapshot: (content: string, revision: number, self: RemoteClient, others: RemoteClient[]) => void;
  /** 收到远端操作（已经转换到可以直接作用于当前编辑器内容的形式） */
  remoteOp: (op: TextOperation, author: string) => void;
  /** 远端光标变化 */
  cursor: (cursor: RemoteCursor) => void;
  /** 有人正在输入（心跳，实现层负责节流发送；展示方自行做超时隐藏） */
  typing: (clientId: string) => void;
  /** 有人加入 */
  joined: (client: RemoteClient) => void;
  /** 有人离开 */
  left: (clientId: string) => void;
  /** 当前文档被删除（REST 删除时服务器广播），收到后应离开编辑页 */
  deleted: (docId: string) => void;
  /** 连接状态变化 */
  status: (status: ConnectionStatus) => void;
  /** 服务器返回错误 */
  error: (message: string) => void;
};

export interface SyncAdapter {
  connect(): void;
  disconnect(): void;

  /**
   * 本地产生了一个操作（用户在编辑器里打字）。
   * 操作的 baseLength 必须等于「编辑器当前内容长度」。
   */
  applyLocal(op: TextOperation): void;

  /** 广播自己的光标 */
  sendCursor(anchor: number, head: number): void;

  /** 通知别人「我正在输入」。实现层负责节流，调用方只管在本地编辑时调它 */
  sendTyping(): void;

  on<K extends keyof SyncEvents>(event: K, handler: SyncEvents[K]): () => void;
}

/** 极简事件分发器，供适配器实现复用 */
export class Emitter<E extends Record<string, (...args: never[]) => void>> {
  private handlers: { [K in keyof E]?: Set<E[K]> } = {};

  on<K extends keyof E>(event: K, handler: E[K]): () => void {
    (this.handlers[event] ??= new Set()).add(handler);
    return () => this.handlers[event]?.delete(handler);
  }

  emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    this.handlers[event]?.forEach((h) => (h as (...a: Parameters<E[K]>) => void)(...args));
  }
}
