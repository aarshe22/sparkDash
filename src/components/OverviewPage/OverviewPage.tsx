import { useEffect, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { isLlmMonitoringEnabled, resolveSparkRole } from "../../api/sparkRole";
import { shutdownAllSparks, wakeAllSparks } from "../../api/client";
import { MetricBar } from "../ui/MetricBar";
import { ActivityIcon, GridIcon, PowerOffIcon, PowerOnIcon, RowsIcon } from "../ui/icons";
import { formatContextLength, sparkLlmEndpoints } from "../../lib/llmEndpoints";

const OVERVIEW_LAYOUT_KEY = "sparkdash.ui.overviewLayout";

type OverviewLayout = "grid" | "rows";

function readOverviewLayout(): OverviewLayout {
  try {
    const raw = localStorage.getItem(OVERVIEW_LAYOUT_KEY);
    if (raw === "rows" || raw === "grid") return raw;
  } catch {
    /* private mode / blocked storage */
  }
  return "grid";
}

function writeOverviewLayout(layout: OverviewLayout) {
  try {
    localStorage.setItem(OVERVIEW_LAYOUT_KEY, layout);
  } catch {
    /* ignore */
  }
}

interface OverviewPageProps {
  sparks: SparkSnapshot[];
  hideOffline?: boolean;
  temperatureUnit?: "celsius" | "fahrenheit";
  onSelectSpark?: (id: string) => void;
  defaultLayout?: OverviewLayout;
  onLayoutChange?: (layout: OverviewLayout) => void;
}

function celsiusToFahrenheit(c: number): number {
  return Math.round(c * 9 / 5 + 32);
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Format a storage value in MB, stripping trailing ".0" and optionally omitting the unit. */
function fmtStorage(mb: number, unit: boolean): string {
  const val = mb >= 1024 ? mb / 1024 : mb;
  const label = mb >= 1024 ? "GB" : "MB";
  const s = val.toFixed(1).replace(/\.0$/, "");
  return unit ? `${s} ${label}` : s;
}

/** Split "GX10A — NEMOTRON 3.5 30B" into host + model for a two-line card title. */
function splitHostModel(name: string): { host: string; model: string | null } {
  const em = name.match(/^(.*?)\s*[—–]\s*(.+)$/);
  if (em) return { host: em[1].trim(), model: em[2].trim() };
  const hyphen = name.match(/^(.*?)\s+-\s+(.+)$/);
  if (hyphen) return { host: hyphen[1].trim(), model: hyphen[2].trim() };
  return { host: name, model: null };
}

function CardTitle({
  name,
  sparkId,
  onSelect,
}: {
  name: string;
  sparkId: string;
  onSelect?: (id: string) => void;
}) {
  const { host, model } = splitHostModel(name);
  const inner = (
    <>
      <span className="overview-card-host">{host}</span>
      {model ? <span className="overview-card-model">{model}</span> : null}
    </>
  );
  if (onSelect) {
    return (
      <button
        type="button"
        onClick={() => onSelect(sparkId)}
        className="overview-card-title"
        title={name}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className="overview-card-title" title={name}>
      {inner}
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone = "default",
  bold = true,
  title,
}: {
  label: string;
  value: string;
  tone?: "default" | "accent" | "warning" | "danger" | "success";
  bold?: boolean;
  title?: string;
}) {
  const toneClass =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : tone === "accent"
          ? "text-accent"
          : tone === "success"
            ? "text-success"
            : "text-text";
  return (
    <div className="overview-mini-stat">
      <span className="overview-mini-stat-label text-[10px] tracking-wide text-muted">{label}</span>
      <span
        className={`overview-mini-stat-value font-tabular text-[13px] ${bold ? "font-semibold" : ""} ${toneClass}`}
        title={title ?? value}
      >
        {value}
      </span>
    </div>
  );
}

function SparkCard({
  spark,
  headSparkName,
  temperatureUnit,
  onSelect,
  layout,
}: {
  spark: SparkSnapshot;
  headSparkName?: string | null;
  temperatureUnit: "celsius" | "fahrenheit";
  onSelect?: (id: string) => void;
  layout: OverviewLayout;
}) {
  const horizontal = layout === "rows";
  const gpu = spark.metrics.gpu;
  const um = spark.metrics.unifiedMemory;
  const online = spark.online;

  const usage = gpu?.usage ?? 0;
  const tempRaw = gpu?.temperature ?? 0;
  const displayTemp = temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(tempRaw) : tempRaw;
  const tempLabel = temperatureUnit === "fahrenheit" ? `${displayTemp}°F` : `${displayTemp}°C`;
  const vramPct = gpu?.vram?.percentage ?? um?.percentage ?? 0;
  const vramUsed = gpu?.vram?.used ?? um?.used ?? 0;
  const vramTotal = gpu?.vram?.total ?? um?.total ?? 0;
  const vramAvail = gpu?.vram?.available ?? um?.available ?? 0;

  // Temperature bar: cool → success, warm → warning, hot → danger
  const tempBarColor =
    tempRaw > 85 ? "bg-danger" : tempRaw > 65 ? "bg-warning" : tempRaw > 40 ? "bg-accent" : "bg-success";
  // Usage bar: accent for moderate, warning high, danger critical
  const usageBarColor = usage > 85 ? "bg-danger" : usage > 60 ? "bg-warning" : "bg-accent";
  // VRAM allocation: accent normal → warning/danger as it fills
  const vramBarColor = vramPct > 85 ? "bg-danger" : vramPct > 60 ? "bg-warning" : "bg-accent";

  return (
    <div
      className={`overview-card ${horizontal ? "overview-card--row" : "flex flex-col"}`}
      style={{
        padding: "var(--density-card-pad)",
        gap: "var(--density-card-gap)",
        ...(online ? {} : { opacity: 0.6 }),
      }}
    >
      {/* Card header */}
      <div className="overview-card-head flex items-start gap-2.5">
        <span
          className={`mt-[6px] h-2 w-2 shrink-0 rounded-full ${online ? "bg-success dot-glow-success" : "bg-danger"}`}
        />
        <div className="min-w-0 flex-1">
          <CardTitle name={spark.name} sparkId={spark.id} onSelect={onSelect} />
        </div>
        <span className="mt-[5px] text-[10px] uppercase tracking-wide text-muted">
          {online ? "online" : "offline"}
        </span>
      </div>

      {!online || !gpu ? (
        <div className="flex h-[120px] items-center justify-center">
          <span className="text-[13px] text-muted">
            {online ? "Waiting for metrics…" : "Host unreachable"}
          </span>
        </div>
      ) : (
        <>
          {/* Three headline bars: GPU alloc, Temp, Usage */}
          <div className={horizontal ? "overview-card-bars" : "flex flex-col gap-3.5"}>
            <MetricBar
              label="VRAM"
              value={vramUsed}
              max={vramTotal}
              color={vramBarColor}
              caption={vramTotal > 0 ? `${fmtStorage(vramUsed, false)} / ${fmtStorage(vramTotal, true)}` : "—"}
            />
            <MetricBar
              label="Temperature"
              value={displayTemp}
              max={temperatureUnit === "fahrenheit" ? 212 : 100}
              color={tempBarColor}
              caption={tempLabel}
            />
            <MetricBar
              label="Usage"
              value={usage}
              max={100}
              color={usageBarColor}
              caption={`${usage}%`}
            />
          </div>

          {/* Secondary stats */}
          <div
            className={
              horizontal ? "overview-card-stats" : "overview-stats overview-stats--stacked"
            }
          >
            <MiniStat
              label="GPU Power"
              value={`${gpu?.power?.draw ?? 0}W / ${gpu?.power?.limit ?? 0}W`}
            />
            {vramAvail > 0 && (
              <MiniStat
                label="Available"
                value={formatMb(vramAvail)}
                tone={vramAvail < 4096 ? "danger" : vramAvail < 16384 ? "warning" : "accent"}
              />
            )}
            {(() => {
              // Find the root disk by label "/" (the collector maps the host
              // root mount to that label). Fall back to the GB10 partition name
              // so the overview keeps working where labels aren't populated.
              const rootDisk =
                spark.metrics.storage.find((d) => d.label === "/") ??
                spark.metrics.storage.find((d) => d.device === "nvme0n1p2");
              if (rootDisk) {
                return (
                  <MiniStat
                    label="Storage"
                    value={`${fmtStorage(rootDisk.used, false)} / ${fmtStorage(rootDisk.total, true)}`}
                    tone={rootDisk.percentage > 85 ? "danger" : rootDisk.percentage > 60 ? "warning" : "default"}
                    bold={false}
                  />
                );
              }
              return null;
            })()}
            {(() => {
              const role = resolveSparkRole(spark);

              // Workers have no local LLM API — show cluster/model label instead.
              if (role === "worker") {
                const label = spark.workerLabel?.trim() || "distributed";
                const title = headSparkName
                  ? `${label} · worker of ${headSparkName}`
                  : `${label} · distributed LLM worker`;
                return (
                  <MiniStat
                    label="Worker"
                    value={label}
                    tone="accent"
                    title={title}
                  />
                );
              }

              // Head / Standalone: live backend + model id.
              if (!isLlmMonitoringEnabled(spark)) return null;
              const llm = sparkLlmEndpoints(spark).find((l) => l.available);
              if (!llm) return null;
              return (
                <MiniStat
                  label={llm.backend === "vllm" ? "vLLM" : llm.backend ?? "LLM"}
                  value={llm.modelId ?? "unknown"}
                  tone="accent"
                  title={llm.modelId ?? undefined}
                />
              );
            })()}
          </div>

          {(() => {
            if (!isLlmMonitoringEnabled(spark)) return null;
            const rows = sparkLlmEndpoints(spark);
            if (rows.length === 0) return null;
            return (
              <div
                className={
                  horizontal
                    ? "overview-card-ports"
                    : "mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border pt-3.5"
                }
              >
                {rows.map((row) => (
                  <div key={row.port} className="contents">
                    <MiniStat
                      label="Port"
                      value={`:${row.port}`}
                      tone={row.available ? "accent" : "default"}
                      title={`LLM HTTP port ${row.port}${row.available ? " (live)" : " (not reachable)"}`}
                    />
                    <MiniStat
                      label="Context"
                      value={formatContextLength(row.contextLength)}
                      title={
                        row.contextLength
                          ? `${row.contextLength.toLocaleString()} token context window`
                          : "Context length unknown"
                      }
                      bold={false}
                    />
                  </div>
                ))}
              </div>
            );
          })()}

          {(() => {
            const llm = sparkLlmEndpoints(spark).find((l) => l.available);
            if (!llm) return null;
            return (
              <div
                className={
                  horizontal
                    ? "overview-card-tps"
                    : "mt-3.5 border-t border-border pt-3 text-center"
                }
              >
                <span className="overview-card-tps-value font-tabular text-[28px] font-bold leading-none text-text-strong">
                  {llm.generationTps.toFixed(0)}
                </span>
                <span className="text-sm font-normal text-muted"> tok/s</span>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

export function OverviewPage({
  sparks,
  hideOffline = false,
  temperatureUnit = "celsius",
  onSelectSpark,
  defaultLayout,
  onLayoutChange,
}: OverviewPageProps) {
  const visibleSparks = hideOffline ? sparks.filter((s) => s.online) : sparks;
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchMsg, setBatchMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [layout, setLayout] = useState<OverviewLayout>(defaultLayout ?? readOverviewLayout);

  useEffect(() => {
    if (defaultLayout) setLayout(defaultLayout);
  }, [defaultLayout]);

  function changeLayout(next: OverviewLayout) {
    setLayout(next);
    writeOverviewLayout(next);
    onLayoutChange?.(next);
  }

  async function handleShutdownAll() {
    const onlineCount = sparks.filter((s) => s.online).length;
    if (onlineCount === 0) return;
    if (!confirm(`Gracefully shut down all ${onlineCount} online Spark(s)? Offline nodes will be skipped.`)) {
      return;
    }
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await shutdownAllSparks();
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok && !r.skipped).length;
      const skipped = res.results.filter((r) => r.skipped).length;
      const parts = [`${ok} shut down`];
      if (fail) parts.push(`${fail} failed`);
      if (skipped) parts.push(`${skipped} skipped`);
      setBatchMsg({
        text: parts.join(", "),
        tone: fail === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : "Batch shutdown failed",
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  async function handleWakeAll() {
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await wakeAllSparks();
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok).length;
      setBatchMsg({
        text: fail === 0 ? `${ok} wake packet(s) sent` : `${ok} sent, ${fail} failed`,
        tone: fail === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : "Batch wake failed",
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  if (visibleSparks.length === 0) {
    const allOffline = hideOffline && sparks.length > 0;
    return (
      <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <ActivityIcon className="h-5 w-5" />
        </div>
        <h2 className="text-sm font-semibold text-text-strong">
          {allOffline ? "All Sparks are offline" : "No Sparks registered"}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {allOffline
            ? "Auto-hide is enabled and no Sparks are currently online."
            : "Click the + tab to add a DGX Spark unit."}
        </p>
      </div>
    );
  }

  const onlineCount = visibleSparks.filter((s) => s.online).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-overview-rhythm)" }}>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex items-center gap-3">
          {batchMsg && (
            <span className={`text-[11px] ${batchMsg.tone === "ok" ? "text-success" : "text-danger"}`}>
              {batchMsg.text}
            </span>
          )}
          {sparks.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="overview-layout-toggle" role="group" aria-label="Overview card layout">
                <button
                  type="button"
                  className={layout === "grid" ? "is-active" : ""}
                  onClick={() => changeLayout("grid")}
                  title="Vertical cards · 3 per row"
                  aria-pressed={layout === "grid"}
                  aria-label="Vertical cards, 3 per row"
                >
                  <GridIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className={layout === "rows" ? "is-active" : ""}
                  onClick={() => changeLayout("rows")}
                  title="Horizontal cards · 1 per row"
                  aria-pressed={layout === "rows"}
                  aria-label="Horizontal cards, 1 per row"
                >
                  <RowsIcon className="h-3.5 w-3.5" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => void handleWakeAll()}
                disabled={batchLoading}
                title="Wake all Sparks that have a MAC configured (WoL)"
                className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted hover:bg-success/20 hover:text-success transition-colors disabled:opacity-50"
              >
                <PowerOnIcon className="h-3 w-3" />
                Wake All
              </button>
              <button
                type="button"
                onClick={() => void handleShutdownAll()}
                disabled={batchLoading || !sparks.some((s) => s.online)}
                title="Shut down all online Sparks"
                className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted hover:bg-danger/20 hover:text-danger transition-colors disabled:opacity-50"
              >
                <PowerOffIcon className="h-3 w-3" />
                Shutdown All
              </button>
            </div>
          )}
          <span className="online-chip">
            <span className="dot" />
            {onlineCount}/{visibleSparks.length} online
          </span>
        </div>
      </div>
      <div
        className={
          layout === "rows"
            ? "overview-page is-rows grid grid-cols-1"
            : "overview-page grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
        }
        style={{ gap: "var(--density-page-gap)" }}
      >
        {visibleSparks.map((spark) => (
          <SparkCard
            key={spark.id}
            spark={spark}
            headSparkName={
              spark.workerHeadId
                ? sparks.find((s) => s.id === spark.workerHeadId)?.name ?? null
                : null
            }
            temperatureUnit={temperatureUnit}
            onSelect={onSelectSpark}
            layout={layout}
          />
        ))}
      </div>
    </div>
  );
}