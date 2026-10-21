import { CrdtDoc, type CrdtOpJson } from '@lonelycat/crdt-core';
import type { ChangeSpec } from '@codemirror/state';
import { Emitter, type ConnectionStatus, type RemoteClient, type SyncEvents } from './syncAdapter';

/**
 * CRDT（RGA）+ WebSocket 的同步适配器。与 OtSyncAdapter 对照着看：
 *   - 没有 OtClient 三状态机——单在途约束、ack、版本号校验全部不需要；
 *   - 收到的操作直接进本地 CrdtDoc，应用后把结果翻译成 CodeMirror 变更；
 *   - snapshot 多带一份 crdtState（字符身份证结构），光有文本没法接后续操作。
 * 服务器对 CRDT 文档只做中转与持久化，不 ack。
 */

export interface CrdtSyncOptions {
  url: string;
  docId: string;
  name: string;
  reconnectDelayMs?: number;
}

interface WireMessage {
  type: string;
  docId?: string;
  revision?: number;
  op?: unknown;
  crdtState?: unknown[];
  author?: string;
  content?: string;
  clientId?: string;
  name?: string;
  cursor?: { anchor: number; head: number };
  clients?: RemoteClient[];
  client?: RemoteClient;
  message?: string;
}

/** 同步层向编辑器发出的事件：与 SyncEvents 同名同义，只把 remoteOp 换成 remoteChange */
export type CrdtEvents = Omit<SyncEvents, 'remoteOp'> & {
  /** 远端操作已应用到本地 CRDT，给出可直接作用于编辑器的变更 */
  remoteChange: (changes: ChangeSpec[], author: string) => void;
};

export class CrdtSyncAdapter {
  private readonly emitter = new Emitter<CrdtEvents>();
  private readonly doc = new CrdtDoc('');
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCursor: { anchor: number; head: number } | null = null;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;

  /** 服务器分配的 clientId（= CRDT 的站点 id），snapshot 之后才有 */
  clientId = '';

  constructor(private readonly options: CrdtSyncOptions) {}

  on<K extends keyof CrdtEvents>(event: K, handler: CrdtEvents[K]): () => void {
    return this.emitter.on(event, handler);
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.typingTimer) clearTimeout(this.typingTimer);
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.send({ type: 'leave', docId: this.options.docId });
    this.ws?.close();
    this.ws = null;
    this.setStatus('disconnected');
  }

  /** 本地替换（编辑器桥调用）：产生操作逐条发出，本地副本即时生效 */
  applyLocalReplace(pos: number, removeCount: number, text: string): void {
    for (const op of this.doc.localReplace(pos, removeCount, text)) {
      this.send({ type: 'op', docId: this.options.docId, op });
    }
  }

  sendCursor(anchor: number, head: number): void {
    this.pendingCursor = { anchor, head };
    if (this.cursorTimer) return;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      if (this.pendingCursor) {
        this.send({ type: 'cursor', docId: this.options.docId, cursor: this.pendingCursor });
        this.pendingCursor = null;
      }
    }, 50);
  }

  sendTyping(): void {
    if (this.typingTimer) return;
    this.typingTimer = setTimeout(() => {
      this.typingTimer = null;
      this.send({ type: 'typing', docId: this.options.docId });
    }, 500);
  }

  /** 已应用的操作数，页脚版本号展示用 */
  get revision(): number {
    return this.doc.opCount;
  }

  /** CRDT 没有状态机，页脚永远显示 Replicated（随到随应用） */
  get stateName(): string {
    return 'Replicated';
  }

  // ------------------------------------------------------------------
  // 连接管理（与 OtSyncAdapter 相同的断线重连模式）
  // ------------------------------------------------------------------

  private open(): void {
    this.setStatus('connecting');
    const ws = new WebSocket(this.options.url);
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus('connected');
      this.send({ type: 'join', docId: this.options.docId, name: this.options.name });
    };
    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data as string) as WireMessage);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus('disconnected');
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.options.reconnectDelayMs ?? 2000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.open();
    }, delay);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emitter.emit('status', status);
  }

  private send(msg: WireMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ------------------------------------------------------------------
  // 消息处理
  // ------------------------------------------------------------------

  private handle(msg: WireMessage): void {
    switch (msg.type) {
      case 'snapshot': {
        this.clientId = msg.clientId ?? '';
        // 以服务器副本为基准整体重建（重连前未确认的本地操作同样会丢，v1 限制）
        this.doc.loadState(msg.crdtState ?? []);
        this.emitter.emit(
          'snapshot',
          msg.content ?? '',
          msg.revision ?? 0,
          { clientId: this.clientId, name: this.options.name },
          msg.clients ?? [],
        );
        break;
      }
      case 'op': {
        const op = msg.op as CrdtOpJson;
        if (!op || typeof op !== 'object' || !op.t) break;
        const idx = this.doc.applyRemote(op);
        if (idx < 0) break; // 重复投递
        if (op.t === 'i') {
          this.emitter.emit('remoteChange', [{ from: this.doc.visibleIndexOf(idx), insert: op.c ?? '' }], msg.author ?? '');
        } else {
          const pos = this.doc.visibleIndexOf(idx);
          this.emitter.emit('remoteChange', [{ from: pos, to: pos + 1 }], msg.author ?? '');
        }
        break;
      }
      case 'cursor':
        if (msg.author && msg.cursor) {
          this.emitter.emit('cursor', { clientId: msg.author, anchor: msg.cursor.anchor, head: msg.cursor.head });
        }
        break;
      case 'typing':
        if (msg.author) this.emitter.emit('typing', msg.author);
        break;
      case 'deleted':
        this.emitter.emit('deleted', msg.docId ?? '');
        break;
      case 'joined':
        if (msg.client) this.emitter.emit('joined', msg.client);
        break;
      case 'left':
        if (msg.clientId) this.emitter.emit('left', msg.clientId);
        break;
      case 'error':
        this.emitter.emit('error', msg.message ?? '未知错误');
        break;
      default:
        break;
    }
  }
}
