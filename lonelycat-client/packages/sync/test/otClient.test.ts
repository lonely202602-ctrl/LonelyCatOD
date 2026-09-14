import { describe, expect, it } from 'vitest';
import { TextOperation, transform } from '@lonelycat/ot-core';
import { OtClient } from '../src/otClient';

/**
 * 端到端模拟：一个内存里的「服务器」+ 若干 OtClient，把网络换成手动投递的消息队列，
 * 验证在各种交错顺序下所有客户端最终内容一致。
 *
 * 这里的 FakeServer 逻辑和后端 DocumentSession.receive 完全一样。
 */

class FakeServer {
  content: string;
  revision = 0;
  history: TextOperation[] = [];

  constructor(initial: string) {
    this.content = initial;
  }

  receive(op: TextOperation, baseRev: number): TextOperation {
    let transformed = op;
    for (let r = baseRev; r < this.revision; r++) {
      transformed = transform(transformed, this.history[r])[0];
    }
    this.content = transformed.apply(this.content);
    this.history.push(transformed);
    this.revision++;
    return transformed;
  }
}

/** 模拟一个客户端：编辑器内容 + 状态机 + 收发队列 */
class FakeClient {
  content: string;
  client: OtClient;
  /** 发往服务器、尚未投递的消息 */
  outbox: { revision: number; op: TextOperation }[] = [];
  /** 服务器发来的、尚未处理的消息 */
  inbox: ({ kind: 'ack' } | { kind: 'op'; op: TextOperation })[] = [];

  constructor(readonly id: string, initial: string, revision: number) {
    this.content = initial;
    this.client = new OtClient(revision, {
      sendOperation: (revision, op) => this.outbox.push({ revision, op }),
      applyOperation: (op) => {
        this.content = op.apply(this.content);
      },
    });
  }

  /** 用户在本地编辑 */
  edit(op: TextOperation): void {
    this.content = op.apply(this.content);
    this.client.applyClient(op);
  }

  /** 处理 inbox 里的一条消息 */
  receiveOne(): boolean {
    const msg = this.inbox.shift();
    if (!msg) return false;
    if (msg.kind === 'ack') this.client.serverAck();
    else this.client.applyServer(msg.op);
    return true;
  }
}

/** 把某个客户端 outbox 的第一条投递给服务器，并把结果分发到各客户端 inbox */
function deliverToServer(server: FakeServer, from: FakeClient, all: FakeClient[]): boolean {
  const msg = from.outbox.shift();
  if (!msg) return false;
  const applied = server.receive(msg.op, msg.revision);
  for (const c of all) {
    if (c === from) c.inbox.push({ kind: 'ack' });
    else c.inbox.push({ kind: 'op', op: applied });
  }
  return true;
}

/** 把所有在途消息按顺序全部投递完 */
function settle(server: FakeServer, all: FakeClient[]): void {
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const c of all) {
      while (deliverToServer(server, c, all)) progressed = true;
    }
    for (const c of all) {
      while (c.receiveOne()) progressed = true;
    }
  }
}

describe('OtClient 状态机', () => {
  it('经典例子：A 删 h，B 加 s，两边收敛到 cats', () => {
    const server = new FakeServer('chat');
    const a = new FakeClient('A', 'chat', 0);
    const b = new FakeClient('B', 'chat', 0);

    a.edit(new TextOperation().retain(1).delete(1).retain(2)); // cat
    b.edit(new TextOperation().retain(4).insert('s')); // chats
    expect(a.client.stateName).toBe('AwaitingConfirm');

    settle(server, [a, b]);

    expect(server.content).toBe('cats');
    expect(a.content).toBe('cats');
    expect(b.content).toBe('cats');
    expect(a.client.stateName).toBe('Synchronized');
    expect(b.client.stateName).toBe('Synchronized');
    expect(a.client.revision).toBe(2);
    expect(b.client.revision).toBe(2);
  });

  it('等待 ack 期间连续输入会进入 buffer，并在 ack 后一次性发出', () => {
    const server = new FakeServer('');
    const a = new FakeClient('A', '', 0);
    const b = new FakeClient('B', '', 0);

    a.edit(new TextOperation().insert('h'));
    expect(a.client.stateName).toBe('AwaitingConfirm');
    a.edit(new TextOperation().retain(1).insert('e'));
    a.edit(new TextOperation().retain(2).insert('y'));
    expect(a.client.stateName).toBe('AwaitingWithBuffer');
    expect(a.outbox.length).toBe(1); // 只有第一个操作发出去了

    settle(server, [a, b]);
    expect(server.content).toBe('hey');
    expect(b.content).toBe('hey');
    expect(server.history.length).toBe(2); // h 和 合并后的 ey
  });

  it('在途操作和远端操作交错时仍然收敛', () => {
    const server = new FakeServer('hello world');
    const a = new FakeClient('A', 'hello world', 0);
    const b = new FakeClient('B', 'hello world', 0);

    // A 在开头插入，B 在末尾插入；A 的先到服务器
    a.edit(new TextOperation().insert('>> ').retain(11));
    b.edit(new TextOperation().retain(11).insert(' <<'));
    deliverToServer(server, a, [a, b]);

    // B 在收到 A 的操作之前又编辑了一次（进入 buffer）
    b.edit(new TextOperation().retain(5).delete(1).insert('_').retain(8));
    b.receiveOne(); // 收到 A 的操作，要和 outstanding、buffer 都做转换
    expect(b.content).toBe('>> hello_world <<');

    settle(server, [a, b]);
    expect(server.content).toBe('>> hello_world <<');
    expect(a.content).toBe(server.content);
    expect(b.content).toBe(server.content);
  });

  it('三个客户端随机编辑、随机投递顺序，最终全部一致', () => {
    // 固定种子的伪随机
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const randomOp = (doc: string): TextOperation => {
      const op = new TextOperation();
      const pos = rand(doc.length + 1);
      op.retain(pos);
      if (rand(2) === 0 || pos === doc.length) {
        op.insert(String.fromCharCode(97 + rand(26)));
        op.retain(doc.length - pos);
      } else {
        const del = 1 + rand(Math.min(3, doc.length - pos));
        op.delete(del);
        op.retain(doc.length - pos - del);
      }
      return op;
    };

    for (let round = 0; round < 50; round++) {
      const server = new FakeServer('abc');
      const clients = ['A', 'B', 'C'].map((id) => new FakeClient(id, 'abc', 0));

      for (let step = 0; step < 40; step++) {
        const action = rand(3);
        const c = clients[rand(clients.length)];
        if (action === 0) c.edit(randomOp(c.content));
        else if (action === 1) deliverToServer(server, c, clients);
        else c.receiveOne();
      }
      settle(server, clients);

      for (const c of clients) {
        expect(c.content).toBe(server.content);
        expect(c.client.stateName).toBe('Synchronized');
      }
    }
  });
});
