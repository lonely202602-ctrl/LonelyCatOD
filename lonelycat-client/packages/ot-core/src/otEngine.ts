import { TextOperation, isDelete, isInsert, isRetain, type OpComponent } from './textOperation';

/**
 * OT 的两个核心算法：compose（合并）和 transform（转换）。与后端 Java 的 OtEngine 一一对应。
 *
 * 两个算法骨架相同：两个游标同时遍历两个操作，每一步只消耗「两个当前组件中较短的那一段」，
 * 把长的那个切掉已处理的部分继续比较，像两把尺子并排在文档上对齐推进。
 *
 * 核心性质（测试要验证的）：
 *   compose:   apply(apply(S, a), b)  == apply(S, compose(a, b))
 *   transform: apply(apply(S, a), b') == apply(apply(S, b), a')   其中 [a', b'] = transform(a, b)
 */

/** 可就地修改 current 的游标（retain(5) 用掉 2 之后变成 retain(3)） */
class Cursor {
  private index = 0;
  current: OpComponent | undefined;

  constructor(private readonly ops: readonly OpComponent[]) {
    this.current = ops[0];
  }

  done(): boolean {
    return this.current === undefined;
  }

  next(): void {
    this.index++;
    this.current = this.ops[this.index];
  }
}

/**
 * 把连续的两个操作合并成一个：先做 a 再做 b == 做一次 compose(a, b)。
 * 前提：a.targetLength === b.baseLength。
 *
 * 用途：客户端等待服务器确认期间，用户连续输入的多个操作要攒成一个 buffer，靠它合并。
 */
export function compose(a: TextOperation, b: TextOperation): TextOperation {
  if (a.targetLength !== b.baseLength) {
    throw new Error(`compose 要求 a.targetLength(${a.targetLength}) == b.baseLength(${b.baseLength})`);
  }
  const result = new TextOperation();
  const c1 = new Cursor(a.ops);
  const c2 = new Cursor(b.ops);

  for (;;) {
    if (c1.done() && c2.done()) break;

    // a 里的 delete 删的是原文档，b 看不到，直接照搬
    if (isDelete(c1.current)) {
      result.delete(c1.current);
      c1.next();
      continue;
    }
    // b 里的 insert 是新内容，和 a 无关，直接照搬
    if (isInsert(c2.current)) {
      result.insert(c2.current);
      c2.next();
      continue;
    }
    if (c1.done() || c2.done()) throw new Error('compose：两个操作长度不匹配');

    const op1 = c1.current!;
    const op2 = c2.current!;

    if (isRetain(op1) && isRetain(op2)) {
      if (op1 > op2) {
        result.retain(op2);
        c1.current = op1 - op2;
        c2.next();
      } else if (op1 === op2) {
        result.retain(op1);
        c1.next();
        c2.next();
      } else {
        result.retain(op1);
        c2.current = op2 - op1;
        c1.next();
      }
    } else if (isInsert(op1) && isDelete(op2)) {
      // a 插入的内容又被 b 删掉：互相抵消
      const del = -op2;
      if (op1.length > del) {
        c1.current = op1.slice(del);
        c2.next();
      } else if (op1.length === del) {
        c1.next();
        c2.next();
      } else {
        c2.current = op2 + op1.length;
        c1.next();
      }
    } else if (isInsert(op1) && isRetain(op2)) {
      // a 插入的内容被 b 保留：输出插入
      if (op1.length > op2) {
        result.insert(op1.slice(0, op2));
        c1.current = op1.slice(op2);
        c2.next();
      } else if (op1.length === op2) {
        result.insert(op1);
        c1.next();
        c2.next();
      } else {
        result.insert(op1);
        c2.current = op2 - op1.length;
        c1.next();
      }
    } else if (isRetain(op1) && isDelete(op2)) {
      // a 保留的原文被 b 删掉：输出删除
      const del = -op2;
      if (op1 > del) {
        result.delete(del);
        c1.current = op1 - del;
        c2.next();
      } else if (op1 === del) {
        result.delete(del);
        c1.next();
        c2.next();
      } else {
        result.delete(op1);
        c2.current = op2 + op1;
        c1.next();
      }
    } else {
      throw new Error(`compose：遇到不该出现的组件组合 ${op1} / ${op2}`);
    }
  }
  return result;
}

/**
 * 转换两个并发操作（都基于同一版本，baseLength 相同），返回 [a', b']，满足：
 * 先做 a 再做 b' == 先做 b 再做 a'。
 *
 * 约定（前后端必须一致）：同一位置同时插入时，a 的内容排在 b 前面。
 * 服务器把「刚收到的客户端操作」当 a、历史操作当 b；
 * 客户端把「本地未确认的操作」当 a、服务器广播的操作当 b。
 */
