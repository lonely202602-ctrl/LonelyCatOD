// Electron 桌面壳。
// 开发模式（npm run dev:desktop，带 --dev）：加载 Vite 开发服务器 http://localhost:5173，需要先启动 npm run dev:web。
// 正式模式：加载 apps/web/dist/index.html，需要先 npm run build:web。
// 前端代码完全复用 apps/web，后端地址由 web 的 VITE_SERVER_URL 决定。

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const isDev = process.argv.includes('--dev');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'LonelyCat 协同编辑',
    webPreferences: {
      // 页面只是普通网页，不需要 Node 能力，保持默认的隔离设置最安全
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'web', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
