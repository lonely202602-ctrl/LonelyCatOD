import { useCallback, useEffect, useMemo, useState } from 'react';
import { createDocument, deleteDocument, listDocuments, renameDocument, type DocumentSummary } from '../api';
import { Button, Input, Modal, Spinner, useToast } from '../components/ui';
import { Logo } from '../components/Logo';
import { ThemeToggle, useDesktopChrome } from '../theme';

/**
 * 文档列表页：顶部导航 + 卡片网格。
 * 设计上参考 Notion 的克制：大量留白、灰度层次、卡片只在 hover 时给反馈。
 * 支持标题搜索过滤；卡片悬停出现重命名/删除操作。
 */
export function ListPage({ userName, onRename }: { userName: string; onRename: () => void }) {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [engine, setEngine] = useState<'ot' | 'crdt'>('ot');
  const [submitting, setSubmitting] = useState(false);
  const [keyword, setKeyword] = useState('');
  /** 正在重命名 / 正在确认删除的文档 */
  const [renaming, setRenaming] = useState<DocumentSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleting, setDeleting] = useState<DocumentSummary | null>(null);
  const toast = useToast();
  useDesktopChrome('list');

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
      const doc = await createDocument(title.trim() || '未命名文档', engine);
      location.hash = `#/doc/${doc.id}`;
    } catch (e) {
      toast(`创建失败：${String(e)}`);
      setSubmitting(false);
    }
  };

  const confirmRename = async () => {
    if (!renaming) return;
    const t = renameDraft.trim();
    if (!t) return;
    try {
      await renameDocument(renaming.id, t);
      setDocs((list) => (list ? list.map((d) => (d.id === renaming.id ? { ...d, title: t } : d)) : list));
      setRenaming(null);
    } catch (e) {
      toast(`重命名失败：${String(e)}`);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteDocument(deleting.id);
      setDocs((list) => (list ? list.filter((d) => d.id !== deleting.id) : list));
      toast(`已删除「${deleting.title}」`, 'info');
      setDeleting(null);
    } catch (e) {
      toast(`删除失败：${String(e)}`);
    }
  };

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!docs) return null;
    return kw ? docs.filter((d) => d.title.toLowerCase().includes(kw)) : docs;
  }, [docs, keyword]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-6">
      <header className="lc-titlebar flex h-16 shrink-0 items-center gap-3">
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

        <div className="mb-6 flex max-w-lg items-center gap-2">
          <Input
            value={title}
            placeholder="新文档标题"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          {/* 引擎选择：同一套 UI，两种同步算法 */}
          <div className="flex shrink-0 rounded-lg border border-line p-0.5" role="radiogroup" aria-label="同步引擎">
            {(
              [
                ['ot', 'OT'],
                ['crdt', 'CRDT'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                role="radio"
                aria-checked={engine === value}
                title={
                  value === 'ot'
                    ? 'OT：服务器 transform + 串行定序（经典 Jupiter 架构）'
                    : 'CRDT：每个字符一张身份证，无需定序（RGA）'
                }
                onClick={() => setEngine(value)}
                className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  engine === value ? 'bg-accent-soft text-accent' : 'text-muted hover:text-text'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <Button variant="primary" onClick={submit} disabled={submitting}>
            {submitting && <Spinner />}
            新建
          </Button>
        </div>

        {docs !== null && docs.length > 0 && (
          <div className="relative mb-4 max-w-xs">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <Input
              value={keyword}
              placeholder="搜索文档…"
              onChange={(e) => setKeyword(e.target.value)}
              className="h-8 pl-8 text-[13px]"
            />
          </div>
        )}

        {docs === null && !loadError && <SkeletonGrid />}
        {loadError && (
          <div className="rounded-xl border border-line bg-surface p-8 text-center">
            <p className="text-sm text-err">连接后端失败：{loadError}</p>
            <Button className="mt-4" onClick={() => void refresh()}>
              重试
            </Button>
          </div>
        )}
        {filtered !== null && !loadError && (
          <DocGrid
            docs={filtered}
            hasKeyword={keyword.trim().length > 0}
            onRename={(d) => {
              setRenaming(d);
              setRenameDraft(d.title);
            }}
            onDelete={(d) => setDeleting(d)}
          />
        )}
      </main>

      <Modal open={renaming !== null} onClose={() => setRenaming(null)} title="重命名文档" width={360}>
        <Input
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && confirmRename()}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRenaming(null)}>
            取消
          </Button>
          <Button variant="primary" onClick={confirmRename} disabled={!renameDraft.trim()}>
            保存
          </Button>
        </div>
      </Modal>

      <Modal open={deleting !== null} onClose={() => setDeleting(null)} title="删除文档" width={380}>
        <p className="text-sm text-text-secondary">
          确定删除「<span className="font-medium text-text">{deleting?.title}</span>」吗？
          操作日志会一并删除，正在编辑的人会被请出文档，此操作不可撤销。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(null)}>
            取消
          </Button>
          <Button variant="primary" className="bg-err! text-white! hover:bg-err/80!" onClick={confirmDelete}>
            删除
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function DocGrid({
  docs,
  hasKeyword,
  onRename,
  onDelete,
}: {
  docs: DocumentSummary[];
  hasKeyword: boolean;
  onRename: (d: DocumentSummary) => void;
  onDelete: (d: DocumentSummary) => void;
}) {
  if (docs.length === 0) return hasKeyword ? <NoResult /> : <EmptyState />;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {docs.map((d) => (
        <a
          key={d.id}
          href={`#/doc/${d.id}`}
          className="group relative rounded-xl border border-line bg-surface p-4 shadow-card transition-all hover:-translate-y-0.5 hover:border-accent/50"
        >
          <div className="flex items-start justify-between gap-2">
            <h3 className="line-clamp-2 font-medium text-text group-hover:text-accent">
              {d.title}
              {d.engine === 'crdt' && (
                <span className="ml-1.5 rounded bg-[#30a46c]/15 px-1 py-0.5 align-middle text-[10px] font-bold text-[#30a46c]">
                  CRDT
                </span>
              )}
            </h3>
            <span className="shrink-0 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">v{d.snapshotRevision}</span>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <p className="text-xs text-muted">{timeAgo(d.updatedAt)}</p>
            {/* 悬停出现的操作按钮；CardAction 内部会拦截住不让它触发卡片跳转 */}
            <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <CardAction
                label="重命名"
                onClick={() => onRename(d)}
                icon={
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                  </svg>
                }
              />
              <CardAction
                label="删除"
                danger
                onClick={() => onDelete(d)}
                icon={
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  </svg>
                }
              />
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}

/** 卡片上的操作按钮。卡片本身是 <a>，点击操作要阻止跳转 */
function CardAction({
  label,
  danger,
  onClick,
  icon,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      title={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className={`grid size-6 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 ${
        danger ? 'hover:text-err!' : 'hover:text-text'
      }`}
    >
      {icon}
    </button>
  );
}

function NoResult() {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-line py-16">
      <p className="text-sm text-muted">没有匹配的文档，换个关键词试试</p>
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
