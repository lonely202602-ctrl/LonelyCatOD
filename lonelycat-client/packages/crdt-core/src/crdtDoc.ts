/**
 * RGA（Replicated Growable Array）文本 CRDT——教学版，与后端 Java CrdtDoc 逐字段对应。
 *
 * 每个字符一张全时空唯一的「身份证」[siteId, clock]；插入声明 origin（插入时的左邻居），
 * 删除按身份证打墓碑。任何副本只要收齐相同的操作集合，不管到达顺序如何，都摆出同一个序列。
 * 并发插在同一位置时的定序规则：新条目从 origin 之后开始，
 * 跳过所有「身份证更大」的条目再落座（纯 ID 降序，跨源链式插入才收敛）。
 */

/** 字符身份证：[站点 id, 站点内逻辑时钟] */
export type OpId = [site: string, clock: number];

/** 线路格式的操作：插入 {t:'i'} / 删除 {t:'d'}。origin 用空数组或 null 表示"插在最前面" */
export interface CrdtOpJson {
  t: 'i' | 'd';
  id: OpId;
  o?: OpId | [] | null;
  c?: string;
}

interface Entry {
  id: OpId;
  origin: OpId | null;
  ch: string;
  deleted: boolean;
}

function cmpId(a: OpId, b: OpId): number {
  return a[1] !== b[1] ? a[1] - b[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

export class CrdtDoc {
  private entries: Entry[] = [];
  private clock = 0;
  /** 已应用的操作数（插入+删除），页脚的版本号展示用它 */
  opCount = 0;

  constructor(public readonly siteId: string) {}

  /**
   * 本地替换：删掉可见位置 pos 起的 removeCount 个字符，再插入 text。
   * 返回产生的操作（线路格式，按产生顺序）。连续删除位置不前移；连续插入后一个字符
   * 的 origin 是前一个字符的身份证。按码点（而不是 UTF-16 编码单元）逐字符建条目。
   */
  localReplace(pos: number, removeCount: number, text: string): CrdtOpJson[] {
    const ops: CrdtOpJson[] = [];
    for (let k = 0; k < removeCount; k++) {
      const ei = this.entryAtVisible(pos);
      if (ei >= this.entries.length) break;
      const victim = this.entries[ei];
      victim.deleted = true;
      this.opCount++;
      ops.push({ t: 'd', id: victim.id });
    }
    let origin: OpId | null = pos === 0 ? null : this.entries[this.entryAtVisible(pos - 1)].id;
    for (const ch of Array.from(text)) {
      this.clock++;
      const id: OpId = [this.siteId, this.clock];
      this.applyInsert(id, origin, ch);
      ops.push({ t: 'i', id, o: origin ?? [], c: ch });
      origin = id;
    }
    return ops;
  }

  /** 应用远端操作，返回受影响条目的下标；重复投递返回 -1 */
  applyRemote(op: CrdtOpJson): number {
    return op.t === 'i' ? this.applyInsert(op.id, this.originOf(op), op.c ?? '') : this.applyDelete(op.id);
  }

  private applyInsert(id: OpId, origin: OpId | null, ch: string): number {
    if (this.indexOfId(id) >= 0) return -1;
    this.clock = Math.max(this.clock, id[1]);
    // RGA 定序：从 origin 之后开始，跳过所有「身份证比自己大」的条目再落座。
    // 注意不看 origin 是否相同——纯 ID 降序才能保证跨源链式插入也收敛（教学版最容易踩的坑）。
    let i = origin === null ? 0 : this.indexOfId(origin) + 1;
    while (i < this.entries.length && cmpId(this.entries[i].id, id) > 0) i++;
    this.entries.splice(i, 0, { id, origin, ch, deleted: false });
    this.opCount++;
    return i;
  }

  private applyDelete(id: OpId): number {
    const i = this.indexOfId(id);
    if (i < 0 || this.entries[i].deleted) return -1;
    this.entries[i].deleted = true;
    this.opCount++;
    return i;
  }

  get length(): number {
    return this.entries.reduce((n, e) => n + (e.deleted ? 0 : 1), 0);
  }

  get text(): string {
    return this.entries.filter((e) => !e.deleted).map((e) => e.ch).join('');
  }

  get entriesSnapshot(): readonly Entry[] {
    return this.entries;
  }

  /** 可见位置 -> 条目下标；pos === length 时返回 entries.length */
  entryAtVisible(pos: number): number {
    if (pos < 0 || pos > this.length) throw new Error(`可见位置越界: ${pos}`);
    let visible = 0;
    for (let i = 0; i < this.entries.length; i++) {
      if (!this.entries[i].deleted) {
        if (visible === pos) return i;
        visible++;
      }
    }
    return this.entries.length;
  }

  /** 条目下标 -> 可见位置（不含自己） */
  visibleIndexOf(entryIdx: number): number {
    let visible = 0;
    for (let i = 0; i < entryIdx; i++) {
      if (!this.entries[i].deleted) visible++;
    }
    return visible;
  }

  /** 全量副本状态：[[id, origin|null, ch, deleted], ...]，随 snapshot 发给新成员 */
  stateToJson(): unknown[] {
    return this.entries.map((e) => [e.id, e.origin, e.ch, e.deleted]);
  }

  loadState(state: unknown[]): void {
    this.entries = [];
    for (const row of state) {
      const [id, origin, ch, deleted] = row as [OpId, OpId | null, string, boolean];
      this.entries.push({ id, origin: origin ?? null, ch, deleted });
      this.clock = Math.max(this.clock, id[1]);
    }
  }

  private originOf(op: CrdtOpJson): OpId | null {
    const o = op.o;
    return o && o.length > 0 ? (o as OpId) : null;
  }

  private indexOfId(id: OpId): number {
    return this.entries.findIndex((e) => e.id[0] === id[0] && e.id[1] === id[1]);
  }
}
