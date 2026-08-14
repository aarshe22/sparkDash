import type { HaproxySettings, SparkSnapshot } from "../api/types";
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

function mappingIdentity(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function haproxyBaseUrl(
  ep: LlmEndpoint,
  haproxy: HaproxySettings | null | undefined,
  primaryPort: number | undefined
): string | null {
  if (!haproxy?.enabled || !haproxy.exportEnabled || !haproxy.domain) return null;
  const sparkId = mappingIdentity(ep.sparkId);
  const sparkName = mappingIdentity(ep.sparkName);
  const exact = haproxy.backendMappings.find(
    (item) =>
      item.enabled &&
      mappingIdentity(item.sparkId) === sparkId &&
      item.llmPort === ep.port
  );
  const primary =
    ep.port === primaryPort
      ? haproxy.backendMappings.find((item) => {
          if (!item.enabled || item.llmPort != null) return false;
          if (item.sparkId) return mappingIdentity(item.sparkId) === sparkId;
          const name = mappingIdentity(item.name);
          return name && (name === sparkId || name === sparkName || sparkName.startsWith(name));
        })
      : undefined;
  const mapping = exact ?? primary;
  return mapping ? `https://${haproxy.domain}:${mapping.port}/v1` : null;
}

function endpointToProvider(
  ep: LlmEndpoint,
  haproxy?: HaproxySettings | null,
  primaryPort?: number
): { id: string; provider: OpencodeProvider; modelRef: string } {
  const id = providerId(ep.sparkId, ep.port);
  const modelId = ep.modelId as string;
  const limit = modelLimit(ep.contextLength);
  const provider: OpencodeProvider = {
    npm: "@ai-sdk/openai-compatible",
    name: `${ep.sparkName} (:${ep.port})`,
    options: {
      baseURL: haproxyBaseUrl(ep, haproxy, primaryPort) || `http://${ep.lanIp}:${ep.port}/v1`,
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
export function buildOpencodeConfig(
  sparks: SparkSnapshot[],
  haproxy?: HaproxySettings | null
): OpencodeConfig {
  const live = liveMonitoredModels(sparks);
  const provider: Record<string, OpencodeProvider> = {};
  let model: string | undefined;
  for (const ep of live) {
    const source = sparks.find((spark) => spark.id === ep.sparkId);
    const primaryPort = source?.llmPorts?.[0] ?? source?.llmPort;
    const { id, provider: p, modelRef } = endpointToProvider(ep, haproxy, primaryPort);
    provider[id] = p;
    if (!model) model = modelRef;
  }
  return {
    $schema: "https://opencode.ai/config.json",
    ...(model ? { model } : {}),
    provider,
  };
}

export function downloadOpencodeConfig(sparks: SparkSnapshot[], haproxy?: HaproxySettings | null) {
  const json = `${JSON.stringify(buildOpencodeConfig(sparks, haproxy), null, 2)}\n`;
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
export function buildGrokConfigToml(
  sparks: SparkSnapshot[],
  haproxy?: HaproxySettings | null
): string {
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
    const source = sparks.find((spark) => spark.id === ep.sparkId);
    const primaryPort = source?.llmPorts?.[0] ?? source?.llmPort;
    if (!defaultKey) defaultKey = key;
    const context = ep.contextLength != null && ep.contextLength > 0 ? ep.contextLength : null;
    lines.push(`[model.${key}]`);
    lines.push(`model = ${tomlString(modelId)}`);
    lines.push(
      `base_url = ${tomlString(
        haproxyBaseUrl(ep, haproxy, primaryPort) || `http://${ep.lanIp}:${ep.port}/v1`
      )}`
    );
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

export function downloadGrokConfig(sparks: SparkSnapshot[], haproxy?: HaproxySettings | null) {
  const toml = buildGrokConfigToml(sparks, haproxy);
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
