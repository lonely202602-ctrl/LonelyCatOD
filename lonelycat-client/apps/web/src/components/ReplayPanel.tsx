import { useCallback, useEffect, useRef, useState } from 'react';
import { TextOperation } from '@lonelycat/ot-core';
import { CrdtDoc, type CrdtOpJson } from '@lonelycat/crdt-core';
import { getReplayData, type ReplayOp } from '../api';
import { Button, Spinner } from './ui';

/**
 * 时光回放：把操作日志变成可播放的文档演进动画。
 *
 * 帧的推演全部在客户端用 ot-core 完成：
 *   1. 从快照 (baseContent@baseRevision) 正向 apply 快照之后的操作，得到最新内容；
 *   2. 再用 invert 从最新一版倒着撤回到第 0 版，沿途记录每一版。
 * 这是 OT 教学的活教材：invert 的正确性直接决定回放对不对。
 */

export interface ReplayFrame {
  /** 这一帧对应的版本号 */
  rev: number;
  content: string;
  /** 产生这一版的操作作者（clientId）与时间 */
  author?: string;
  time?: string;
  /** 操作的人类可读摘要 */
  summary?: string;
}

function summarize(op: TextOperation): string {
  let pos = 0;
  let inserted = 0;
  let deleted = 0;
  let firstChange = -1;
  for (const c of op.ops) {
    if (typeof c === 'string') {
      inserted += c.length;
      if (firstChange < 0) firstChange = pos;
    } else if (c < 0) {
      deleted += -c;
      if (firstChange < 0) firstChange = pos;
    } else {
      pos += c;
    }
  }
  if (firstChange < 0) return '空操作';
  const parts: string[] = [];
  if (inserted) parts.push(`插入 ${inserted} 字`);
  if (deleted) parts.push(`删除 ${deleted} 字`);
  return `位置 ${firstChange} · ${parts.join('、')}`;
}

/** 快照 + 全量操作日志 → 逐帧内容。见文件头注释 */
export function buildFrames(baseContent: string, baseRevision: number, ops: ReplayOp[]): ReplayFrame[] {
  let doc = baseContent;
  // 正向：从快照推到最新
  for (const o of ops) {
    if (o.revision > baseRevision) {
      doc = TextOperation.fromJSON(o.op as (number | string)[]).apply(doc);
    }
  }
  // 倒向：invert 沿途记录每一版。
  // 每一帧的摘要描述「这一版是怎么来的」：frames[i] 由 ops[i-1] 产生，
  // frames[0] 是初始内容（没有产生它的操作，走兜底文案）。
  const total = ops.length;
  const frames: ReplayFrame[] = new Array(total + 1);
  const last = ops[total - 1];
  frames[total] = {
    rev: total,
    content: doc,
    author: last?.author,
    time: last && new Date(last.createdAt).toLocaleTimeString(),
    summary: last && summarize(TextOperation.fromJSON(last.op as (number | string)[])),
  };
  for (let i = total - 1; i >= 0; i--) {
    const o = ops[i];
    const op = TextOperation.fromJSON(o.op as (number | string)[]);
    doc = op.invert(doc).apply(doc);
    const prev = i > 0 ? ops[i - 1] : undefined;
    frames[i] = {
      rev: o.revision - 1,
      content: doc,
      author: prev?.author,
      time: prev && new Date(prev.createdAt).toLocaleTimeString(),
      summary: prev && summarize(TextOperation.fromJSON(prev.op as (number | string)[])),
    };
  }
  return frames;
}

/** CRDT 文档的帧：按日志顺序把操作灌进一份新副本，每步记下当时的全文 */
export function buildCrdtFrames(ops: ReplayOp[]): ReplayFrame[] {
  const doc = new CrdtDoc('replay');
  const frames: ReplayFrame[] = [{ rev: 0, content: '' }];
  ops.forEach((o, i) => {
    const op = o.op as CrdtOpJson;
    const idx = doc.applyRemote(op);
    let summary: string;
    if (idx < 0) {
      summary = '重复投递（已忽略）';
    } else if (op.t === 'i') {
      summary = `位置 ${doc.visibleIndexOf(idx)} · 插入 ${(op.c ?? '').length} 字`;
    } else {
      summary = `位置 ${doc.visibleIndexOf(idx)} · 删除 1 字`;
    }
    frames.push({
      rev: i + 1,
      content: doc.text,
      author: o.author,
      time: new Date(o.createdAt).toLocaleTimeString(),
      summary,
    });
  });
  return frames;
}

