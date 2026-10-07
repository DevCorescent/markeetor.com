/** Theme preference shared by server (initial paint) and client (switching). */
export type ThemePref = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_COOKIE = 'lc_theme';
export const THEME_PREFS: ThemePref[] = ['light', 'dark', 'system'];

export const isThemePref = (v: unknown): v is ThemePref => v === 'light' || v === 'dark' || v === 'system';

/**
 * Inline, pre-paint script for the "system" preference: resolves prefers-color-scheme before the first
 * frame so there is no flash of the wrong theme. Explicit preferences are rendered server-side.
 */
export const SYSTEM_THEME_SCRIPT =
  "(function(){try{var d=document.documentElement;if(d.getAttribute('data-theme-pref')==='system'){d.setAttribute('data-theme',matchMedia('(prefers-color-scheme: light)').matches?'light':'dark')}}catch(e){}})()";

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref !== 'system') return pref;
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Applies a preference immediately (cross-fade), remembers it for a year, and notifies listeners. */
export function setThemePref(pref: ThemePref) {
  const root = document.documentElement;
  root.classList.add('theme-transition');
  root.setAttribute('data-theme-pref', pref);
  root.setAttribute('data-theme', resolveTheme(pref));
  document.cookie = `${THEME_COOKIE}=${pref}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  window.setTimeout(() => root.classList.remove('theme-transition'), 260);
}

export function currentThemePref(): ThemePref {
  const v = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme-pref') : null;
  return isThemePref(v) ? v : 'dark';
}
