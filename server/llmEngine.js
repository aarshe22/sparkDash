/**
 * Persist / probe helper for spark.llmEngine.
 * @param {unknown} value
 * @returns {"vllm" | "sglang" | "ollama" | "auto"}
 */
export function normalizeLlmEngine(value) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  if (v === "sglang" || v === "sgl") return "sglang";
  if (v === "ollama") return "ollama";
  if (v === "vllm") return "vllm";
  return "auto";
}
