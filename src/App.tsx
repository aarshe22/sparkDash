import { useState, useCallback, useEffect, useMemo } from "react";
import { useSnapshot } from "./hooks/useSnapshot";
import { useAppRoute, useRoute } from "./hooks/useRoute";
import { fetchSparks, reorderSparks, fetchSettings, updateSettings } from "./api/client";
import { SparkTabs } from "./components/SparkTabs";
import { AddSparkDialog } from "./components/AddSparkDialog";
import { EditSparkDialog } from "./components/EditSparkDialog";
import { SparkPage } from "./components/SparkPage/SparkPage";
import { OverviewPage } from "./components/OverviewPage/OverviewPage";
import { ShowcasePage } from "./components/ShowcasePage/ShowcasePage";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { SettingsDialog } from "./components/SettingsDialog";
import { ConfigPreviewDialog } from "./components/ConfigPreviewDialog";
import { GearIcon, BoltIcon, DownloadIcon, PlusIcon } from "./components/ui/icons";
import { OVERVIEW_ID } from "./constants";
import { buildGrokConfigToml, buildOpencodeConfig } from "./lib/opencodeConfig";
import { liveMonitoredModels } from "./lib/llmEndpoints";
import { setDashboardPath } from "./lib/dashboardPath";
import { readHaproxyAdminToken } from "./lib/haproxyAdminToken";
import {
  endpointMappingName,
  findHaproxyMappingIndex,
} from "./lib/haproxyMappings";
import type { Settings, SparkSnapshot } from "./api/types";

function placeholderSnapshot(
  id: string,
  name: string,
  disabledDevices: string[] = [],
  disabledInterfaces: string[] = [],
  llmPorts: number[] = [8888],
  roleFields?: {
    role?: SparkSnapshot["role"];
    workerNode?: boolean;
    workerLabel?: string | null;
    workerHeadId?: string | null;
    llmMonitoring?: boolean;
    llmEngine?: SparkSnapshot["llmEngine"];
  }
): SparkSnapshot {
  const role =
    roleFields?.role === "head" ||
    roleFields?.role === "worker" ||
    roleFields?.role === "standalone"
      ? roleFields.role
      : roleFields?.workerNode
        ? "worker"
        : "standalone";
  const workerNode = role === "worker";
  return {
    id,
    name,
    online: false,
    uptime: null,
    disabledDevices,
    disabledInterfaces,
    llmPort: llmPorts[0] ?? 8888,
    llmPorts,
    workerNode,
    role,
    workerLabel: workerNode ? roleFields?.workerLabel ?? null : null,
    workerHeadId: workerNode ? roleFields?.workerHeadId ?? null : null,
    llmMonitoring:
      role === "worker"
        ? false
        : role === "head"
          ? true
          : roleFields?.llmMonitoring !== false,
    llmEngine: role === "worker" ? "auto" : roleFields?.llmEngine ?? "auto",
    hardware: {
      device: "NVIDIA DGX Spark",
      cpuModel: "…",
      cpuCores: 0,
      totalMemoryGB: 0,
      gpuChip: "…",
      cudaDriver: null,
      storageModel: null,
    },
    metrics: {
      gpu: null,
      cpu: null,
      ram: null,
      storage: [],
      network: null,
      unifiedMemory: null,
      llm: [],
    },
  };
}

