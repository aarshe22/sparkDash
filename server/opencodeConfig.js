/**
 * Build an OpenCode JSON config from live Spark snapshots.
 * Mirrors src/lib/opencodeConfig.ts — keep the two in sync.
 */

function isLlmMonitoringEnabled(spark) {
  const role = spark?.role || (spark?.workerNode ? "worker" : "standalone");
  if (role === "worker") return false;
  if (role === "head") return true;
  return spark?.llmMonitoring !== false;
}

function sparkLlmPorts(spark) {
  const raw = Array.isArray(spark?.llmPorts) && spark.llmPorts.length > 0
    ? spark.llmPorts
    : [spark?.llmPort];
  return raw.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
}

function liveMonitoredModels(sparks) {
  const out = [];
  for (const spark of sparks || []) {
    if (!isLlmMonitoringEnabled(spark) || !spark.online) continue;
    const lanIp = spark.lanIp != null ? String(spark.lanIp).trim() : "";
    if (!lanIp) continue;
    const ports = sparkLlmPorts(spark);
    const llms = Array.isArray(spark.metrics?.llm) ? spark.metrics.llm : [];
    for (let i = 0; i < ports.length; i++) {
      const port = ports[i];
      const llm = llms.find((l) => l.port === port) ?? llms[i] ?? null;
      if (!llm?.available || !llm.modelId) continue;
      out.push({
        sparkId: spark.id,
        sparkName: spark.name,
        lanIp,
        port: llm.port ?? port,
        modelId: llm.modelId,
        contextLength: llm.contextLength ?? null,
      });
    }
  }
  return out;
}

function providerId(sparkId, port) {
  const id =
    String(sparkId)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "spark";
  return `sparkdash-${id}-${port}`;
}

function grokModelKey(sparkId, port) {
  return providerId(sparkId, port).replace(/\./g, "-");
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * @param {object[]} sparks Spark snapshots (same shape as the WS payload)
 * @returns {object} OpenCode config JSON
 */
export function buildOpencodeConfig(sparks) {
  const live = liveMonitoredModels(sparks);
  const provider = {};
  let model;
  for (const ep of live) {
    const id = providerId(ep.sparkId, ep.port);
    const limit =
      ep.contextLength != null && ep.contextLength > 0
        ? { context: ep.contextLength, output: Math.min(65536, ep.contextLength) }
        : undefined;
    provider[id] = {
      npm: "@ai-sdk/openai-compatible",
      name: `${ep.sparkName} (:${ep.port})`,
      options: {
        baseURL: `http://${ep.lanIp}:${ep.port}/v1`,
      },
      models: {
        [ep.modelId]: {
          name: ep.modelId,
          ...(limit ? { limit } : {}),
        },
      },
    };
    if (!model) model = `${id}/${ep.modelId}`;
  }
  return {
    $schema: "https://opencode.ai/config.json",
    ...(model ? { model } : {}),
    provider,
  };
}

/**
 * @param {object[]} sparks Spark snapshots (same shape as the WS payload)
 * @returns {string} Grok Build config.toml
 */
export function buildGrokConfigToml(sparks) {
  const live = liveMonitoredModels(sparks);
  const lines = [
    "# sparkDash export for Grok Build.",
    "# Merge [model.*] into ~/.grok/config.toml, then: grok models && grok -m <key>",
    "",
  ];
  let defaultKey;
  for (const ep of live) {
    const key = grokModelKey(ep.sparkId, ep.port);
    if (!defaultKey) defaultKey = key;
    const context = ep.contextLength != null && ep.contextLength > 0 ? ep.contextLength : null;
    lines.push(`[model.${key}]`);
    lines.push(`model = ${tomlString(ep.modelId)}`);
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
