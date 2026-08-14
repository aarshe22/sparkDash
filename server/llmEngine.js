/**
 * Persist / probe helper for spark.llmEngine.
 * @param {unknown} value
 * @returns {"vllm" | "sglang" | "llamacpp" | "ollama" | "auto"}
 */
export function normalizeLlmEngine(value) {
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
