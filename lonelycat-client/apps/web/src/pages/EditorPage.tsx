import { useCallback, useEffect, useRef, useState } from 'react';
import { undo, redo } from '@codemirror/commands';
import type { RemoteClient } from '@lonelycat/sync';
import { getDocument, renameDocument } from '../api';
import { AvatarStack, Button, StatusPill, useToast } from '../components/ui';
import { ReplayPanel } from '../components/ReplayPanel';
import { ThemeToggle, useDesktopChrome } from '../theme';
import { useCollabSession } from '../useCollabSession';

/**
 * 编辑页。头部参考 Google Docs / 飞书文档的布局：
 *   ← 返回 | 文档标题（可点击重命名） … [正在输入] [连接状态] [在线头像堆叠] | 主题切换
 * 底部状态栏：字数/行数/光标 + 撤销重做 + 复制/导出/时光回放。
 * 主体是无边框书写画布（Notion 式内容优先），CodeMirror 居中排版列。
 */
export function EditorPage({ docId, userName }: { docId: string; userName: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const [replayOpen, setReplayOpen] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [engine, setEngine] = useState<'ot' | 'crdt'>('ot');
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');

  const onError = useCallback((msg: string) => toast(`服务器：${msg}`), [toast]);
  const onJoined = useCallback((c: RemoteClient) => toast(`${c.name} 加入了文档`, 'info'), [toast]);
  const onLeft = useCallback((c: RemoteClient) => toast(`${c.name} 离开了文档`, 'info'), [toast]);
  const onDeleted = useCallback(() => {
    toast('文档已被删除', 'info');
    location.hash = '#/';
  }, [toast]);

  // 「正在输入」：clientId -> 最后心跳时间，定时清理超过 2s 没动静的
  const [typingIds, setTypingIds] = useState<Map<string, number>>(new Map());
  const onTyping = useCallback((clientId: string) => {
    setTypingIds((m) => {
      if (m.has(clientId)) m = new Map(m);
      m.set(clientId, Date.now());
      return m;
    });
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      setTypingIds((m) => {
        const next = new Map();
        let changed = false;
        for (const [k, v] of m) {
          if (Date.now() - v < 2000) next.set(k, v);
          else changed = true;
        }
        return changed ? next : m;
      });
    }, 800);
    return () => clearInterval(timer);
  }, []);

  const { status, revision, stateName, online, stats, viewRef } = useCollabSession(
    docId,
    userName,
    containerRef,
    {
      onError,
      onTyping,
      onJoined,
      onLeft,
      onDeleted,
    },
    engine,
  );

  useEffect(() => {
    let alive = true;
    getDocument(docId)
      .then((d) => {
        if (!alive) return;
        setTitle(d?.title ?? '未命名文档');
        setEngine(d?.engine ?? 'ot');
      })
      .catch(() => alive && setTitle('未命名文档'));
    return () => {
      alive = false;
    };
  }, [docId]);

  useEffect(() => {
    document.title = title ? `${title} · LonelyCat` : 'LonelyCat 协同编辑';
    return () => {
      document.title = 'LonelyCat 协同编辑';
    };
  }, [title]);

  const startRename = () => {
    setDraftTitle(title ?? '');
    setEditingTitle(true);
  };
  const saveTitle = () => {
    const t = draftTitle.trim();
    setEditingTitle(false);
    if (!t || t === title) return;
    renameDocument(docId, t)
      .then(() => setTitle(t))
      .catch((e) => toast(`重命名失败：${String(e)}`));
  };

  const copyAll = () => {
    const text = viewRef.current?.state.doc.toString() ?? '';
    copyText(text)
      .then(() => toast(`已复制 ${text.length} 个字符`, 'info'))
      .catch(() => toast('复制失败'));
  };

  const exportTxt = () => {
    const text = viewRef.current?.state.doc.toString() ?? '';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title ?? '文档'}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 .txt', 'info');
  };

  // 「正在输入」的名字（从在线名单里查，查不到显示短 id）
  const typingNames = [...typingIds.keys()].map(
    (id) => online.find((u) => u.clientId === id)?.name.replace('（我）', '') ?? id.slice(0, 6),
  );

  return (
    <div className="flex h-dvh flex-col">
      <header className="lc-titlebar flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-4">
        <a
          href="#/"
          title="返回文档列表"
          className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </a>

        <div className="ml-1 min-w-0">
          {editingTitle ? (
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              className="w-56 rounded-md border border-accent bg-surface px-1.5 py-0.5 text-sm font-semibold text-text outline-none"
            />
          ) : (
            <button
              onClick={startRename}
              title="点击重命名"
              className="group flex max-w-[40vw] items-center gap-1 rounded-md px-1 py-0.5 text-left hover:bg-surface-2"
            >
              <h1 className="truncate text-sm font-semibold text-text">
                {title ?? '加载中…'}
                {engine === 'crdt' && (
                  <span className="ml-2 rounded bg-[#30a46c]/15 px-1.5 py-0.5 align-middle text-[10px] font-bold tracking-wide text-[#30a46c]">
                    CRDT
                  </span>
                )}
              </h1>
              {title && (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              )}
            </button>
          )}
          <p className="text-[11px] leading-tight text-muted">
            v{revision} · {stateName}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-3">
          {typingNames.length > 0 && (
            <span className="lc-fade-up hidden items-center gap-1.5 text-xs text-muted md:flex">
              <span className="flex gap-0.5">
                <span className="size-1 animate-bounce rounded-full bg-accent [animation-delay:0ms]" />
                <span className="size-1 animate-bounce rounded-full bg-accent [animation-delay:150ms]" />
                <span className="size-1 animate-bounce rounded-full bg-accent [animation-delay:300ms]" />
              </span>
              {typingNames.join('、')} 正在输入
            </span>
          )}
          <StatusPill status={status} />
          {online.length > 0 && <AvatarStack users={online} />}
          <ThemeToggle />
        </div>
      </header>

      <main id="editor-root" ref={containerRef} className="lc-editor min-h-0 flex-1 overflow-hidden" />

      <footer className="flex h-9 shrink-0 items-center gap-4 border-t border-line bg-surface px-4 text-xs text-muted">
        <span>
          {stats.chars} 字 · {stats.lines} 行
        </span>
        <span>
          光标 {stats.cursorLine}:{stats.cursorCol}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <FooterButton label="撤销" onClick={() => viewRef.current && undo(viewRef.current)}>
            <UndoIcon />
          </FooterButton>
          <FooterButton label="重做" onClick={() => viewRef.current && redo(viewRef.current)}>
            <RedoIcon />
          </FooterButton>
          <span className="mx-1 h-4 w-px bg-line" />
          <FooterButton label="复制全文" onClick={copyAll}>
            <CopyIcon />
          </FooterButton>
          <FooterButton label="导出 .txt" onClick={exportTxt}>
            <DownloadIcon />
          </FooterButton>
          <span className="mx-1 h-4 w-px bg-line" />
          <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setReplayOpen(true)}>
            🎬 时光回放
          </Button>
        </div>
      </footer>

      {replayOpen && <ReplayPanel docId={docId} onClose={() => setReplayOpen(false)} />}
    </div>
  );
}

/** clipboard API 在非安全上下文（Electron file://）不可用时的兜底 */
function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
    } catch (e) {
      reject(e);
    } finally {
      ta.remove();
    }
  });
}

function FooterButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={label} className="grid size-7 place-items-center rounded-md transition-colors hover:bg-surface-2 hover:text-text">
      {children}
    </button>
  );
}

const UndoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
  </svg>
);

const RedoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 7v6h-6" />
    <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
  </svg>
);

const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </svg>
);
