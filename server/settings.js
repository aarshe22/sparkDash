import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWrite } from "./util/atomicWrite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SETTINGS_PATH =
  process.env.SETTINGS_JSON_PATH || path.join(ROOT, "config", "settings.json");

export const DEFAULT_HAPROXY_BACKENDS = Object.freeze([
  Object.freeze({ name: "Lambda", port: 8001, enabled: true }),
  Object.freeze({ name: "GX10A", port: 8002, enabled: true }),
  Object.freeze({ name: "GX10B", port: 8003, enabled: true }),
  Object.freeze({ name: "GX10C", port: 8004, enabled: true }),
  Object.freeze({ name: "GX10D", port: 8005, enabled: true }),
]);

export const DEFAULT_HAPROXY_SETTINGS = Object.freeze({
  enabled: false,
  exportEnabled: false,
  domain: "oai.mhps.dev",
  remoteDockerHost: "lambda",
  sshPort: 22,
  sshUser: "root",
  sshAuth: "key",
  containerName: "ai-haproxy",
  statsPort: 8404,
  mainConfigPath: "/usr/local/etc/haproxy/haproxy.cfg",
  managedSnippetPath: "/usr/local/etc/haproxy/conf.d/sparkdash.cfg",
  backendMappings: DEFAULT_HAPROXY_BACKENDS,
});

const DEFAULTS = Object.freeze({
  pollIntervalMs: 2000,
  defaultLlmPort: 8888,
  autoHideOffline: false,
  temperatureUnit: "celsius",
  /** Persist prompts / HTTP traces / GPU samples on decode benchmark runs. */
  benchDebugTraces: false,
  /** Layout density — comfortable (default) or compact. */
  density: "comfortable",
  /** Overview cards: tiled (3 per row) or horizontal (1 per row). */
  overviewLayout: "tiled",
  /**
   * Public URL path for this UI. "/" when served at the site root;
   * "/dashboard" when reverse-proxied (refresh / back / deep links).
   */
  dashboardPath: "/",
  haproxy: DEFAULT_HAPROXY_SETTINGS,
});

/** @type {typeof DEFAULTS} */
let _settings = { ...DEFAULTS };

function _clampSettings(settings) {
  const s = { ...settings };
  // Clamp poll interval to 1000ms minimum
  if (typeof s.pollIntervalMs !== "number" || s.pollIntervalMs < 1000) {
    s.pollIntervalMs = 1000;
  }
  // Clamp LLM port to 1–65535
  if (typeof s.defaultLlmPort !== "number" || s.defaultLlmPort < 1 || s.defaultLlmPort > 65535) {
    s.defaultLlmPort = DEFAULTS.defaultLlmPort;
  }
  // Ensure autoHideOffline is boolean
  s.autoHideOffline = Boolean(s.autoHideOffline);
  // Ensure benchDebugTraces is boolean
  s.benchDebugTraces = Boolean(s.benchDebugTraces);
  // Ensure temperatureUnit is valid
  if (s.temperatureUnit !== "celsius" && s.temperatureUnit !== "fahrenheit") {
    s.temperatureUnit = DEFAULTS.temperatureUnit;
  }
  // Ensure density is valid
  if (s.density !== "comfortable" && s.density !== "compact") {
    s.density = DEFAULTS.density;
  }
  if (s.overviewLayout !== "tiled" && s.overviewLayout !== "horizontal") {
    s.overviewLayout = DEFAULTS.overviewLayout;
  }
  s.dashboardPath = normalizeDashboardPathSetting(s.dashboardPath, DEFAULTS.dashboardPath);
  s.haproxy = normalizeHaproxySettings(s.haproxy);
  return s;
}

function validPort(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function validHost(value, fallback) {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!s || s.length > 253) return fallback;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) {
    const octets = s.split(".").map(Number);
    return octets.every((n) => n >= 0 && n <= 255) ? s : fallback;
  }
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(s)
    ? s
    : fallback;
}

function validAbsolutePath(value, fallback) {
  const s = typeof value === "string" ? value.trim() : "";
  if (
    !s.startsWith("/") ||
    s.length > 512 ||
    s.includes("..") ||
    !/^\/[A-Za-z0-9._/-]+$/.test(s)
  ) {
    return fallback;
  }
  return s.replace(/\/{2,}/g, "/");
}

/**
 * Return a strict, non-secret HAProxy settings object. Unknown mapping fields
 * are discarded and malformed values fall back to safe defaults.
 */
