import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { OtSyncAdapter, type RemoteClient } from '@lonelycat/sync';
import { collab } from '@lonelycat/editor';
import { wsUrl } from './config';
import { createDocument, listDocuments } from './api';

/**
 * 网页壳：两个页面
 *   #/            文档列表
 *   #/doc/<id>    编辑器
 * 用 hash 路由，这样 Electron 用 file:// 打开也能正常工作。
 */

const app = document.getElementById('app')!;

/** 显示名存在 localStorage，第一次进入时询问 */
function getUserName(): string {
  let name = localStorage.getItem('lc.name');
  if (!name) {
    name = prompt('请输入你的昵称', `用户${Math.floor(Math.random() * 1000)}`) || '匿名';
    localStorage.setItem('lc.name', name);
  }
  return name;
}

// ----------------------------------------------------------------------
// 文档列表页
// ----------------------------------------------------------------------

async function renderList(): Promise<void> {
  app.innerHTML = `
    <div class="page">
      <header class="topbar">
        <h1>LonelyCat 协同编辑</h1>
        <div class="topbar-right">
          <span class="muted">你好，${escapeHtml(getUserName())}</span>
          <button id="rename" class="link">改名</button>
        </div>
      </header>
      <section class="create">
        <input id="title" placeholder="新文档标题" />
        <button id="create">新建文档</button>
      </section>
      <ul id="docs" class="doc-list"><li class="muted">加载中...</li></ul>
    </div>`;

  document.getElementById('rename')!.onclick = () => {
    localStorage.removeItem('lc.name');
    getUserName();
    renderList();
  };

  const titleInput = document.getElementById('title') as HTMLInputElement;
  document.getElementById('create')!.onclick = async () => {
    const doc = await createDocument(titleInput.value || '未命名文档');
    location.hash = `#/doc/${doc.id}`;
  };
  titleInput.onkeydown = (e) => {
    if (e.key === 'Enter') (document.getElementById('create') as HTMLButtonElement).click();
  };

  const ul = document.getElementById('docs')!;
  try {
    const docs = await listDocuments();
    ul.innerHTML = docs.length
      ? docs
          .map(
            (d) => `
        <li><a href="#/doc/${d.id}">${escapeHtml(d.title)}</a>
            <span class="muted">版本 ${d.snapshotRevision} · ${new Date(d.updatedAt).toLocaleString()}</span></li>`,
          )
          .join('')
      : '<li class="muted">还没有文档，新建一个吧</li>';
  } catch (e) {
    ul.innerHTML = `<li class="error">连接后端失败：${escapeHtml(String(e))}</li>`;
  }
}

// ----------------------------------------------------------------------
// 编辑页
// ----------------------------------------------------------------------

let currentView: EditorView | null = null;
let currentAdapter: OtSyncAdapter | null = null;

function renderEditor(docId: string): void {
  app.innerHTML = `
    <div class="page editor-page">
      <header class="topbar">
        <a href="#/" class="back">← 文档列表</a>
        <span id="status" class="status">连接中</span>
        <span id="state" class="muted"></span>
        <span id="users" class="users"></span>
      </header>
      <div id="editor"></div>
      <div id="errors" class="errors"></div>
    </div>`;

  const name = getUserName();
  const adapter = new OtSyncAdapter({ url: wsUrl, docId, name });
  currentAdapter = adapter;

  const statusEl = document.getElementById('status')!;
  const stateEl = document.getElementById('state')!;
  const usersEl = document.getElementById('users')!;
  const errorsEl = document.getElementById('errors')!;

  /** 在线用户列表 */
  const online = new Map<string, RemoteClient>();
  const renderUsers = () => {
    usersEl.innerHTML = [...online.values()]
      .map((c) => `<span class="user-chip">${escapeHtml(c.name)}</span>`)
      .join('');
  };

  adapter.on('status', (s) => {
    statusEl.textContent = { connecting: '连接中', connected: '已连接', disconnected: '已断开' }[s];
    statusEl.className = `status status-${s}`;
  });
  adapter.on('snapshot', (_content, revision, self, others) => {
    online.clear();
    online.set(self.clientId, { ...self, name: `${self.name}（我）` });
    for (const o of others) online.set(o.clientId, o);
    renderUsers();
    stateEl.textContent = `版本 ${revision}`;
  });
  adapter.on('joined', (c) => {
    online.set(c.clientId, c);
    renderUsers();
  });
  adapter.on('left', (id) => {
    online.delete(id);
    renderUsers();
  });
  adapter.on('error', (msg) => {
    const div = document.createElement('div');
    div.textContent = `服务器：${msg}`;
    errorsEl.appendChild(div);
    setTimeout(() => div.remove(), 5000);
  });

  const view = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        collab({ adapter }),
        // 每次事务后刷新版本号显示
        EditorView.updateListener.of(() => {
          stateEl.textContent = `版本 ${adapter.revision} · ${adapter.stateName}`;
        }),
      ],
    }),
    parent: document.getElementById('editor')!,
  });
  currentView = view;
  adapter.connect();
}

function teardownEditor(): void {
  currentAdapter?.disconnect();
  currentView?.destroy();
  currentAdapter = null;
  currentView = null;
}

// ----------------------------------------------------------------------
// 路由
// ----------------------------------------------------------------------

function route(): void {
  teardownEditor();
  const m = location.hash.match(/^#\/doc\/([\w-]+)/);
  if (m) renderEditor(m[1]);
  else renderList();
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', teardownEditor);
route();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
