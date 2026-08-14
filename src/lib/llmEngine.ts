export type LlmEngine = "vllm" | "sglang" | "llamacpp" | "ollama" | "auto";

export type LlmMonitoringChoice = Exclude<LlmEngine, "auto"> | "off";

export type EngineMarkKind = "vllm" | "sglang" | "ollama" | "comfy" | "llama.cpp" | "ds4";

export const MONITORING_ENGINE_OPTIONS: {
  id: Exclude<LlmEngine, "auto">;
  label: string;
  shortLabel: string;
}[] = [
  { id: "vllm", label: "vLLM monitoring", shortLabel: "vLLM" },
  { id: "sglang", label: "SGLang monitoring", shortLabel: "SGLang" },
  { id: "llamacpp", label: "llama.cpp monitoring", shortLabel: "llama.cpp" },
  { id: "ollama", label: "Ollama monitoring", shortLabel: "Ollama" },
];

export function normalizeLlmEngine(value: unknown): LlmEngine {
  const v = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  if (v === "sglang" || v === "sgl") return "sglang";
  if (v === "ollama") return "ollama";
  if (v === "vllm") return "vllm";
  if (v === "llamacpp" || v === "llama.cpp") return "llamacpp";
  return "auto";
}

export function monitoringEngineDraft(value: unknown): Exclude<LlmEngine, "auto"> {
  const engine = normalizeLlmEngine(value);
  if (engine !== "auto") return engine;
  return "vllm";
}

/**
 * Which exclusive monitoring checkbox is selected.
 * Head/standalone with monitoring on and engine auto → vLLM (legacy default).
 */
export function selectedLlmMonitoring(
  spark: {
    role?: string | null;
    workerNode?: boolean | null;
    llmMonitoring?: boolean | null;
    llmEngine?: string | null;
  }
): LlmMonitoringChoice {
  const role =
    spark.role === "head" || spark.role === "worker" || spark.role === "standalone"
      ? spark.role
      : spark.workerNode
        ? "worker"
        : "standalone";
  if (role === "worker") return "off";
  const monitoringOn = role === "head" ? true : spark.llmMonitoring !== false;
  if (!monitoringOn) return "off";
  return monitoringEngineDraft(spark.llmEngine);
}

export function llmEnginePatch(
  choice: LlmMonitoringChoice,
  role: "head" | "worker" | "standalone"
): { llmMonitoring: boolean; llmEngine: LlmEngine } {
  if (role === "worker") return { llmMonitoring: false, llmEngine: "auto" };
  if (choice === "off") {
    if (role === "head") return { llmMonitoring: true, llmEngine: "vllm" };
    return { llmMonitoring: false, llmEngine: "auto" };
  }
  return { llmMonitoring: true, llmEngine: choice };
}

function liveBackendKind(spark: {
  metrics?: { llm?: Array<{ available?: boolean; backend?: string | null }> | null };
}): EngineMarkKind | null {
  const rows = spark.metrics?.llm ?? [];
  const live = rows.find((row) => row?.available && row.backend);
  const backend = String(live?.backend || "").toLowerCase();
  if (backend === "vllm") return "vllm";
  if (backend === "sglang") return "sglang";
  if (backend === "ollama") return "ollama";
  if (backend === "llama.cpp" || backend === "llamacpp") return "llama.cpp";
  if (backend === "ds4") return "ds4";
  return null;
}

function markForChoice(choice: Exclude<LlmEngine, "auto">): EngineMarkKind {
  if (choice === "llamacpp") return "llama.cpp";
  return choice;
}

/** Icons shown under the model name on overview / spark header. */
export function sparkEngineMarks(spark: {
  role?: string | null;
  workerNode?: boolean | null;
  llmMonitoring?: boolean | null;
  llmEngine?: string | null;
  comfyMonitoring?: boolean | null;
  metrics?: { llm?: Array<{ available?: boolean; backend?: string | null }> | null };
}): EngineMarkKind[] {
  const kinds: EngineMarkKind[] = [];
  const selected = selectedLlmMonitoring(spark);
  if (selected === "vllm") {
    const engine = normalizeLlmEngine(spark.llmEngine);
    if (engine === "auto") {
      kinds.push(liveBackendKind(spark) ?? "vllm");
    } else {
      kinds.push("vllm");
    }
  } else if (selected !== "off") {
    kinds.push(markForChoice(selected));
  }
  if (spark.comfyMonitoring) kinds.push("comfy");
  return kinds;
}