export function normalizeHaproxySettings(raw) {
  const h = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const domain = validHost(h.domain, DEFAULT_HAPROXY_SETTINGS.domain);
  const remoteDockerHost = validHost(
    h.remoteDockerHost,
    DEFAULT_HAPROXY_SETTINGS.remoteDockerHost
  );
  const sshUser =
    typeof h.sshUser === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(h.sshUser.trim())
      ? h.sshUser.trim()
      : DEFAULT_HAPROXY_SETTINGS.sshUser;
  const containerName =
    typeof h.containerName === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(h.containerName.trim())
      ? h.containerName.trim()
      : DEFAULT_HAPROXY_SETTINGS.containerName;

  const seenTargets = new Set();
  const seenEnabledPorts = new Set();
  const inputMappings = Array.isArray(h.backendMappings)
    ? h.backendMappings
    : DEFAULT_HAPROXY_BACKENDS;
  const backendMappings = [];
  for (const item of inputMappings.slice(0, 64)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const port = validPort(item.port, 0);
    const enabled = item.enabled !== false;
    const sparkId =
      typeof item.sparkId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.sparkId.trim())
        ? item.sparkId.trim()
        : undefined;
    const llmPort = validPort(item.llmPort, 0) || undefined;
    const targetKey = sparkId
      ? `spark:${sparkId.toLowerCase()}:${llmPort || "primary"}`
      : `name:${name.toLowerCase()}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name)) continue;
    if (!port || seenTargets.has(targetKey) || (enabled && seenEnabledPorts.has(port))) continue;
    seenTargets.add(targetKey);
    if (enabled) seenEnabledPorts.add(port);
    backendMappings.push({
      name,
      port,
      enabled,
      ...(sparkId ? { sparkId } : {}),
      ...(llmPort ? { llmPort } : {}),
    });
  }

  return {
    enabled: h.enabled === true,
    exportEnabled: h.exportEnabled === true,
    domain,
    remoteDockerHost,
    sshPort: validPort(h.sshPort, DEFAULT_HAPROXY_SETTINGS.sshPort),
    sshUser,
    sshAuth: h.sshAuth === "pass" ? "pass" : "key",
    containerName,
    statsPort: validPort(h.statsPort, DEFAULT_HAPROXY_SETTINGS.statsPort),
    mainConfigPath: validAbsolutePath(
      h.mainConfigPath,
      DEFAULT_HAPROXY_SETTINGS.mainConfigPath
    ),
    managedSnippetPath: validAbsolutePath(
      h.managedSnippetPath,
      DEFAULT_HAPROXY_SETTINGS.managedSnippetPath
    ),
    backendMappings:
      backendMappings.length > 0
        ? backendMappings
        : DEFAULT_HAPROXY_BACKENDS.map((item) => ({ ...item })),
  };
}

function cloneSettings(settings) {
  return {
    ...settings,
    haproxy: {
      ...settings.haproxy,
      backendMappings: settings.haproxy.backendMappings.map((item) => ({ ...item })),
    },
  };
}

function normalizeDashboardPathSetting(raw, fallback) {
  if (raw == null) return fallback;
  let s = String(raw).trim();
  if (!s) return fallback;
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      return fallback;
    }
  }
  if (s === "/") return "/";
  s = s.replace(/\/+$/, "");
  if (!s.startsWith("/")) s = `/${s}`;
  if (s.includes("..") || /[?#\\]/.test(s)) return fallback;
  if (!/^\/[A-Za-z0-9/_-]+$/.test(s)) return fallback;
  return s;
}

/** Load settings from disk, falling back to defaults. */
export function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    _settings = _clampSettings({ ...DEFAULTS, ...parsed });
  } catch (err) {
    if (err.code === "ENOENT") {
      _settings = { ...DEFAULTS };
      saveSettings();
    } else {
      console.error("[settings] Failed to load settings.json:", err.message);
      _settings = { ...DEFAULTS };
    }
  }
  return cloneSettings(_settings);
}

/** Persist current settings to disk. */
export function saveSettings() {
  try {
    // Atomic write (tmp + rename) — a SIGKILL/power loss mid-write must not
    // truncate settings.json. atomicWrite ensures the dir is created.
    atomicWrite(SETTINGS_PATH, JSON.stringify(_settings, null, 2) + "\n", 0o644);
  } catch (err) {
    console.error("[settings] Failed to save settings.json:", err.message);
  }
}

/** Get current settings (clamped). */
export function getSettings() {
  return cloneSettings(_settings);
}

/**
 * Apply a partial patch, persist, and return the new settings.
 * @param {Partial<typeof DEFAULTS>} patch
 * @returns {typeof DEFAULTS}
 */
export function updateSettings(patch) {
  const merged = _clampSettings({
    ..._settings,
    ...patch,
    haproxy:
      patch?.haproxy && typeof patch.haproxy === "object"
        ? { ..._settings.haproxy, ...patch.haproxy }
        : _settings.haproxy,
  });
  _settings = merged;
  saveSettings();
  return cloneSettings(_settings);
}