function DashboardApp() {
  const { sparks, activeId, setActiveId, activeSpark, connected, haproxy } = useSnapshot();
  const navigate = useRoute(setActiveId);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [configPreview, setConfigPreview] = useState<{
    filename: string;
    content: string;
    mimeType: string;
  } | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  /** Used when WS is down so add/delete still updates the tab bar */
  const [fallbackSparks, setFallbackSparks] = useState<SparkSnapshot[]>([]);

  // Prefer live WS data; fall back to API-fetched list when empty
  const liveSparks = sparks.length > 0 ? sparks : fallbackSparks;
  /** Optimistic tab order while drag-save races the next WS snapshot */
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const [headerActionsEl, setHeaderActionsEl] = useState<HTMLDivElement | null>(null);

  const displaySparks = useMemo(() => {
    if (!orderOverride?.length) return liveSparks;
    const map = new Map(liveSparks.map((s) => [s.id, s]));
    const ordered: SparkSnapshot[] = [];
    for (const id of orderOverride) {
      const s = map.get(id);
      if (s) {
        ordered.push(s);
        map.delete(id);
      }
    }
    for (const s of map.values()) ordered.push(s);
    return ordered;
  }, [liveSparks, orderOverride]);

  // Drop override once server/WS order matches
  useEffect(() => {
    if (!orderOverride) return;
    const live = liveSparks.map((s) => s.id).join("\0");
    if (live === orderOverride.join("\0")) setOrderOverride(null);
  }, [liveSparks, orderOverride]);

  const isOverview = activeId === OVERVIEW_ID;
  const displayActive = isOverview
    ? null
    : displaySparks.find((s) => s.id === activeId) || displaySparks[0] || activeSpark || null;

  useEffect(() => {
    if (sparks.length > 0) setFallbackSparks([]);
  }, [sparks]);

  // Fetch global settings on mount
  useEffect(() => {
    fetchSettings()
      .then(setSettings)
      .catch((err) => console.error("Failed to fetch settings:", err));
  }, []);

  const handleSettingsSaved = useCallback((s: Settings) => {
    setSettings(s);
  }, []);

  const handleOverviewLayoutChange = useCallback((layout: "grid" | "rows") => {
    const overviewLayout = layout === "rows" ? "horizontal" : "tiled";
    void updateSettings({ overviewLayout })
      .then(setSettings)
      .catch((err) => console.error("Failed to save overview layout:", err));
  }, []);

  const handleHaproxyPortChange = useCallback(
    async (spark: SparkSnapshot, llmPort: number, targetLlmPort: number, publicPort: number) => {
      if (!settings) throw new Error("HAProxy settings are still loading.");
      if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
        throw new Error("HAProxy public port must be an integer 1–65535.");
      }
      const token = readHaproxyAdminToken().trim();
      if (!token) {
        throw new Error("Enter the HAProxy admin token in Settings before saving this mapping.");
      }
      const mappings = settings.haproxy.backendMappings.map((mapping) => ({ ...mapping }));
      const index = findHaproxyMappingIndex(settings.haproxy, spark, llmPort);
      const selected = index >= 0 ? mappings[index] : null;
      if (
        mappings.some(
          (mapping, mappingIndex) =>
            mappingIndex !== index && mapping.enabled && mapping.port === publicPort
        )
      ) {
        throw new Error(`Public port ${publicPort} is already used by another enabled mapping.`);
      }
      const nextMapping = {
        ...(selected ?? {
          name: endpointMappingName(spark, targetLlmPort),
          enabled: true,
        }),
        port: publicPort,
        sparkId: spark.id,
        llmPort: targetLlmPort,
      };
      if (index >= 0) mappings[index] = nextMapping;
      else mappings.push(nextMapping);
      try {
        const result = await updateSettings(
          { haproxy: { ...settings.haproxy, backendMappings: mappings } },
          token
        );
        setSettings(result);
      } catch (error) {
        if (error instanceof Error && /unauthorized|401/i.test(error.message)) {
          throw new Error("The saved HAProxy admin token is invalid. Update it in Settings.");
        }
        throw error;
      }
    },
    [settings]
  );

  // Apply layout density (comfortable/compact) from persisted settings.
  useEffect(() => {
    if (settings?.density) {
      document.documentElement.setAttribute("data-density", settings.density);
    }
  }, [settings?.density]);

  useEffect(() => {
    if (settings?.dashboardPath == null) return;
    setDashboardPath(settings.dashboardPath);
  }, [settings?.dashboardPath]);

  const refreshFromApi = useCallback(async () => {
    try {
      const { sparks: configs } = await fetchSparks();
      setFallbackSparks(
        configs.map((c) => {
          const existing = sparks.find((s) => s.id === c.id);
          if (existing) {
            // Keep live metrics, but never let a stale WS snapshot override
            // role fields that were just saved via the API.
            return {
              ...existing,
              name: c.name,
              role: c.role ?? existing.role,
              workerNode: c.workerNode ?? existing.workerNode,
              workerLabel: c.workerLabel ?? existing.workerLabel,
              workerHeadId: c.workerHeadId ?? existing.workerHeadId,
              llmMonitoring: c.llmMonitoring ?? existing.llmMonitoring,
              llmEngine: c.llmEngine ?? existing.llmEngine,
              disabledDevices: c.disabledDevices || existing.disabledDevices,
              disabledInterfaces: c.disabledInterfaces || existing.disabledInterfaces,
              llmPorts: c.llmPorts ?? existing.llmPorts,
              llmPort: c.llmPorts?.[0] ?? c.llmPort ?? existing.llmPort,
            };
          }
          return placeholderSnapshot(
            c.id,
            c.name,
            c.disabledDevices || [],
            c.disabledInterfaces || [],
            c.llmPorts ?? (c.llmPort ? [c.llmPort] : [8888]),
            {
              role: c.role,
              workerNode: c.workerNode,
              workerLabel: c.workerLabel,
              workerHeadId: c.workerHeadId,
              llmMonitoring: c.llmMonitoring,
              llmEngine: c.llmEngine,
            }
          );
        })
      );
      if (configs.length && activeId !== OVERVIEW_ID && !configs.some((c) => c.id === activeId)) {
        setActiveId(configs[0].id);
      }
      if (configs.length === 0 && activeId !== OVERVIEW_ID) setActiveId(null);
    } catch (err) {
      console.error("Failed to refresh sparks:", err);
    }
  }, [sparks, activeId, setActiveId]);

  const handleReorder = useCallback(async (orderedIds: string[]) => {
    setOrderOverride(orderedIds);
    try {
      await reorderSparks(orderedIds);
    } catch (err) {
      console.error("Failed to reorder Sparks:", err);
      setOrderOverride(null);
    }
  }, []);

  const liveOpencodeCount = useMemo(() => liveMonitoredModels(displaySparks).length, [displaySparks]);
  const handlePreviewOpencode = useCallback(() => {
    setConfigPreview({
      filename: "opencode.json",
      content: `${JSON.stringify(buildOpencodeConfig(displaySparks, settings?.haproxy), null, 2)}\n`,
      mimeType: "application/json",
    });
  }, [displaySparks, settings?.haproxy]);
  const handlePreviewGrok = useCallback(() => {
    setConfigPreview({
      filename: "config.toml",
      content: buildGrokConfigToml(displaySparks, settings?.haproxy),
      mimeType: "application/toml",
    });
  }, [displaySparks, settings?.haproxy]);

  return (
    <div className="min-h-screen p-0 text-text sm:p-8">
      <div className="dashboard-shell">
        <header className="dashboard-header" style={{ marginBottom: "var(--density-header-gap)" }}>
          <div className="logo-brand">
            <button
              type="button"
              onClick={() => navigate(OVERVIEW_ID)}
              className="logo-pill"
            >
              <BoltIcon className="h-3.5 w-3.5 text-accent" />
              <span>
                spark<span className="logo-pill-dash">Dash</span>
              </span>
            </button>
            <button
              type="button"
              className="opencode-download"
              onClick={handlePreviewOpencode}
              disabled={liveOpencodeCount === 0}
              title={
                liveOpencodeCount === 0
                  ? "No live monitored models to export"
                  : `Download OpenCode config for ${liveOpencodeCount} live model${liveOpencodeCount === 1 ? "" : "s"}`
              }
              aria-label="Download opencode.json"
            >
              <DownloadIcon className="h-3.5 w-3.5" />
              <span>opencode.json</span>
              {liveOpencodeCount > 0 ? (
                <span className="opencode-download-count">{liveOpencodeCount}</span>
              ) : null}
            </button>
            <button
              type="button"
              className="opencode-download"
              onClick={handlePreviewGrok}
              disabled={liveOpencodeCount === 0}
              title={
                liveOpencodeCount === 0
                  ? "No live monitored models to export"
                  : `Download Grok Build config.toml for ${liveOpencodeCount} live model${liveOpencodeCount === 1 ? "" : "s"}`
              }
              aria-label="Download Grok Build config.toml"
            >
              <DownloadIcon className="h-3.5 w-3.5" />
              <span>config.toml</span>
              {liveOpencodeCount > 0 ? (
                <span className="opencode-download-count">{liveOpencodeCount}</span>
              ) : null}
            </button>
          </div>
          {!isOverview && (
            <SparkTabs
              sparks={displaySparks}
              activeId={displayActive?.id ?? activeId}
              onSelect={navigate}
              onAdd={() => setShowAdd(true)}
              onEdit={(id) => setEditId(id)}
              onReorder={handleReorder}
            />
          )}
          {isOverview && <div ref={setHeaderActionsEl} className="dashboard-header-actions" />}
          <div className="ml-auto flex items-center gap-2.5">
            {isOverview && (
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                title="Add Spark"
                aria-label="Add Spark"
                className="icon-circle"
              >
                <PlusIcon className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="icon-circle"
              title="Settings"
              aria-label="Settings"
            >
              <GearIcon className="h-4 w-4" />
            </button>
            <ThemeSwitch />
          </div>
        </header>
        <main>
          {isOverview ? (
            <OverviewPage
              sparks={displaySparks}
              hideOffline={settings?.autoHideOffline ?? false}
              temperatureUnit={settings?.temperatureUnit ?? "celsius"}
              onSelectSpark={navigate}
              headerActionsSlot={headerActionsEl}
              defaultLayout={
                !settings
                  ? undefined
                  : settings.overviewLayout === "horizontal"
                    ? "rows"
                    : "grid"
              }
              onLayoutChange={handleOverviewLayoutChange}
              haproxySettings={settings?.haproxy}
              haproxyStatus={haproxy}
            />
          ) : displayActive ? (
            <SparkPage
              spark={displayActive}
              temperatureUnit={settings?.temperatureUnit ?? "celsius"}
              onEdit={() => setEditId(displayActive.id)}
              haproxySettings={settings?.haproxy}
              onHaproxyPortChange={handleHaproxyPortChange}
            />
          ) : (
            <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
              <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
                <span className="text-lg leading-none">+</span>
              </div>
              <h2 className="text-sm font-semibold text-text-strong">No Spark registered</h2>
              <p className="mt-1 text-xs text-muted">
                Click the&nbsp;
                <span className="rounded border border-border bg-surface-elevated px-1 py-0.5 text-text">+</span>
                &nbsp;tab to add a DGX Spark unit.
              </p>
            </div>
          )}
        </main>
      </div>
      <AddSparkDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={() => {
          void refreshFromApi();
        }}
        defaultLlmPort={settings?.defaultLlmPort ?? 8888}
      />
      <EditSparkDialog
        open={editId != null}
        sparkId={editId}
        onClose={() => setEditId(null)}
        onSaved={() => {
          void refreshFromApi();
        }}
        onDeleted={(id) => {
          if (activeId === id) {
            const next = displaySparks.find((s) => s.id !== id);
            navigate(next?.id ?? OVERVIEW_ID);
          }
          void refreshFromApi();
        }}
      />
      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
        onSaved={handleSettingsSaved}
      />
      <ConfigPreviewDialog
        open={configPreview != null}
        filename={configPreview?.filename ?? ""}
        content={configPreview?.content ?? ""}
        mimeType={configPreview?.mimeType ?? "text/plain"}
        onClose={() => setConfigPreview(null)}
      />
    </div>
  );
}

function App() {
  const route = useAppRoute();
  if (route.mode === "showcase" && route.showcaseSparkId) {
    return <ShowcasePage sparkId={route.showcaseSparkId} />;
  }
  return <DashboardApp />;
}

export default App;
