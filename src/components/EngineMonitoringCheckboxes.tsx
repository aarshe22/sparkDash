import type { SparkConfig, SparkRole } from "../api/types";
import { llmEnginePatch, selectedLlmMonitoring } from "../lib/llmEngine";
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
  const select = (choice: "vllm" | "sglang" | "ollama" | "off") => {
    update(llmEnginePatch(choice, role));
  };
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={selected === "vllm"}
          onChange={(e) =>
            select(e.target.checked ? "vllm" : selected === "vllm" ? "off" : selected)
          }
          className="rounded border-border"
        />
        <span>vLLM monitoring</span>
        <span
          className="inline-flex shrink-0 cursor-help text-muted hover:text-text"
          title="Probe this Spark as vLLM. Checking this turns off SGLang / Ollama monitoring."
          aria-label="Enable vLLM monitoring."
        >
          <InfoIcon className="h-3.5 w-3.5" />
        </span>
      </label>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={selected === "sglang"}
          onChange={(e) =>
            select(e.target.checked ? "sglang" : selected === "sglang" ? "off" : selected)
          }
          className="rounded border-border"
        />
        <span>SGLang monitoring</span>
        <span
          className="inline-flex shrink-0 cursor-help text-muted hover:text-text"
          title="Probe this Spark as SGLang. Checking this turns off vLLM / Ollama monitoring."
          aria-label="Enable SGLang monitoring."
        >
          <InfoIcon className="h-3.5 w-3.5" />
        </span>
      </label>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={selected === "ollama"}
          onChange={(e) =>
            select(e.target.checked ? "ollama" : selected === "ollama" ? "off" : selected)
          }
          className="rounded border-border"
        />
        <span>Ollama monitoring</span>
        <span
          className="inline-flex shrink-0 cursor-help text-muted hover:text-text"
          title="Probe this Spark as Ollama. Checking this turns off vLLM / SGLang monitoring."
          aria-label="Enable Ollama monitoring."
        >
          <InfoIcon className="h-3.5 w-3.5" />
        </span>
      </label>
    </div>
  );
}
