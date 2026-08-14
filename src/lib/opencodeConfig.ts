import type { SparkSnapshot } from "../api/types";
import { liveMonitoredModels, type LlmEndpoint } from "./llmEndpoints";

export interface OpencodeModelLimit {
  context: number;
  output: number;
}

export interface OpencodeModel {
  name: string;
  limit?: OpencodeModelLimit;
}

export interface OpencodeProvider {
  npm: string;
  name: string;
  options: { baseURL: string };
  models: Record<string, OpencodeModel>;
}

export interface OpencodeConfig {
  $schema: string;
  model?: string;
  provider: Record<string, OpencodeProvider>;
}

function providerId(sparkId: string, port: number): string {
  const id =
    String(sparkId)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "spark";
  return `sparkdash-${id}-${port}`;
}

function modelLimit(contextLength: number | null): OpencodeModelLimit | undefined {
  if (contextLength == null || contextLength <= 0) return undefined;
  return {
    context: contextLength,
    output: Math.min(65536, contextLength),
  };
}

function endpointToProvider(ep: LlmEndpoint): { id: string; provider: OpencodeProvider; modelRef: string } {
  const id = providerId(ep.sparkId, ep.port);
  const modelId = ep.modelId as string;
  const limit = modelLimit(ep.contextLength);
  const provider: OpencodeProvider = {
    npm: "@ai-sdk/openai-compatible",
    name: `${ep.sparkName} (:${ep.port})`,
    options: {
      baseURL: `http://${ep.lanIp}:${ep.port}/v1`,
    },
    models: {
      [modelId]: {
        name: modelId,
        ...(limit ? { limit } : {}),
      },
    },
  };
  return { id, provider, modelRef: `${id}/${modelId}` };
}

/** Build an OpenCode config covering every monitored, live model. */
export function buildOpencodeConfig(sparks: SparkSnapshot[]): OpencodeConfig {
  const live = liveMonitoredModels(sparks);
  const provider: Record<string, OpencodeProvider> = {};
  let model: string | undefined;
  for (const ep of live) {
    const { id, provider: p, modelRef } = endpointToProvider(ep);
    provider[id] = p;
    if (!model) model = modelRef;
  }
  return {
    $schema: "https://opencode.ai/config.json",
    ...(model ? { model } : {}),
    provider,
  };
}

export function downloadOpencodeConfig(sparks: SparkSnapshot[]) {
  const json = `${JSON.stringify(buildOpencodeConfig(sparks), null, 2)}\n`;
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "opencode.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
