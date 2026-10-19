import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './theme';
import { Modal, ToastProvider } from './components/ui';
import { ListPage } from './pages/ListPage';
import { EditorPage } from './pages/EditorPage';
import { useHashRoute } from './useHashRoute';
import './index.css';

/**
 * 应用入口。两层 Provider：主题（深浅切换）、Toast（错误提示）。
 * 昵称存 localStorage，第一次进入时用对话框问一次（替代原来的 prompt()）。
 */

function getSavedName(): string {
  return localStorage.getItem('lc.name') ?? '';
}

function App() {
  const route = useHashRoute();
  const [name, setName] = useState(getSavedName);
  const [askName, setAskName] = useState(!getSavedName());
  const [draft, setDraft] = useState('');

  const saveName = () => {
    const n = draft.trim();
    if (!n) return;
    localStorage.setItem('lc.name', n);
    setName(n);
    setAskName(false);
  };

  return (
    <>
      {route.page === 'list' ? (
        <ListPage userName={name || '匿名'} onRename={() => { setDraft(name); setAskName(true); }} />
      ) : (
        <EditorPage docId={route.docId} userName={name || '匿名'} />
      )}

      <Modal open={askName} onClose={() => setAskName(false)} title="你的昵称" width={340}>
        <p className="mb-3 text-sm text-muted">协同时其他人会看到这个名字和你的光标颜色。</p>
        <input
          value={draft}
          placeholder={`例如：用户${Math.floor(Math.random() * 1000)}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && saveName()}
          className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-text placeholder:text-muted outline-none focus:border-accent"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => setAskName(false)}
            className="h-8 rounded-lg px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            取消
          </button>
          <button
            onClick={saveName}
            disabled={!draft.trim()}
            className="h-8 rounded-lg bg-accent px-3.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </Modal>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
