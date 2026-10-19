import { useCallback, useEffect, useState } from 'react';
import { createDocument, listDocuments, type DocumentSummary } from '../api';
import { Button, Input, Spinner, useToast } from '../components/ui';
import { Logo } from '../components/Logo';
import { ThemeToggle } from '../theme';

/**
 * 文档列表页：顶部导航 + 卡片网格。
 * 设计上参考 Notion 的克制：大量留白、灰度层次、卡片只在 hover 时给反馈。
 */
export function ListPage({ userName, onRename }: { userName: string; onRename: () => void }) {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      setDocs(await listDocuments());
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const doc = await createDocument(title.trim() || '未命名文档');
      location.hash = `#/doc/${doc.id}`;
    } catch (e) {
      toast(`创建失败：${String(e)}`);
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-6">
      <header className="flex h-16 items-center gap-3">
        <Logo />
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onRename}
            className="rounded-lg px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            {userName}
          </button>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex flex-1 flex-col pt-10 pb-16">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-text">文档</h1>
          <p className="mt-1.5 text-sm text-muted">多人实时协同编辑，打开同一篇文档即可一起写字。</p>
        </div>

        <div className="mb-6 flex max-w-md items-center gap-2">
          <Input
            value={title}
            placeholder="新文档标题"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <Button variant="primary" onClick={submit} disabled={submitting}>
            {submitting && <Spinner />}
            新建
          </Button>
        </div>

        {docs === null && !loadError && <SkeletonGrid />}
        {loadError && (
          <div className="rounded-xl border border-line bg-surface p-8 text-center">
            <p className="text-sm text-err">连接后端失败：{loadError}</p>
            <Button className="mt-4" onClick={() => void refresh()}>
              重试
            </Button>
          </div>
        )}
        {docs !== null && !loadError && <DocGrid docs={docs} />}
      </main>
    </div>
  );
}

function DocGrid({ docs }: { docs: DocumentSummary[] }) {
  if (docs.length === 0) return <EmptyState />;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {docs.map((d) => (
        <a
          key={d.id}
          href={`#/doc/${d.id}`}
          className="group rounded-xl border border-line bg-surface p-4 shadow-card transition-all hover:-translate-y-0.5 hover:border-accent/50"
        >
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-2 font-medium text-text group-hover:text-accent">{d.title}</h3>
            <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">v{d.snapshotRevision}</span>
          </div>
          <p className="mt-3 text-xs text-muted">{timeAgo(d.updatedAt)}</p>
        </a>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-line py-20">
      <svg width="72" height="72" viewBox="0 0 32 32" className="opacity-30">
        <path d="M9 6l4 3.4h6L23 6v10a7 7 0 0 1-14 0V6z" className="fill-muted" />
        <circle cx="12.5" cy="14.5" r="1.3" className="fill-bg" />
        <circle cx="19.5" cy="14.5" r="1.3" className="fill-bg" />
        <path d="M14 18.5c.6 1 3.4 1 4 0" stroke="var(--bg)" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      </svg>
      <p className="mt-4 text-sm text-muted">还没有文档，在上面输入标题创建第一篇吧</p>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-[88px] rounded-xl border border-line bg-surface p-4">
          <div className="lc-skeleton h-4 w-3/5 rounded" />
          <div className="lc-skeleton mt-4 h-3 w-1/4 rounded" />
        </div>
      ))}
    </div>
  );
}

/** 相对时间：「刚刚 / 5 分钟前 / 昨天」 */
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚更新';
  if (min < 60) return `${min} 分钟前更新`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前更新`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天更新';
  if (day < 30) return `${day} 天前更新`;
  return new Date(iso).toLocaleDateString();
}
