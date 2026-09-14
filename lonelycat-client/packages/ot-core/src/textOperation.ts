/**
 * 文本操作（OT 的基本单位）。与后端 Java 的 TextOperation 一一对应。
 *
 * 一个操作描述「如何把长度为 baseLength 的文档变成长度为 targetLength 的文档」，
 * 由一串组件按顺序组成，从文档开头走到结尾：
 *   retain(n)   跳过 n 个字符
 *   insert(s)   在当前位置插入字符串 s
 *   delete(n)   删除当前位置之后的 n 个字符
 *
 * 紧凑表示（也是网络协议格式）：正整数 = retain，负整数 = delete，字符串 = insert。
 *   文档 "chat" 删掉 h：      [1, -1, 2]
 *   文档 "chat" 末尾加 s：    [4, "s"]
 *
 * 构造时会合并相邻同类组件，并保证 insert 排在紧邻的 delete 前面（规范形式），
 * 这样同一语义的操作只有唯一表示。
 */
export type OpComponent = number | string;

export const isRetain = (op: OpComponent | undefined): op is number =>
  typeof op === 'number' && op > 0;
export const isDelete = (op: OpComponent | undefined): op is number =>
  typeof op === 'number' && op < 0;
export const isInsert = (op: OpComponent | undefined): op is string =>
  typeof op === 'string';

export class TextOperation {
  /** 组件列表 */
  readonly ops: OpComponent[] = [];
  /** 操作应用前的文档长度 */
  baseLength = 0;
  /** 操作应用后的文档长度 */
  targetLength = 0;

  // ------------------------------------------------------------------
  // 构建（链式调用）
  // ------------------------------------------------------------------

  retain(n: number): this {
    if (n < 0) throw new Error(`retain 的长度不能为负数: ${n}`);
    if (n === 0) return this;
    this.baseLength += n;
    this.targetLength += n;
    const last = this.ops[this.ops.length - 1];
    if (isRetain(last)) {
      this.ops[this.ops.length - 1] = last + n;
    } else {
      this.ops.push(n);
    }
    return this;
  }

  insert(str: string): this {
    if (str === '') return this;
    this.targetLength += str.length;
    const ops = this.ops;
    const last = ops[ops.length - 1];
    if (isInsert(last)) {
      ops[ops.length - 1] = last + str;
    } else if (isDelete(last)) {
      // 规范形式：insert 放在 delete 前面
      const secondLast = ops[ops.length - 2];
      if (isInsert(secondLast)) {
        ops[ops.length - 2] = secondLast + str;
      } else {
        ops.splice(ops.length - 1, 0, str);
      }
    } else {
      ops.push(str);
    }
    return this;
  }

  delete(n: number): this {
    if (n === 0) return this;
    if (n > 0) n = -n;
    this.baseLength -= n;
    const last = this.ops[this.ops.length - 1];
    if (isDelete(last)) {
      this.ops[this.ops.length - 1] = last + n;
    } else {
      this.ops.push(n);
    }
    return this;
  }

  /** 是否是「什么都不改」的空操作 */
  isNoop(): boolean {
    return this.ops.length === 0 || (this.ops.length === 1 && isRetain(this.ops[0]));
  }

  // ------------------------------------------------------------------
  // 应用 / 反转
  // ------------------------------------------------------------------

  apply(doc: string): string {
    if (doc.length !== this.baseLength) {
      throw new Error(`操作的 baseLength(${this.baseLength}) 与文档长度(${doc.length}) 不一致`);
    }
    const parts: string[] = [];
    let index = 0;
    for (const op of this.ops) {
      if (isRetain(op)) {
        parts.push(doc.slice(index, index + op));
        index += op;
      } else if (isInsert(op)) {
        parts.push(op);
      } else {
        index -= op; // op 是负数
      }
    }
    if (index !== doc.length) throw new Error('操作没有覆盖整个文档');
    return parts.join('');
  }

  /** 反向操作（撤销用）。需要应用前的文档，因为 delete 不记录被删内容 */
  invert(doc: string): TextOperation {
    const inverse = new TextOperation();
    let index = 0;
    for (const op of this.ops) {
      if (isRetain(op)) {
        inverse.retain(op);
        index += op;
      } else if (isInsert(op)) {
        inverse.delete(op.length);
      } else {
        inverse.insert(doc.slice(index, index - op));
        index -= op;
      }
    }
    return inverse;
  }

  // ------------------------------------------------------------------
  // JSON
  // ------------------------------------------------------------------

  toJSON(): OpComponent[] {
    return [...this.ops];
  }

  static fromJSON(json: OpComponent[]): TextOperation {
    const op = new TextOperation();
    for (const item of json) {
      if (typeof item === 'string') op.insert(item);
      else if (item > 0) op.retain(item);
      else if (item < 0) op.delete(item);
      else throw new Error('操作组件不能是 0');
    }
    return op;
  }

  equals(other: TextOperation): boolean {
    return (
      this.baseLength === other.baseLength &&
      this.targetLength === other.targetLength &&
      this.ops.length === other.ops.length &&
      this.ops.every((op, i) => op === other.ops[i])
    );
  }

  toString(): string {
    return this.ops
      .map((op) =>
        isRetain(op) ? `retain ${op}` : isInsert(op) ? `insert '${op}'` : `delete ${-op}`,
      )
      .join(', ');
  }
}
