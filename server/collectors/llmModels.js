import { isAllowedTargetHost } from "../validate.js";

function resolvePort(spark, port) {
  const n = typeof port === "number" ? port : Number(port);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  const fromSpark = Number(spark?.llmPorts?.[0] || spark?.llmPort);
  if (Number.isInteger(fromSpark) && fromSpark >= 1 && fromSpark <= 65535) return fromSpark;
  return 8888;
}

function apiKeyForPort(spark, port) {
  const keys = spark?.llmApiKeys;
  if (!keys || typeof keys !== "object") return null;
  const raw = keys[String(port)] ?? keys[port];
  const key = raw != null ? String(raw).trim() : "";
  return key || null;
}

function contextLengthOf(row) {
  const raw =
    row?.max_model_len ??
    row?.context_length ??
    row?.context_window ??
    row?.max_context_length;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Query an OpenAI-compatible GET /v1/models on the Spark's LAN IP + port.
 * Returns every listed model (Ollama / vLLM / llama.cpp / sglang).
 */
export async function listLlmModels(spark, port) {
  const host = spark?.lanIp;
  if (!isAllowedTargetHost(host)) {
    return { ok: false, port: null, models: [], error: `Invalid or disallowed lanIp: ${host}` };
  }
  const resolvedPort = resolvePort(spark, port);
  const url = `http://${host}:${resolvedPort}/v1/models`;
  const headers = {};
  const apiKey = apiKeyForPort(spark, resolvedPort);
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        port: resolvedPort,
        models: [],
        error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    const data = await res.json();
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const models = rows
      .map((row) => {
        if (typeof row === "string") return { id: row, ownedBy: undefined, contextLength: null };
        const id = row?.id ?? row?.name ?? row?.model;
        if (!id) return null;
        return {
          id: String(id),
          ownedBy: row?.owned_by != null ? String(row.owned_by) : undefined,
          contextLength: contextLengthOf(row),
        };
      })
      .filter(Boolean);
    return { ok: true, port: resolvedPort, models };
  } catch (err) {
    return { ok: false, port: resolvedPort, models: [], error: err.message };
  }
}
