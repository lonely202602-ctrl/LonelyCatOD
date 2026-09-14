import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径，这样 Electron 用 file:// 打开 dist/index.html 也能加载资源
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
