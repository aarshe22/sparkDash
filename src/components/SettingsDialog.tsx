import { useEffect, useState } from "react";
import {
  fetchSettings,
  setHaproxyPassword,
  testHaproxy,
  updateSettings,
} from "../api/client";
import type { HaproxySettings, Settings } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";
import {
  readHaproxyAdminToken,
  storeHaproxyAdminToken,
} from "../lib/haproxyAdminToken";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: (settings: Settings) => void;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
}

const POLL_PRESETS = [
  { label: "1s", value: 1000 },
  { label: "2s", value: 2000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
];

export function SettingsDialog({ open, onClose, onSaved }: SettingsDialogProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [haproxyDirty, setHaproxyDirty] = useState(false);
  const [adminToken, setAdminToken] = useState(readHaproxyAdminToken);
  const [haproxyPassword, setHaproxyPasswordValue] = useState("");
  const [haproxyBusy, setHaproxyBusy] = useState<"test" | "password" | null>(null);
  const [haproxyMessage, setHaproxyMessage] = useState<{
    text: string;
    ok: boolean;
  } | null>(null);

  useEscape(onClose);

  useEffect(() => {
    if (!open) {
      setSettings(null);
      setError(null);
      setDirty(false);
      setHaproxyDirty(false);
      setHaproxyPasswordValue("");
      setHaproxyMessage(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const { mounted, visible } = useModalPresence(open);

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };

  const updateHaproxy = (patch: Partial<HaproxySettings>) => {
    setSettings((prev) =>
      prev ? { ...prev, haproxy: { ...prev.haproxy, ...patch } } : prev
    );
    setDirty(true);
    setHaproxyDirty(true);
  };

  const storeAdminToken = (value: string) => {
    setAdminToken(value);
    storeHaproxyAdminToken(value);
  };

  const handleSave = async () => {
    if (!settings) return;
    const enabledPorts = settings.haproxy.backendMappings
      .filter((mapping) => mapping.enabled)
      .map((mapping) => mapping.port);
    if (new Set(enabledPorts).size !== enabledPorts.length) {
      setError("Enabled HAProxy mappings must use unique public ports.");
      return;
    }
    if (haproxyDirty && !adminToken.trim()) {
      setError("Enter the admin token to save HAProxy settings.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const patch: Partial<Settings> = haproxyDirty
        ? settings
        : (({ haproxy: _haproxy, ...general }) => general)(settings);
      const result = await updateSettings(patch, haproxyDirty ? adminToken : undefined);
      setSettings(result);
      setDirty(false);
      setHaproxyDirty(false);
      onSaved(result);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleHaproxyTest = async () => {
    if (!adminToken.trim()) {
      setHaproxyMessage({ text: "Enter the admin token first.", ok: false });
      return;
    }
    setHaproxyBusy("test");
    setHaproxyMessage(null);
    try {
      const result = await testHaproxy(adminToken);
      setHaproxyMessage({
        text: result.ok
          ? `Connection succeeded; container is ${result.containerStatus}.`
          : result.message || "Connection test failed.",
        ok: result.ok,
      });
    } catch (err) {
      setHaproxyMessage({
        text: err instanceof Error ? err.message : "Connection test failed.",
        ok: false,
      });
    } finally {
      setHaproxyBusy(null);
    }
  };

  const handleHaproxyPassword = async () => {
    if (!haproxyPassword) {
      setHaproxyMessage({ text: "Password left unchanged.", ok: true });
      return;
    }
    if (!adminToken.trim()) {
      setHaproxyMessage({ text: "Enter the admin token first.", ok: false });
      return;
    }
    setHaproxyBusy("password");
    setHaproxyMessage(null);
    try {
      await setHaproxyPassword(haproxyPassword, adminToken);
      setHaproxyPasswordValue("");
      setHaproxyMessage({ text: "Encrypted SSH password saved.", ok: true });
    } catch (err) {
      setHaproxyMessage({
        text: err instanceof Error ? err.message : "Unable to save password.",
        ok: false,
      });
    } finally {
      setHaproxyBusy(null);
    }
  };

  if (!mounted) return null;

  return (
    <div
      className={`settings-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4${
        visible ? " is-open" : ""
      }`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-panel max-h-[calc(100vh-2rem)] w-full max-w-4xl overflow-y-auto p-4 sm:p-6">
        <h2 className="mb-4 text-sm font-semibold text-text-strong">Settings</h2>

        {loading && <p className="text-xs text-muted">Loading…</p>}

        {settings && !loading && (
          <div className="space-y-4">
            {/* Poll interval */}
            <div>
              <label className="mb-2 block text-xs text-muted">Poll interval</label>
              <div className="flex gap-2">
                {POLL_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => update({ pollIntervalMs: preset.value })}
                    className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                      settings.pollIntervalMs === preset.value
                        ? "bg-accent text-white"
                        : "border border-border bg-surface-elevated text-muted hover:bg-surface-hover"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Default LLM port */}
            <div>
              <label className="mb-1 block text-xs text-muted">Default LLM port</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={settings.defaultLlmPort}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) update({ defaultLlmPort: val });
                }}
                className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
              />
              <p className="mt-1 text-[10px] text-muted">
                Pre-filled when adding a new Spark (1–65535)
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs text-muted">Dashboard URL</label>
              <input
                type="text"
                spellCheck={false}
                value={settings.dashboardPath ?? ""}
                onChange={(e) => update({ dashboardPath: e.target.value })}
                placeholder="/dashboard"
                className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 font-mono text-xs text-text outline-none focus:border-accent"
              />
              <p className="mt-1 text-[10px] text-muted">
                Public path for this UI. Use <span className="font-mono">/dashboard</span> when
                reverse-proxied, or <span className="font-mono">/</span> at the site root. Affects
                refresh, back/forward, and deep links.
              </p>
            </div>

            {/* Auto-hide offline */}
            <div>
              <label className="flex items-center gap-3 text-xs text-muted">
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.autoHideOffline}
                  onClick={() => update({ autoHideOffline: !settings.autoHideOffline })}
                  className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                    settings.autoHideOffline ? "is-on" : ""
                  }`}
                >
                  <span
                    className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                      settings.autoHideOffline ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
                Auto-hide offline Sparks on Overview
              </label>
            </div>

            {/* Benchmark debug traces */}
            <div>
              <label className="flex items-start gap-3 text-xs text-muted">
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(settings.benchDebugTraces)}
                  onClick={() =>
                    update({ benchDebugTraces: !settings.benchDebugTraces })
                  }
                  className={`toggle-track relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                    settings.benchDebugTraces ? "is-on" : ""
                  }`}
                >
                  <span
                    className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                      settings.benchDebugTraces ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
                <span>
                  <span className="block text-text">Enable debug traces for Benchmark runs</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-muted">
                    Stores prompts, HTTP/completion IDs, content previews, and GPU
                    samples in bench history. Off by default — larger history files.
                  </span>
                </span>
              </label>
            </div>

            {/* Temperature unit */}
            <div>
              <label className="text-xs text-muted">Temperature unit</label>
              <div className="mt-1.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => update({ temperatureUnit: "celsius" })}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    settings.temperatureUnit === "celsius"
                      ? "bg-accent text-white"
                      : "border border-border bg-surface-elevated text-muted hover:bg-surface-hover"
                  }`}
                >
                  °C
                </button>
                <button
                  type="button"
                  onClick={() => update({ temperatureUnit: "fahrenheit" })}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    settings.temperatureUnit === "fahrenheit"
                      ? "bg-accent text-white"
                      : "border border-border bg-surface-elevated text-muted hover:bg-surface-hover"
                  }`}
                >
                  °F
                </button>
              </div>
            </div>

            {/* Density */}
            <div>
              <label className="flex items-start gap-3 text-xs text-muted">
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.density === "compact"}
                  onClick={() =>
                    update({
                      density: settings.density === "compact" ? "comfortable" : "compact",
                    })
                  }
                  className={`toggle-track relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                    settings.density === "compact" ? "is-on" : ""
                  }`}
                >
                  <span
                    className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                      settings.density === "compact" ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
                <span>
                  <span className="block text-text">Compact UI</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-muted">
                    Tighter spacing, smaller radius, and reduced font size — fits more Sparks on a single screen.
                  </span>
                </span>
              </label>
            </div>

            {/* Overview layout */}
            <div>
              <label className="flex items-start gap-3 text-xs text-muted">
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.overviewLayout === "horizontal"}
                  onClick={() =>
                    update({
                      overviewLayout:
                        settings.overviewLayout === "horizontal" ? "tiled" : "horizontal",
                    })
                  }
                  className={`toggle-track relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                    settings.overviewLayout === "horizontal" ? "is-on" : ""
                  }`}
                >
                  <span
                    className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                      settings.overviewLayout === "horizontal" ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
                <span>
                  <span className="block text-text">Horizontal overview</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-muted">
                    On: one card per row. Off: tiled, three cards per row.
                  </span>
                </span>
              </label>
            </div>

            <section className="border-t border-border pt-5">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-text-strong">AI HAProxy</h3>
                  <p className="mt-1 text-[10px] text-muted">
                    Monitor and explicitly administer the remote AI traffic proxy.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.haproxy.enabled}
                  onClick={() => updateHaproxy({ enabled: !settings.haproxy.enabled })}
                  className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                    settings.haproxy.enabled ? "is-on" : ""
                  }`}
                >
                  <span
                    className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                      settings.haproxy.enabled ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              <label className="mb-4 flex items-start gap-3 text-xs text-muted">
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.haproxy.exportEnabled}
                  onClick={() =>
                    updateHaproxy({ exportEnabled: !settings.haproxy.exportEnabled })
                  }
                  className={`toggle-track relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                    settings.haproxy.exportEnabled ? "is-on" : ""
                  }`}
                >
                  <span
                    className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                      settings.haproxy.exportEnabled ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
                <span>
                  <span className="block text-text">Use HAProxy URLs in config downloads</span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-muted">
                    Enable only after the managed listeners have been applied and verified.
                  </span>
                </span>
              </label>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ["Domain", "domain", "ai.example.com"],
                  ["Remote Docker host", "remoteDockerHost", "proxy.example.com"],
                  ["SSH user", "sshUser", "ubuntu"],
                  ["Docker container", "containerName", "ai-haproxy"],
                  ["Main config path", "mainConfigPath", "/usr/local/etc/haproxy/haproxy.cfg"],
                  ["Managed snippet path", "managedSnippetPath", "/usr/local/etc/haproxy/conf.d/sparkdash.cfg"],
                ].map(([label, key, placeholder]) => (
                  <label key={key} className={key.includes("Path") ? "lg:col-span-2" : ""}>
                    <span className="mb-1 block text-xs text-muted">{label}</span>
                    <input
                      type="text"
                      spellCheck={false}
                      value={String(settings.haproxy[key as keyof HaproxySettings] ?? "")}
                      placeholder={placeholder}
                      onChange={(e) => updateHaproxy({ [key]: e.target.value })}
                      className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 font-mono text-xs text-text outline-none focus:border-accent"
                    />
                  </label>
                ))}
                <label>
                  <span className="mb-1 block text-xs text-muted">SSH port</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={settings.haproxy.sshPort}
                    onChange={(e) => updateHaproxy({ sshPort: Number(e.target.value) })}
                    className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                  />
                </label>
                <label>
                  <span className="mb-1 block text-xs text-muted">Stats port</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={settings.haproxy.statsPort}
                    onChange={(e) => updateHaproxy({ statsPort: Number(e.target.value) })}
                    className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                  />
                </label>
                <label>
                  <span className="mb-1 block text-xs text-muted">SSH authentication</span>
                  <select
                    value={settings.haproxy.sshAuth}
                    onChange={(e) =>
                      updateHaproxy({ sshAuth: e.target.value as "key" | "pass" })
                    }
                    className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                  >
                    <option value="key">SSH key</option>
                    <option value="pass">Password</option>
                  </select>
                </label>
              </div>

              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-muted">Backend mappings</span>
                  <button
                    type="button"
                    onClick={() =>
                      updateHaproxy({
                        backendMappings: [
                          ...settings.haproxy.backendMappings,
                          { name: "", port: 8001, enabled: true },
                        ],
                      })
                    }
                    className="rounded border border-border px-2 py-1 text-[10px] text-accent hover:bg-surface-hover"
                  >
                    + Add mapping
                  </button>
                </div>
                <div className="space-y-2">
                  {settings.haproxy.backendMappings.map((mapping, index) => (
                    <div
                      key={index}
                      className="grid grid-cols-[auto_minmax(0,1fr)_88px_auto] items-center gap-2"
                    >
                      <input
                        type="checkbox"
                        checked={mapping.enabled}
                        aria-label={`Enable ${mapping.name || `mapping ${index + 1}`}`}
                        onChange={(e) => {
                          const next = [...settings.haproxy.backendMappings];
                          next[index] = { ...mapping, enabled: e.target.checked };
                          updateHaproxy({ backendMappings: next });
                        }}
                      />
                      <input
                        value={mapping.name}
                        placeholder="Mapping name"
                        onChange={(e) => {
                          const next = [...settings.haproxy.backendMappings];
                          next[index] = { ...mapping, name: e.target.value };
                          updateHaproxy({ backendMappings: next });
                        }}
                        className="min-w-0 rounded border border-border bg-surface-elevated px-2 py-1.5 text-xs text-text outline-none focus:border-accent"
                        title={
                          mapping.sparkId
                            ? `Targets ${mapping.sparkId}:${mapping.llmPort ?? "primary"}`
                            : "Legacy mapping: targets the named Spark's primary LLM endpoint"
                        }
                      />
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        value={mapping.port}
                        aria-label="Public port"
                        onChange={(e) => {
                          const next = [...settings.haproxy.backendMappings];
                          next[index] = { ...mapping, port: Number(e.target.value) };
                          updateHaproxy({ backendMappings: next });
                        }}
                        className="rounded border border-border bg-surface-elevated px-2 py-1.5 text-xs text-text outline-none focus:border-accent"
                      />
                      <button
                        type="button"
                        aria-label="Remove mapping"
                        onClick={() =>
                          updateHaproxy({
                            backendMappings: settings.haproxy.backendMappings.filter(
                              (_, i) => i !== index
                            ),
                          })
                        }
                        className="px-2 text-danger"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label>
                  <span className="mb-1 block text-xs text-muted">Admin token (this tab only)</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={adminToken}
                    onChange={(e) => storeAdminToken(e.target.value)}
                    className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                  />
                </label>
                <label>
                  <span className="mb-1 block text-xs text-muted">Encrypted SSH password</span>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={haproxyPassword}
                      placeholder="Blank keeps current"
                      onChange={(e) => setHaproxyPasswordValue(e.target.value)}
                      className="min-w-0 flex-1 rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      disabled={haproxyBusy != null}
                      onClick={() => void handleHaproxyPassword()}
                      className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-accent hover:bg-surface-hover disabled:opacity-50"
                    >
                      {haproxyBusy === "password" ? "Saving…" : "Save Password"}
                    </button>
                  </div>
                </label>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={haproxyBusy != null}
                  onClick={() => void handleHaproxyTest()}
                  className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-accent hover:bg-surface-hover disabled:opacity-50"
                >
                  {haproxyBusy === "test" ? "Testing…" : "Test Connection"}
                </button>
                <span className="text-[10px] text-muted">
                  Test uses the currently saved HAProxy settings.
                </span>
                {haproxyMessage && (
                  <span className={`text-xs ${haproxyMessage.ok ? "text-success" : "text-danger"}`}>
                    {haproxyMessage.text}
                  </span>
                )}
              </div>
            </section>
          </div>
        )}

        {/* Links */}
        <div className="mt-5 flex items-center gap-3 border-t border-border pt-3">
          <span className="text-[10px] text-muted">sparkDash v1.3.0</span>
          <span className="text-border-strong text-[10px]">·</span>
          <a
            href="https://x.com/MiaAI_lab"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-muted hover:text-accent transition-colors"
          >
            𝕏 @MiaAI_lab
          </a>
          <span className="text-border-strong text-[10px]">·</span>
          <a
            href="https://github.com/MiaAI-Lab"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-muted hover:text-accent transition-colors"
          >
            GitHub MiaAI-Lab
          </a>
        </div>

        {error && (
          <div className="mt-3 rounded bg-danger/20 px-3 py-2 text-xs text-danger">{error}</div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !settings || !dirty}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
