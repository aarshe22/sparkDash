import { useState } from "react";
import type { NetworkInterface, NetworkMetrics } from "../../api/types";
import { updateDisabledInterfaces } from "../../api/client";
import { Panel } from "../ui/Panel";
import { Sparkline } from "../ui/Sparkline";
import { NetworkIcon, GearIcon } from "../ui/icons";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";

interface NetworkPanelProps {
  network: NetworkMetrics | null;
  sparkId: string;
  disabledInterfaces: string[];
  onDisabledChange: (interfaces: string[]) => void;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 * 1024 * 1024) return `${(bytesPerSec / 1024 / 1024 / 1024).toFixed(1)} GB/s`;
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${bytesPerSec} B/s`;
}

function formatUtil(pct: number): string {
  if (pct < 0.05) return "0%";
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function ifaceSpeed(iface: NetworkInterface, fallback: number | null): number | null {
  const speed = iface.speedMbps ?? fallback;
  return speed && speed > 0 ? speed : null;
}

function ifaceUtil(iface: NetworkInterface, fallback: number | null): number | null {
  const speed = ifaceSpeed(iface, fallback);
  if (!speed) return null;
  const bits = Math.max(iface.rxSpeed, iface.txSpeed) * 8;
  return Math.min(100, (bits / (speed * 1_000_000)) * 100);
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-border"
      }`}
      aria-pressed={checked}
    >
      <span
        className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-3.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function MonitoredInterface({
  sparkId,
  iface,
  isPrimary,
  fallbackSpeed,
}: {
  sparkId: string;
  iface: NetworkInterface;
  isPrimary: boolean;
  fallbackSpeed: number | null;
}) {
  const utilHist = useMetricsHistoryTail(sparkId, `net.${iface.name}.util`);
  const speed = ifaceSpeed(iface, isPrimary ? fallbackSpeed : iface.speedMbps ?? null);
  const util = ifaceUtil(iface, speed);
  const down = iface.operstate !== "up";

  return (
    <div
      className={`network-iface rounded-md border px-3 py-2.5 ${
        isPrimary ? "border-accent/40 bg-accent-soft" : "border-border bg-surface-elevated"
      }`}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-medium text-text-strong">{iface.name}</span>
            {isPrimary && (
              <span className="shrink-0 rounded bg-accent-soft px-1 text-[9px] font-medium uppercase tracking-wide text-accent">
                primary
              </span>
            )}
            {down && (
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                {iface.operstate || "down"}
              </span>
            )}
          </div>
          {iface.ip ? (
            <div className="font-tabular truncate text-[11px] text-muted">{iface.ip}</div>
          ) : (
            <div className="text-[11px] text-muted">No IPv4 address</div>
          )}
        </div>
        {speed != null && <span className="chip shrink-0 py-0.5">{speed} Mbps</span>}
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted">Utilization</span>
        <div className="flex min-w-0 items-center gap-2">
          <Sparkline data={utilHist} color="var(--color-accent)" width={140} height={22} />
          <span className="font-tabular w-12 text-right text-[13px] font-semibold text-text-strong">
            {util != null ? formatUtil(util) : "—"}
          </span>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between font-tabular text-[11px] text-text">
        <span>
          <span className="text-accent">↑</span> {formatSpeed(iface.txSpeed)}
        </span>
        <span>
          <span className="text-accent">↓</span> {formatSpeed(iface.rxSpeed)}
        </span>
      </div>
    </div>
  );
}

export function NetworkPanel({
  network,
  sparkId,
  disabledInterfaces,
  onDisabledChange,
}: NetworkPanelProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);

  const interfaces = network?.interfaces ?? [];
  const primary = network?.primaryInterface ?? null;
  const linkSpeed = network?.linkSpeedMbps ?? null;

  const handleToggle = async (name: string, disabled: boolean) => {
    const next = disabled
      ? [...new Set([...disabledInterfaces, name])]
      : disabledInterfaces.filter((n) => n !== name);

    setSaving(true);
    try {
      await updateDisabledInterfaces(sparkId, next);
      onDisabledChange(next);
    } catch (err) {
      console.error("Failed to update disabled interfaces:", err);
    } finally {
      setSaving(false);
    }
  };

  const visible = interfaces
    .filter((iface) => !iface.disabled && !disabledInterfaces.includes(iface.name))
    .sort((a, b) => {
      if (a.name === primary) return -1;
      if (b.name === primary) return 1;
      return a.name.localeCompare(b.name);
    });

  return (
    <Panel
      title="Network"
      accent
      icon={<NetworkIcon />}
      className="panel-network"
      actions={
        <button
          type="button"
          title={showSettings ? "Done" : "Interface settings"}
          onClick={() => setShowSettings(!showSettings)}
          disabled={saving}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-hover disabled:opacity-50 ${
            showSettings ? "bg-surface-elevated text-text" : ""
          }`}
        >
          <GearIcon />
          <span>{showSettings ? "Done" : "Settings"}</span>
        </button>
      }
    >
      {showSettings ? (
        <div className="space-y-2">
          <p className="mb-1 text-[10px] text-muted">Toggle adapters to monitor:</p>
          {interfaces.length === 0 ? (
            <p className="text-xs text-muted">No interfaces discovered</p>
          ) : (
            interfaces.map((iface) => {
              const isDisabled =
                iface.disabled === true || disabledInterfaces.includes(iface.name);
              return (
                <div
                  key={iface.name}
                  className="flex items-center justify-between rounded-md border border-border bg-surface-elevated px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-xs text-text">{iface.name}</span>
                    {primary === iface.name && (
                      <span className="shrink-0 rounded bg-accent-soft px-1 text-[9px] font-medium uppercase tracking-wide text-accent">
                        primary
                      </span>
                    )}
                  </div>
                  <Toggle checked={!isDisabled} onChange={(on) => handleToggle(iface.name, !on)} />
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.length === 0 ? (
            <p className="text-xs text-muted">
              {interfaces.length === 0 ? "No interfaces" : "All adapters hidden — open settings"}
            </p>
          ) : (
            visible.map((iface) => (
              <MonitoredInterface
                key={iface.name}
                sparkId={sparkId}
                iface={iface}
                isPrimary={iface.name === primary}
                fallbackSpeed={linkSpeed}
              />
            ))
          )}
        </div>
      )}
    </Panel>
  );
}
