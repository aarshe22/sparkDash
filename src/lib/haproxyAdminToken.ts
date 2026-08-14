export const HAPROXY_ADMIN_TOKEN_KEY = "sparkdash.haproxy.adminToken";

export function readHaproxyAdminToken(): string {
  try {
    return sessionStorage.getItem(HAPROXY_ADMIN_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeHaproxyAdminToken(value: string): void {
  try {
    if (value) sessionStorage.setItem(HAPROXY_ADMIN_TOKEN_KEY, value);
    else sessionStorage.removeItem(HAPROXY_ADMIN_TOKEN_KEY);
  } catch {
    /* Session storage may be blocked. */
  }
}
