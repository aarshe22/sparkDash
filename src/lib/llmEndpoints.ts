import type { SparkSnapshot } from "../api/types";
import { isLlmMonitoringEnabled } from "../api/sparkRole";

export interface LlmEndpoint {
  sparkId: string;
  sparkName: string;
  lanIp: string;
  port: number;
  available: boolean;
  modelId: string | null;
  contextLength: number | null;
  backend: string | null;
  generationTps: number;
}

/** Format a context window as a full token count with grouping commas. */
export function formatContextLength(n: number | null | undefined): string {
  if (n == null || n <= 0) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** Configured LLM ports for a Spark, in display order. */
export function sparkLlmPorts(spark: SparkSnapshot): number[] {
  const raw = spark.llmPorts?.length ? spark.llmPorts : [spark.llmPort];
  return raw.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
}

/** One row per configured LLM port, joined with live probe data when present. */
export function sparkLlmEndpoints(spark: SparkSnapshot): LlmEndpoint[] {
  const ports = sparkLlmPorts(spark);
  const llms = Array.isArray(spark.metrics?.llm) ? spark.metrics.llm : [];
  const lanIp = spark.lanIp != null ? String(spark.lanIp).trim() : "";
  return ports.map((port, i) => {
    const llm = llms.find((l) => l.port === port) ?? llms[i] ?? null;
    return {
      sparkId: spark.id,
      sparkName: spark.name,
      lanIp,
      port: llm?.port ?? port,
      available: Boolean(llm?.available),
      modelId: llm?.modelId ?? null,
      contextLength: llm?.contextLength ?? null,
      backend: llm?.backend ?? null,
      generationTps: llm?.generationTps ?? 0,
    };
  });
}

/**
 * Monitored Sparks that are online with a reachable model loaded.
 * Used by the OpenCode config download.
 */
export function liveMonitoredModels(sparks: SparkSnapshot[]): LlmEndpoint[] {
  const out: LlmEndpoint[] = [];
  for (const spark of sparks) {
    if (!isLlmMonitoringEnabled(spark)) continue;
    if (!spark.online) continue;
    for (const ep of sparkLlmEndpoints(spark)) {
      if (!ep.available || !ep.modelId || !ep.lanIp) continue;
      out.push(ep);
    }
  }
  return out;
}