export function transform(a: TextOperation, b: TextOperation): [TextOperation, TextOperation] {
  if (a.baseLength !== b.baseLength) {
    throw new Error(`transform 要求两个操作 baseLength 相同: ${a.baseLength} vs ${b.baseLength}`);
  }
  const aPrime = new TextOperation();
  const bPrime = new TextOperation();
  const c1 = new Cursor(a.ops);
  const c2 = new Cursor(b.ops);

  for (;;) {
    if (c1.done() && c2.done()) break;

    // a 插入：a' 照样插入；b' 要跳过这段新内容
    if (isInsert(c1.current)) {
      aPrime.insert(c1.current);
      bPrime.retain(c1.current.length);
      c1.next();
      continue;
    }
    // b 插入：对称
    if (isInsert(c2.current)) {
      aPrime.retain(c2.current.length);
      bPrime.insert(c2.current);
      c2.next();
      continue;
    }
    if (c1.done() || c2.done()) throw new Error('transform：两个操作长度不匹配');

    const op1 = c1.current as number;
    const op2 = c2.current as number;
    let minLen: number;

    if (isRetain(op1) && isRetain(op2)) {
      // 两边都跳过同一段：a'、b' 也都跳过
      if (op1 > op2) {
        minLen = op2;
        c1.current = op1 - op2;
        c2.next();
      } else if (op1 === op2) {
        minLen = op2;
        c1.next();
        c2.next();
      } else {
        minLen = op1;
        c2.current = op2 - op1;
        c1.next();
      }
      aPrime.retain(minLen);
      bPrime.retain(minLen);
    } else if (isDelete(op1) && isDelete(op2)) {
      // 两边删同一段：删一次就够，a'、b' 都不用再删
      if (-op1 > -op2) {
        c1.current = op1 - op2;
        c2.next();
      } else if (op1 === op2) {
        c1.next();
        c2.next();
      } else {
        c2.current = op2 - op1;
        c1.next();
      }
    } else if (isDelete(op1) && isRetain(op2)) {
      // a 删、b 保留：a' 仍要删；b' 里这段已经不存在
      if (-op1 > op2) {
        minLen = op2;
        c1.current = op1 + op2;
        c2.next();
      } else if (-op1 === op2) {
        minLen = op2;
        c1.next();
        c2.next();
      } else {
        minLen = -op1;
        c2.current = op2 + op1;
        c1.next();
      }
      aPrime.delete(minLen);
    } else if (isRetain(op1) && isDelete(op2)) {
      // 对称：b 删、a 保留
      if (op1 > -op2) {
        minLen = -op2;
        c1.current = op1 + op2;
        c2.next();
      } else if (op1 === -op2) {
        minLen = op1;
        c1.next();
        c2.next();
      } else {
        minLen = op1;
        c2.current = op2 + op1;
        c1.next();
      }
      bPrime.delete(minLen);
    } else {
      throw new Error(`transform：遇到不该出现的组件组合 ${op1} / ${op2}`);
    }
  }
  return [aPrime, bPrime];
}

/**
 * 把光标位置随一个操作做转换：操作在光标前面插入了 n 个字符，光标就后移 n；
 * 删掉了光标前面的字符，光标就前移。用于远端光标显示和本地光标在远端操作后的位置修正。
 *
 * @param isOwn 是否是光标所有者自己的操作。自己的插入光标要跟着往后走（打字），别人的插入在同一位置时光标留在前面。
 *
 * 注意：当前生产路径的远端光标由 CodeMirror 的位置映射（packages/editor 的 remoteCursors.ts）
 * 自动完成，没有用到本函数。它保留在这里有两个用途：测试里验证「光标转换」这一 OT 概念本身；
 * 将来如果把光标协议升级成带 revision 的精确转换（服务端/客户端按版本转换光标），它是现成的备件。
 */
export function transformCursor(position: number, op: TextOperation, isOwn: boolean): number {
  let index = 0; // 原文档游标
  let newPos = position;
  for (const c of op.ops) {
    if (isRetain(c)) {
      index += c;
    } else if (isInsert(c)) {
      if (index < position || (index === position && isOwn)) {
        newPos += c.length;
      }
    } else {
      const del = -c;
      // 删除区间 [index, index+del) 在光标前面的部分，让光标前移
      newPos -= Math.min(del, Math.max(0, position - index));
      index += del;
    }
    if (index > position) break;
  }
  return newPos;
}
