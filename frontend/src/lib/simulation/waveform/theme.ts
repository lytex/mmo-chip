import type { ThemeConfig } from './types';

export const DARK_THEME: ThemeConfig = {
  background: '#15140f',
  surface: '#2a2823',
  border: '#34322c',
  grid: '#2a2823',
  text: '#ece8de',
  textMuted: '#7e7a6e',
  cursor: '#7e7a6e',
  tooltipBg: '#2a2823',
  tooltipBorder: '#34322c',
  font: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  fontSize: 11,
};

export const LIGHT_THEME: ThemeConfig = {
  background: 'hsl(210, 40%, 98%)',
  surface: 'hsl(0, 0%, 100%)',
  border: 'hsl(214, 32%, 91%)',
  grid: 'hsl(214, 32%, 91%)',
  text: 'hsl(222, 47%, 11%)',
  textMuted: 'hsl(215, 16%, 47%)',
  cursor: 'hsl(215, 16%, 47%)',
  tooltipBg: 'hsl(0, 0%, 100%)',
  tooltipBorder: 'hsl(214, 32%, 91%)',
  font: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  fontSize: 11,
};

export function mergeTheme(base: ThemeConfig, overrides: Partial<ThemeConfig>): ThemeConfig {
  return { ...base, ...overrides };
}

export function resolveTheme(theme: 'dark' | 'light' | ThemeConfig | undefined): ThemeConfig {
  if (theme === undefined || theme === 'dark') return DARK_THEME;
  if (theme === 'light') return LIGHT_THEME;
  return theme;
}
