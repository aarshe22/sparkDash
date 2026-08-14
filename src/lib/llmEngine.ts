export type LlmEngine = "vllm" | "sglang" | "ollama" | "auto";

export type EngineMarkKind = "vllm" | "sglang" | "ollama" | "comfy" | "llama.cpp" | "ds4";

export function normalizeLlmEngine(value: unknown): LlmEngine {
  const v = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  if (v === "sglang" || v === "sgl") return "sglang";
  if (v === "ollama") return "ollama";
  if (v === "vllm") return "vllm";
  return "auto";
}

export function monitoringEngineDraft(value: unknown): Exclude<LlmEngine, "auto"> {
  const engine = normalizeLlmEngine(value);
  if (engine === "sglang" || engine === "ollama") return engine;
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
): "vllm" | "sglang" | "ollama" | "off" {
  const role =
    spark.role === "head" || spark.role === "worker" || spark.role === "standalone"
      ? spark.role
      : spark.workerNode
        ? "worker"
        : "standalone";
  if (role === "worker") return "off";
  const monitoringOn = role === "head" ? true : spark.llmMonitoring !== false;
  if (!monitoringOn) return "off";
  const engine = normalizeLlmEngine(spark.llmEngine);
  if (engine === "sglang") return "sglang";
  if (engine === "ollama") return "ollama";
  return "vllm";
}

export function llmEnginePatch(
  choice: "vllm" | "sglang" | "ollama" | "off",
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
  if (selected === "sglang" || selected === "ollama") {
    kinds.push(selected);
  } else if (selected === "vllm") {
    const engine = normalizeLlmEngine(spark.llmEngine);
    if (engine === "auto") {
      kinds.push(liveBackendKind(spark) ?? "vllm");
    } else {
      kinds.push("vllm");
    }
  }
  if (spark.comfyMonitoring) kinds.push("comfy");
  return kinds;
}
