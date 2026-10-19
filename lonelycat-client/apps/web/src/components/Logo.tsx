import markOnDark from '../assets/logo-mark-on-dark.png';
import markOnLight from '../assets/logo-mark-on-light.png';

/**
 * 品牌 logo：官方猫标志（图案部分）+ CSS 渲染的文字标。
 * 图案按主题切换：深色界面用白色版，浅色界面用深色版（原图由 scripts/split-logo.ps1 裁切）。
 */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <img src={markOnDark} alt="LonelyCatOD" className="hidden h-7 w-auto dark:block" draggable={false} />
      <img src={markOnLight} alt="LonelyCatOD" className="block h-7 w-auto dark:hidden" draggable={false} />
      {!compact && (
        <span className="text-[15px] font-semibold tracking-tight text-text">
          LonelyCat<span className="text-accent">OD</span>
        </span>
      )}
    </span>
  );
}
