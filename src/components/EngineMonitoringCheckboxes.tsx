import type { SparkConfig, SparkRole } from "../api/types";
import {
  llmEnginePatch,
  MONITORING_ENGINE_OPTIONS,
  selectedLlmMonitoring,
  type LlmMonitoringChoice,
} from "../lib/llmEngine";
import { InfoIcon } from "./ui/icons";

export function EngineMonitoringCheckboxes({
  role,
  config,
  update,
}: {
  role: SparkRole;
  config: SparkConfig;
  update: (patch: Partial<SparkConfig>) => void;
}) {
  if (role === "worker") return null;
  const selected = selectedLlmMonitoring(config);
  const select = (choice: LlmMonitoringChoice) => {
    update(llmEnginePatch(choice, role));
  };
  return (
    <div className="space-y-2">
      {MONITORING_ENGINE_OPTIONS.map((opt) => {
        const others = MONITORING_ENGINE_OPTIONS.filter((row) => row.id !== opt.id)
          .map((row) => row.shortLabel)
          .join(" / ");
        return (
          <label key={opt.id} className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={selected === opt.id}
              onChange={(e) =>
                select(e.target.checked ? opt.id : selected === opt.id ? "off" : selected)
              }
              className="rounded border-border"
            />
            <span>{opt.label}</span>
            <span
              className="inline-flex shrink-0 cursor-help text-muted hover:text-text"
              title={`Probe this Spark as ${opt.shortLabel}. Checking this turns off ${others} monitoring.`}
              aria-label={`Enable ${opt.shortLabel} monitoring.`}
            >
              <InfoIcon className="h-3.5 w-3.5" />
            </span>
          </label>
        );
      })}
    </div>
  );
}
