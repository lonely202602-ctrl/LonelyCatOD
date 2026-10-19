import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocument } from '../api';
import { AvatarStack, StatusPill, useToast } from '../components/ui';
import { ThemeToggle } from '../theme';
import { useCollabSession } from '../useCollabSession';

/**
 * 编辑页。头部参考 Google Docs / 飞书文档的布局：
 *   ← 返回 | 文档标题 … [连接状态] [在线头像堆叠] [版本号] | 主题切换
 * 下方是一块无边框的书写画布（Notion 式内容优先），CodeMirror 居中排版列。
 */
export function EditorPage({ docId, userName }: { docId: string; userName: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  // onError 必须稳定，否则会话 hook 的 effect 依赖会乱；toast 函数本身是 useCallback 的
  const onError = useCallback((msg: string) => toast(`服务器：${msg}`), [toast]);

  const { status, revision, stateName, online } = useCollabSession(docId, userName, containerRef, onError);
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getDocument(docId)
      .then((d) => alive && setTitle(d?.title ?? '未命名文档'))
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

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-4">
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
          <h1 className="truncate text-sm font-semibold text-text">
            {title ?? <span className="text-muted">加载中…</span>}
          </h1>
          <p className="text-[11px] leading-tight text-muted">
            v{revision} · {stateName}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <StatusPill status={status} />
          {online.length > 0 && <AvatarStack users={online} />}
          <ThemeToggle />
        </div>
      </header>

      <main id="editor-root" ref={containerRef} className="lc-editor min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
