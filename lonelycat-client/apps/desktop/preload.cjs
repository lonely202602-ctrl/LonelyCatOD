// 渲染进程与主进程之间唯一的桥：只暴露「是不是桌面端」和「同步窗口控制按钮配色」两个能力，
// 不把 ipcRenderer 或 Node 能力泄露给网页（contextIsolation 保持开启）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lcDesktop', {
  isDesktop: true,
  /**
   * 同步 titleBarOverlay。opts: { color, symbolColor, height? }
   * 网页在主题切换 / 页面切换时调用，让原生窗口控制按钮融入界面。
   */
  setTitleBarOverlay: (opts) => ipcRenderer.invoke('lc:set-titlebar-overlay', opts),
});
