/** 读取并应用主题、强调色和系统主题变化。 */
import { browserStorageStore } from '../adapter/StorageAdapter';

export function getThemeMode(): 'dark' | 'light' | 'system' {
  const mode = browserStorageStore.get('themeMode');
  return mode === 'dark' || mode === 'system' ? mode : 'light';
}

export function getAccentColor(): string {
  const accent = browserStorageStore.get('accentColor') || '#0f7dff';
  return /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#0f7dff';
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): RgbColor {
  const value = parseInt(hex.slice(1), 16);
  return {
    r: value >> 16,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

function tintColor(
  hex: string,
  target: 0 | 255,
  ratio: number,
): string {
  const rgb = hexToRgb(hex);
  const channel = (value: number) => (
    Math.round(value + (target - value) * ratio)
  );
  const value = (
    (channel(rgb.r) << 16)
    | (channel(rgb.g) << 8)
    | channel(rgb.b)
  );
  return `#${value.toString(16).padStart(6, '0')}`;
}

function getAccentForeground({ r, g, b }: RgbColor): string {
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.62 ? '#172033' : '#ffffff';
}

export function applyTheme(): void {
  const mode = getThemeMode();
  const resolved = mode === 'system'
    ? (
      window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    )
    : mode;
  document.documentElement.setAttribute('data-theme', resolved);

  const accent = getAccentColor();
  const rgb = hexToRgb(accent);
  const hover = tintColor(
    accent,
    resolved === 'light' ? 0 : 255,
    resolved === 'light' ? 0.14 : 0.16,
  );
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-hover', hover);
  document.documentElement.style.setProperty(
    '--accent-foreground',
    getAccentForeground(rgb),
  );
  document.documentElement.style.setProperty(
    '--accent-glow',
    `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${
      resolved === 'light' ? 0.2 : 0.18
    })`,
  );
  document.documentElement.style.setProperty(
    '--accent-subtle',
    `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${
      resolved === 'light' ? 0.12 : 0.09
    })`,
  );
}

export function watchSystemTheme(): () => void {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const listener = () => {
    if (getThemeMode() === 'system') applyTheme();
  };
  mediaQuery.addEventListener('change', listener);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    mediaQuery.removeEventListener('change', listener);
  };
}
