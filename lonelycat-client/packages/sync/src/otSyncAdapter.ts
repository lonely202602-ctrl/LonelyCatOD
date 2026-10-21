import { TextOperation, type OpComponent } from '@lonelycat/ot-core';
import { OtClient } from './otClient';
import { Emitter, type ConnectionStatus, type RemoteClient, type SyncAdapter, type SyncEvents } from './syncAdapter';

/**
 * 基于 OT + WebSocket 的同步适配器。负责：
 *   - 维护 WebSocket 连接（断线自动重连、重连后重新 join 拉全量）
 *   - 把网络消息喂给 OtClient 状态机，把状态机的输出翻译成事件/消息
 *   - 光标广播节流
 *
 * 协议见后端 lonelycat-server 的 protocol/Message.java。
 */

export interface OtSyncOptions {
  /** WebSocket 地址，例如 ws://localhost:9090/ws */
  url: string;
  docId: string;
  /** 显示名 */
  name: string;
  /** 重连间隔（毫秒） */
  reconnectDelayMs?: number;
}

/** 后端 Message 的 TS 形状 */
interface WireMessage {
  type: string;
  docId?: string;
  revision?: number;
  op?: OpComponent[];
  author?: string;
  content?: string;
  clientId?: string;
  name?: string;
  cursor?: { anchor: number; head: number };
  clients?: RemoteClient[];
  client?: RemoteClient;
  message?: string;
}

export class OtSyncAdapter implements SyncAdapter {
  private readonly emitter = new Emitter<SyncEvents>();
  private ws: WebSocket | null = null;
  private client: OtClient;
  private status: ConnectionStatus = 'disconnected';
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCursor: { anchor: number; head: number } | null = null;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;

  /** 服务器分配的 clientId，snapshot 之后才有 */
  clientId = '';

  constructor(private readonly options: OtSyncOptions) {
    this.client = new OtClient(0, {
      sendOperation: (revision, op) => this.send({ type: 'op', docId: options.docId, revision, op: op.toJSON() }),
      applyOperation: (op) => this.emitter.emit('remoteOp', op, this.currentAuthor),
    });
  }

  /** 正在处理的远端消息的作者，applyOperation 回调时带给编辑器 */
  private currentAuthor = '';

  // ------------------------------------------------------------------
  // SyncAdapter 实现
  // ------------------------------------------------------------------

  on<K extends keyof SyncEvents>(event: K, handler: SyncEvents[K]): () => void {
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

  applyLocal(op: TextOperation): void {
    if (op.isNoop()) return;
    this.client.applyClient(op);
  }

  sendCursor(anchor: number, head: number): void {
    // 节流：光标移动非常频繁，50ms 内只发最后一次
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
    // 节流：连续打字期间每 500ms 最多发一次心跳
    if (this.typingTimer) return;
    this.typingTimer = setTimeout(() => {
      this.typingTimer = null;
      this.send({ type: 'typing', docId: this.options.docId });
    }, 500);
  }

  get revision(): number {
    return this.client.revision;
  }

  get stateName(): string {
    return this.client.stateName;
  }

  // ------------------------------------------------------------------
  // 连接管理
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
      if (this.ws !== ws) return; // 已经被新的连接替换
      this.ws = null;
      this.setStatus('disconnected');
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose 紧接着会触发，重连逻辑放在那里
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
        // 重置状态机：以服务器版本为准。重连前未确认的本地操作在这里会丢失（v1 限制）
        this.clientId = msg.clientId ?? '';
        this.client.reset(msg.revision ?? 0);
        this.emitter.emit(
          'snapshot',
          msg.content ?? '',
          msg.revision ?? 0,
          { clientId: this.clientId, name: this.options.name },
          msg.clients ?? [],
        );
        break;
      }
      case 'ack': {
        if (typeof msg.revision !== 'number') {
          console.error('ack 消息缺少 revision，已忽略', msg);
          break;
        }
        this.client.serverAck(msg.revision);
        break;
      }
      case 'op': {
        this.currentAuthor = msg.author ?? '';
        if (typeof msg.revision !== 'number') {
          // 协议要求 op 必须带 revision，缺了没法做乱序校验，只能丢弃
          console.error('op 消息缺少 revision，已忽略', msg);
          break;
        }
        this.client.applyServer(msg.revision, TextOperation.fromJSON(msg.op ?? []));
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
        // 服务器拒绝了我们的操作，本地状态可能已经和服务器不一致，重新 join 拉全量恢复
        this.send({ type: 'join', docId: this.options.docId, name: this.options.name });
        break;
      default:
        break;
    }
  }
}
