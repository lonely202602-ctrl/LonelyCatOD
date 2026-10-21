import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * 深浅双主题。切换 = 切换 <html> 上的 .dark class，
 * 具体颜色由 index.css 里的 CSS 变量两套取值负责。
 * index.html 里有一段首屏内联脚本提前恢复主题，避免刷新时闪白。
 */

export type Theme = 'light' | 'dark';

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: 'light',
  toggle: () => {},
});

function initialTheme(): Theme {
  const saved = localStorage.getItem('lc.theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('lc.theme', theme);
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

// ----------------------------------------------------------------------
// Electron 桌面端一体化（浏览器里全部是空操作）
// ----------------------------------------------------------------------

declare global {
  interface Window {
    lcDesktop?: {
      isDesktop: boolean;
      setTitleBarOverlay: (opts: { color: string; symbolColor: string; height?: number }) => Promise<void>;
    };
  }
}

/**
 * 桌面端窗口一体化：
 *   - 让页头成为可拖拽区域（配合 index.css 的 .lc-titlebar），并把右上角让位给
 *     原生窗口控制按钮（宽度写在 CSS 变量 --wco-w 上，随窗口变化更新）
 *   - 主题/页面切换时，把窗口控制按钮叠层的配色和高度同步成当前界面的样子
 *
 * @param page 'list' 页头透明坐在页面底色上；'editor' 页头是 surface 色带分隔线
 */
export function useDesktopChrome(page: 'list' | 'editor') {
  const { theme } = useTheme();

  useEffect(() => {
    if (!window.lcDesktop?.isDesktop) return;
    const wco = (navigator as unknown as {
      windowControlsOverlay?: {
        getTitlebarAreaRect: () => DOMRect | undefined;
        addEventListener: (t: string, l: () => void) => void;
        removeEventListener: (t: string, l: () => void) => void;
      };
    }).windowControlsOverlay;
    if (!wco) return;

    const updateWidth = () => {
      const rect = wco.getTitlebarAreaRect();
      const reserved = rect ? Math.max(0, window.innerWidth - rect.width) : 0;
      document.documentElement.style.setProperty('--wco-w', `${reserved}px`);
    };
    updateWidth();
    wco.addEventListener('geometrychange', updateWidth);
    return () => wco.removeEventListener('geometrychange', updateWidth);
  }, []);

  useEffect(() => {
    if (!window.lcDesktop?.setTitleBarOverlay) return;
    const cs = getComputedStyle(document.documentElement);
    const color = cs.getPropertyValue(page === 'editor' ? '--surface' : '--bg').trim();
    const symbolColor = cs.getPropertyValue('--text').trim();
    const height = page === 'editor' ? 56 : 64;
    void window.lcDesktop.setTitleBarOverlay({ color, symbolColor, height });
  }, [theme, page]);
}

const SunIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);

const MoonIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
      className={`grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-text ${className}`}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