export function ReplayPanel({ docId, onClose }: { docId: string; onClose: () => void }) {
  const [frames, setFrames] = useState<ReplayFrame[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    let alive = true;
    getReplayData(docId)
      .then((data) => {
        if (!alive) return;
        const f =
          data.engine === 'crdt'
            ? buildCrdtFrames(data.operations)
            : buildFrames(data.baseContent, data.baseRevision, data.operations);
        setFrames(f);
        setIndex(0);
        setPlaying(true); // 打开即自动播放：看着文档一步步长出来
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [docId]);

  // 播放循环：每 320ms/speed 前进一步，到头自动停
  useEffect(() => {
    if (!playing || !frames) return;
    const timer = setInterval(() => {
      setIndex((i) => {
        if (i >= frames.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 320 / speed);
    return () => clearInterval(timer);
  }, [playing, speed, frames]);

  const frame = frames?.[index];

  const togglePlay = useCallback(() => {
    if (!frames) return;
    if (!playing && index >= frames.length - 1 && index > 0) setIndex(0); // 播完再按 = 从头放
    setPlaying((p) => !p);
  }, [frames, playing, index]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg/95 backdrop-blur-sm">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-5">
        <span className="text-base">🎬</span>
        <h2 className="text-[15px] font-semibold text-text">时光回放</h2>
        <span className="text-xs text-muted">每一帧 = 一条被服务器接受的操作</span>
        <button
          onClick={onClose}
          className="ml-auto grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
          title="关闭回放"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      {error && <div className="grid flex-1 place-items-center text-sm text-err">加载回放数据失败：{error}</div>}

      {!error && !frames && (
        <div className="grid flex-1 place-items-center gap-3 text-muted">
          <Spinner className="size-6" />
          <span className="text-sm">正在推演每一版内容…</span>
        </div>
      )}

      {frames && (
        <>
          <div className="min-h-0 flex-1 overflow-hidden px-6 py-5">
            <div className="mx-auto h-full max-w-3xl overflow-y-auto rounded-2xl border border-line bg-surface p-8 shadow-card">
              <pre className="h-full whitespace-pre-wrap break-words font-sans text-[15px] leading-relaxed text-text">
                {frame?.content || <span className="text-muted">（空文档）</span>}
              </pre>
            </div>
          </div>

          <footer className="shrink-0 border-t border-line bg-surface px-6 py-4">
            <div className="mx-auto flex max-w-3xl items-center gap-4">
              <Button variant="primary" onClick={togglePlay} className="w-20">
                {playing ? '暂停' : index >= frames.length - 1 && index > 0 ? '重放' : '播放'}
              </Button>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <input
                  type="range"
                  min={0}
                  max={frames.length - 1}
                  value={index}
                  onChange={(e) => {
                    setPlaying(false);
                    setIndex(Number(e.target.value));
                  }}
                  className="w-full accent-[var(--accent)]"
                />
                <div className="flex items-center justify-between gap-4 text-xs text-muted">
                  <span className="truncate">
                    {index === 0
                      ? `第 0 版 · 初始内容（${frames[0].content.length} 字）`
                      : frame?.summary}
                  </span>
                  <span className="shrink-0">
                    第 {index} / {frames.length - 1} 步 · v{frame?.rev}
                    {frame?.author && ` · ${frame.author.slice(0, 8)}`}
                    {frame?.time && ` · ${frame.time}`}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1 text-xs text-muted">
                速度
                {[1, 2, 4].map((s) => (
                  <button
                    key={s}
                    onClick={() => setSpeed(s)}
                    className={`rounded-md px-1.5 py-0.5 transition-colors ${
                      speed === s ? 'bg-accent-soft font-semibold text-accent' : 'hover:bg-surface-2'
                    }`}
                  >
                    {s}×
                  </button>
                ))}
              </div>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
