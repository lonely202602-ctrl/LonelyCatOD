import { TextOperation, compose, transform } from '@lonelycat/ot-core';

/**
 * OT 客户端状态机（沿用 ot.js 的三状态设计）。这个类不碰网络，只负责决定：
 *   - 本地操作什么时候发给服务器
 *   - 服务器广播来的操作要怎样转换才能应用到本地编辑器
 *
 * 三个状态：
 *   Synchronized          本地没有待确认的操作。用户一编辑就立刻发出去。
 *   AwaitingConfirm       发出去一个操作（outstanding）在等 ack。期间的本地编辑不发，攒进 buffer。
 *   AwaitingWithBuffer    既有 outstanding 又有 buffer。收到 ack 后把 buffer 发出去，回到 AwaitingConfirm。
 *
 * 关键约束：同一时刻最多只有一个操作在途。这样服务器端只需要记住「每个操作基于哪个版本」，
 * 客户端收到远端操作时也只需要和 outstanding、buffer 这两个操作做转换。
 *
 * 服务器承诺：同一文档的操作按接受的顺序串行处理，每个客户端收到的消息（自己的 ack、
 * 别人的 op 广播）revision 严格按 1, 2, 3… 连续递增——自己的操作以 ack 出现，别人的以
 * op 出现，每个 revision 恰好一条消息。客户端不盲信这个承诺，而是按消息里的 revision
 * 校验：落后的丢弃（重复投递），超前的先缓冲、等中间版本补齐后按序处理。
 */

/** 状态机需要外界提供的两个动作 */
export interface OtClientTransport {
  /** 把操作发给服务器，revision 是它所基于的版本号 */
  sendOperation(revision: number, op: TextOperation): void;
  /** 把（已转换好的）远端操作应用到本地编辑器 */
  applyOperation(op: TextOperation): void;
}

/** 一条按 revision 排队的远端消息：广播来的别人的操作，或者自己操作的 ack */
type PendingRemote = { kind: 'op'; op: TextOperation } | { kind: 'ack' };

export class OtClient {
  /** 本地已经确认同步到的服务器版本号 */
  revision: number;
  state: ClientState = synchronizedState;

  /** 已收到但还不能处理的远端消息：revision -> 消息。等中间版本补齐后按序放行 */
  private pending = new Map<number, PendingRemote>();

  constructor(revision: number, private readonly transport: OtClientTransport) {
    this.revision = revision;
  }

  /** 用户在本地做了一个编辑 */
  applyClient(op: TextOperation): void {
    this.state = this.state.applyClient(this, op);
  }

  /**
   * 服务器广播来了别人的操作，revision 是它在服务器上成为的版本号。
   * 状态机的三个 applyServer 都假设操作恰好基于 this.revision，所以这里先把
   * 乱序/重复的消息挡住，保证进状态机的消息永远合法。
   */
  applyServer(revision: number, op: TextOperation): void {
    this.receiveRemote(revision, { kind: 'op', op });
  }

  /** 服务器确认了我们的 outstanding 操作，revision 是它成为的版本号 */
  serverAck(revision: number): void {
    this.receiveRemote(revision, { kind: 'ack' });
  }

  /** 重连或重新 join 后重置（本地未确认的操作会丢失，第一版接受这个限制） */
  reset(revision: number): void {
    this.revision = revision;
    this.state = synchronizedState;
    this.pending.clear();
  }

  /** 把本地光标位置转换到「服务器视角」不需要；但把远端光标转换到「本地视角」要考虑未确认操作 */
  get stateName(): 'Synchronized' | 'AwaitingConfirm' | 'AwaitingWithBuffer' {
    return this.state.name;
  }

  /**
   * 统一的远端消息入口。ack 和 op 构成一条按 revision 连续递增的消息流，
   * 只有 revision 恰好是「下一个」的消息才交给状态机。
   */
  private receiveRemote(revision: number, event: PendingRemote): void {
    if (revision <= this.revision) {
      return; // 重复或过期的消息，直接丢弃
    }
    if (revision > this.revision + 1) {
      this.pending.set(revision, event); // 中间版本还没到，先缓冲
      return;
    }
    this.acceptRemote(event);
    this.drainPending();
  }

  private acceptRemote(event: PendingRemote): void {
    this.revision++;
    this.state =
      event.kind === 'op' ? this.state.applyServer(this, event.op) : this.state.serverAck(this);
  }

