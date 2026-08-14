/**
 * Public URL prefix for this UI ("" = site root, "/dashboard" when reverse-proxied).
 * Used for history, refresh, back/forward, and showcase deep links.
 */

function viteBasePath(): string {
  try {
    const raw = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL;
    return normalizeDashboardPath(raw || "/");
  } catch {
    return "";
  }
}

/** Normalize a setting or Vite base to "" (root) or "/segment". */
export function normalizeDashboardPath(raw: unknown): string {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      return "";
    }
  }
  if (s === "/") return "";
  s = s.replace(/\/+$/, "");
  if (!s.startsWith("/")) s = `/${s}`;
  if (s.includes("..") || /[?#\\]/.test(s)) return "";
  if (!/^\/[A-Za-z0-9/_-]+$/.test(s)) return "";
  return s;
}

/** Value shown in Settings (root displays as "/"). */
export function formatDashboardPathSetting(raw: unknown): string {
  const n = normalizeDashboardPath(raw);
  return n || "/";
}

let current = viteBasePath();

export function getDashboardPath(): string {
  return current;
}

export function setDashboardPath(raw: unknown): string {
  current = normalizeDashboardPath(raw);
  return current;
}

/** Join an in-app route ("/" or "/spark/id") onto the public prefix. */
export function withDashboardPath(route: string, base = getDashboardPath()): string {
  const rel = route.startsWith("/") ? route : `/${route}`;
  if (!base) return rel;
  if (rel === "/") return `${base}/`;
  return `${base}${rel}`;
}

/** Strip the public prefix so route matching can use "/" and "/spark/:id". */
export function stripDashboardPath(pathname: string, base = getDashboardPath()): string {
  if (!base) return pathname || "/";
  if (pathname === base || pathname === `${base}/`) return "/";
  if (pathname.startsWith(`${base}/`)) {
    const rest = pathname.slice(base.length);
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return pathname || "/";
}
