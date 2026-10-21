// Electron 桌面壳。
// 开发模式（npm run dev:desktop，带 --dev）：加载 Vite 开发服务器 http://localhost:5173，需要先启动 npm run dev:web。
// 正式模式：加载 apps/web/dist/index.html，需要先 npm run build:web。
// 前端代码完全复用 apps/web，后端地址由 web 的 VITE_SERVER_URL 决定。
//
// 无边框一体化：titleBarStyle hidden 去掉原生标题栏，窗口控制按钮（最小化/最大化/关闭）
// 以 titleBarOverlay 的配色叠层画在网页页头上；页头在网页里声明为可拖拽区域
// （index.css 的 .lc-titlebar，拖拽/双击最大化由 Chromium 原生处理）。
// overlay 的颜色和高度由网页在主题/页面切换时通过 preload 桥调 setTitleBarOverlay 同步。

const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('node:path');

const isDev = process.argv.includes('--dev');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    title: 'LonelyCat 协同编辑',
    // 窗口/任务栏图标：web 的 public 下的官方 logo 图案（打包发布时需把它带进安装资源）
    icon: path.join(__dirname, '..', 'web', 'public', 'icon.png'),
    // 首帧前先按浅色主题铺底色，避免白闪；页面加载后由网页同步主题
    backgroundColor: '#f7f7f4',
    // 网页加载完成再显示窗口，配合 backgroundColor 消除启动闪烁
    show: false,
    titleBarStyle: 'hidden',
    // Windows：原生控制按钮叠层。初始配色 = 浅色主题，运行时由网页同步
    titleBarOverlay: { color: '#f7f7f4', symbolColor: '#1d1d1b', height: 48 },
    webPreferences: {
      // 页面只是普通网页，不需要 Node 能力；preload 只暴露一个极窄的主题同步桥
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.once('ready-to-show', () => win.show());

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
    // 菜单已移除，开发时保留 F12 / Ctrl+R 键盘入口
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12') win.webContents.toggleDevTools();
      if (input.control && input.key.toLowerCase() === 'r') win.webContents.reload();
    });
  } else {
    win.loadFile(path.join(__dirname, '..', 'web', 'dist', 'index.html'));
  }

  return win;
}

// 网页请求更新窗口控制按钮叠层的配色/高度（仅 Windows 支持；mac 自带红绿灯、Linux 无此叠层）
function registerTitleBarOverlayBridge() {
  ipcMain.handle('lc:set-titlebar-overlay', (event, opts) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && process.platform === 'win32' && typeof win.setTitleBarOverlay === 'function') {
      win.setTitleBarOverlay(opts);
    }
    return true;
  });
}

app.whenReady().then(() => {
  // 去掉默认的 File/Edit/View/Window/Help 菜单：它和网页 UI 风格割裂，
  // 且我们不需要任何菜单项。开发用的 F12/刷新在上面用键盘事件单独保留。
  Menu.setApplicationMenu(null);
  registerTitleBarOverlayBridge();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
