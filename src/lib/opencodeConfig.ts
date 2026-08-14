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

function grokModelKey(sparkId: string, port: number): string {
  return providerId(sparkId, port).replace(/\./g, "-");
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

/** Build a Grok Build ~/.grok/config.toml covering every monitored, live model. */
export function buildGrokConfigToml(sparks: SparkSnapshot[]): string {
  const live = liveMonitoredModels(sparks);
  const lines: string[] = [
    "# sparkDash export for Grok Build.",
    "# Merge [model.*] into ~/.grok/config.toml, then: grok models && grok -m <key>",
    "",
  ];
  let defaultKey: string | undefined;
  for (const ep of live) {
    const key = grokModelKey(ep.sparkId, ep.port);
    const modelId = ep.modelId as string;
    if (!defaultKey) defaultKey = key;
    const context = ep.contextLength != null && ep.contextLength > 0 ? ep.contextLength : null;
    lines.push(`[model.${key}]`);
    lines.push(`model = ${tomlString(modelId)}`);
    lines.push(`base_url = ${tomlString(`http://${ep.lanIp}:${ep.port}/v1`)}`);
    lines.push(`name = ${tomlString(`${ep.sparkName} (:${ep.port})`)}`);
    lines.push(`api_backend = "chat_completions"`);
    lines.push(`api_key = "not-needed"`);
    if (context) {
      lines.push(`context_window = ${context}`);
      lines.push(`max_completion_tokens = ${Math.min(65536, context)}`);
    }
    lines.push("");
  }
  if (defaultKey) {
    lines.push("[models]");
    lines.push(`default = ${tomlString(defaultKey)}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function downloadGrokConfig(sparks: SparkSnapshot[]) {
  const toml = buildGrokConfigToml(sparks);
  const blob = new Blob([toml], { type: "application/toml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "config.toml";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