  /** 缓冲区里可能正好排着下一个版本，逐个放行直到断档 */
  private drainPending(): void {
    for (;;) {
      const next = this.pending.get(this.revision + 1);
      if (!next) return;
      this.pending.delete(this.revision + 1);
      this.acceptRemote(next);
    }
  }

  // 供状态对象调用
  sendOperation(revision: number, op: TextOperation): void {
    this.transport.sendOperation(revision, op);
  }

  applyOperation(op: TextOperation): void {
    this.transport.applyOperation(op);
  }
}

// ----------------------------------------------------------------------
// 三个状态
// ----------------------------------------------------------------------

export interface ClientState {
  readonly name: 'Synchronized' | 'AwaitingConfirm' | 'AwaitingWithBuffer';
  applyClient(client: OtClient, op: TextOperation): ClientState;
  applyServer(client: OtClient, op: TextOperation): ClientState;
  serverAck(client: OtClient): ClientState;
}

/** 没有在途操作 */
const synchronizedState: ClientState = {
  name: 'Synchronized',

  applyClient(client, op) {
    // 直接发出去，进入等待确认
    client.sendOperation(client.revision, op);
    return new AwaitingConfirm(op);
  },

  applyServer(client, op) {
    // 本地没有未确认的改动，远端操作原样应用
    client.applyOperation(op);
    return this;
  },

  serverAck() {
    throw new Error('Synchronized 状态下收到了多余的 ack');
  },
};

/** 有一个 outstanding 操作在等 ack */
class AwaitingConfirm implements ClientState {
  readonly name = 'AwaitingConfirm' as const;

  constructor(readonly outstanding: TextOperation) {}

  applyClient(_client: OtClient, op: TextOperation): ClientState {
    // 不能再发，先攒着
    return new AwaitingWithBuffer(this.outstanding, op);
  }

  applyServer(client: OtClient, op: TextOperation): ClientState {
    //                 outstanding
    //   服务器版本 ------------> 本地（含未确认）
    //      |                       |
    //   op |                       | op'
    //      v                       v
    //   新服务器版本 ----------> 新本地
    //                outstanding'
    //
    // 收到的 op 是基于「服务器版本」的，本地文档比服务器多了 outstanding，
    // 所以要把 op 转换成 op' 才能应用到本地；同时 outstanding 也要转换成 outstanding'，
    // 因为等它被服务器接受时，服务器会做同样的转换。
    // 参数顺序：本地未确认的操作放第一个（和服务器端把「新到操作」放第一个的约定对应）。
    const [outstandingPrime, opPrime] = transform(this.outstanding, op);
    client.applyOperation(opPrime);
    return new AwaitingConfirm(outstandingPrime);
  }

  serverAck(): ClientState {
    return synchronizedState;
  }
}

/** 有 outstanding 在等 ack，同时 buffer 里攒着后续编辑 */
class AwaitingWithBuffer implements ClientState {
  readonly name = 'AwaitingWithBuffer' as const;

  constructor(
    readonly outstanding: TextOperation,
    readonly buffer: TextOperation,
  ) {}

  applyClient(_client: OtClient, op: TextOperation): ClientState {
    // 新编辑合并进 buffer：buffer 是作用在 outstanding 之后的，op 是作用在 buffer 之后的
    return new AwaitingWithBuffer(this.outstanding, compose(this.buffer, op));
  }

  applyServer(client: OtClient, op: TextOperation): ClientState {
    //                 outstanding              buffer
    //   服务器版本 ------------> 中间状态 ------------> 本地
    //      |                        |                     |
    //   op |                    op' |                     | op''
    //      v                        v                     v
    //   新服务器版本 ----------> 新中间状态 ----------> 新本地
    //               outstanding'             buffer'
    //
    // 两步转换：先过 outstanding，再过 buffer
    const [outstandingPrime, opPrime] = transform(this.outstanding, op);
    const [bufferPrime, opDoublePrime] = transform(this.buffer, opPrime);
    client.applyOperation(opDoublePrime);
    return new AwaitingWithBuffer(outstandingPrime, bufferPrime);
  }

  serverAck(client: OtClient): ClientState {
    // outstanding 已确认，轮到 buffer 上场
    client.sendOperation(client.revision, this.buffer);
    return new AwaitingConfirm(this.buffer);
  }
}
