export type ModelDensity = "dense" | "sparse";

/**
 * Infer dense vs sparse (MoE) from a served model id.
 * Hugging Face MoE checkpoints typically encode active params as `30B-A3B`.
 */
export function classifyModelDensity(modelId: string | null | undefined): ModelDensity | null {
  if (!modelId || !modelId.trim()) return null;
  const id = modelId.toLowerCase();

  if (/\bdistill\b/.test(id)) return "dense";
  if (/\d+\s*b[-_./]a\d+\s*b/.test(id)) return "sparse";
  if (/\d+\s*x\s*\d+\s*b/.test(id)) return "sparse";
  if (
    /\b(moe|mixtral|dbrx|gpt-oss|deepseek-v3|deepseek-r1|qwen3-next|olmoe)\b/.test(id)
  ) {
    return "sparse";
  }
  if (/\b(experts?|sparse|routed)\b/.test(id)) return "sparse";
  return "dense";
}

export function densityLabel(density: ModelDensity): string {
  return density === "sparse" ? "Sparse" : "Dense";
}
