/**
 * LlmProbe — probes an LLM server on port 8888, auto-detects backend,
 * computes live tokens/sec (generation + prefill).
 *
 * Ported from legacy `probeLlamaServerType` and `_getLlamaMetricsFor`.
 */
import { LLM_PROBE_TIMEOUT_MS } from "../config.js";

const FAIL_RESET_THRESHOLD = 3;
const REDETECT_INTERVAL_MS = 60_000;

export class LlmProbe {
  constructor(spark, port = 8888) {
    this.spark = spark;
    this.port = port;
this.baseUrl = `http://${spark.isLocal ? (process.env.LLM_HOST || "localhost") : spark.lanIp}:${port}`;

    // State
    this.backendType = null; // 'vllm' | 'llama.cpp' | 'sglang' | null
    this.serverIsOpenAI = null; // true = OpenAI-compatible
    this.stepId = 0;
    this.modelId = null;
    this.modelPath = null;
    this.contextLength = null;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.generationTps = 0;
    this.prefillTps = 0;
    this.error = null;

    // Per-slot rate tracking (for llama.cpp native path)
    this.slotState = new Map();
    this.lastTokenCounts = { input: 0, output: 0 };
    this.lastProbeTime = 0;

    // Cumulative total output tokens (generation) as reported by the LLM server
    this.totalOutputTokens = 0;

    // vLLM inference metrics from /metrics (null when not vLLM / missing series)
    // Metric names follow stock vLLM Prometheus exposition (versions may differ).
    this.kvCacheUsage = null; // 0–1 fraction
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.preemptionsTotal = null; // cumulative counter
    /** Prefix cache hit rate 0–1 (hits/queries). */
    this.prefixCacheHitRate = null;
    /** End-to-end request latency p95 (seconds). */
    this.e2eP95Seconds = null;
    /** Inter-token latency p95 (seconds). */
    this.itlP95Seconds = null;
    /** Speculative/MTP acceptance rate 0–1 (accepted/drafted). */
    this.mtpAcceptanceRate = null;

    this._consecutiveFailures = 0;
    this._lastDetectAt = 0;
  }

  /** Update probe port (and host from spark). Resets detection when the target changes. */
  setPort(port) {
    const next = Number(port);
    const prevUrl = this.baseUrl;
    if (Number.isInteger(next) && next >= 1 && next <= 65535) {
      this.port = next;
    }
this.baseUrl = `http://${this.spark.isLocal ? (process.env.LLM_HOST || "localhost") : this.spark.lanIp}:${this.port}`;
    if (this.baseUrl !== prevUrl) {
      this._resetDetection();
      this._lastDetectAt = 0;
      this._consecutiveFailures = 0;
    }
  }

  /** Probe the LLM server and return a snapshot. */
  async probe() {
    this._probeT0 = Date.now();
    try {
      console.log(`[LlmProbe] ${this.spark?.id||"?"} port=${this.port} probe() start url=${this.baseUrl}`);
      const shouldDetect =
        this.serverIsOpenAI === null ||
        Date.now() - this._lastDetectAt > REDETECT_INTERVAL_MS;

      if (shouldDetect) {
        await this._detectServerType();
        this._lastDetectAt = Date.now();
      }

      if (this.serverIsOpenAI === false) {
        const snap = await this._probeLlamaCpp();
        this._noteSuccess();
        return snap;
      } else if (this.serverIsOpenAI === true) {
        const snap = await this._probeOpenAICompatible();
        this._noteSuccess();
        return snap;
      } else {
        this._noteFailure("LLM server not reachable");
        return this._defaultLlm();
      }
    } catch (err) {
      this._noteFailure(err.message);
      return this._defaultLlm();
    }
  }

  _noteSuccess() {
    this._consecutiveFailures = 0;
    this.error = null;
    console.log(`[LlmProbe] ${this.spark?.id||"?"} port=${this.port} OK backend=${this.backendType} model=${this.modelId} slotsActive=${this.slotsActive} genTps=${this.generationTps} prefillTps=${this.prefillTps} took=${Date.now()-this._probeT0}ms`);
  }

  _noteFailure(message) {
    this.error = message;
    console.warn(`[LlmProbe] ${this.spark?.id||"?"} port=${this.port} failure: ${message} (consecutive=${this._consecutiveFailures})`);
    this._consecutiveFailures += 1;
    if (this._consecutiveFailures >= FAIL_RESET_THRESHOLD) {
      this._resetDetection();
    }
  }

  _resetDetection() {
    this.serverIsOpenAI = null;
    this.backendType = null;
    this.modelId = null;
    this.modelPath = null;
    this.generationTps = 0;
    this.prefillTps = 0;
    this.contextLength = null;
    this.gpuMemoryUtilization = null;
    this.slotsActive = 0;
    this.slotsTotal = 0;
    this.totalOutputTokens = 0;
    this.kvCacheUsage = null;
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.preemptionsTotal = null;
    this.prefixCacheHitRate = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.mtpAcceptanceRate = null;
    this.slotState.clear();
    this.lastTokenCounts = { input: 0, output: 0 };
  }

  // ─── Server type detection ───────────────────────────────
  async _detectServerType() {
    console.log(`[LlmProbe] ${this.spark?.id||"?"} port=${this.port} _detectServerType()`);
    const slotUrl = `${this.baseUrl}/slots`;
    try {
      const slotRes = await this._fetch(slotUrl);
      if (slotRes.ok) {
        const slots = await slotRes.json();
        if (Array.isArray(slots)) {
          this.serverIsOpenAI = false;
          this.backendType = "llama.cpp";
          return;
        }
      }
    } catch {}

    // Try OpenAI-compatible
    try {
      const modelRes = await this._fetch(`${this.baseUrl}/v1/models`);
      if (modelRes.ok) {
        this.serverIsOpenAI = true;
        this.backendType = "vllm";
        return;
      }
    } catch {}

    this.serverIsOpenAI = null;
    this.backendType = null;
    console.log(`[LlmProbe] ${this.spark?.id||"?"} port=${this.port} detection FAILED (no /slots, no /v1/models)`);
  }

  // ─── OpenAI-compatible path (vLLM/sglang) ────────────────
  async _probeOpenAICompatible() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    // Model info from /v1/models — failure means server is down
    let modelsOk = false;
    try {
      const modelsRes = await this._fetch(`${this.baseUrl}/v1/models`);
      if (modelsRes.ok) {
        modelsOk = true;
        const modelsData = await modelsRes.json();
        const model = modelsData?.data?.[0];
        this.modelId = model?.id || null;
        this.contextLength = model?.max_model_len || null;
      }
    } catch {}

    if (!modelsOk) {
      throw new Error("OpenAI-compatible /v1/models unreachable");
    }

    // Skip SGLang probe when we already know the backend is vLLM
    let isSglang = false;
    if (this.backendType !== "vllm") {
      try {
        const sgRes = await this._fetch(`${this.baseUrl}/get_server_info`);
        if (sgRes.ok) {
          isSglang = true;
          const sgData = await sgRes.json();
          this.contextLength = sgData.max_total_tokens || sgData.context_length || this.contextLength;
          if (sgData.total_input_tokens != null && sgData.total_output_tokens != null) {
            const deltaIn = sgData.total_input_tokens - this.lastTokenCounts.input;
            const deltaOut = sgData.total_output_tokens - this.lastTokenCounts.output;
            this.lastTokenCounts.input = sgData.total_input_tokens;
            this.lastTokenCounts.output = sgData.total_output_tokens;
            this.totalOutputTokens = sgData.total_output_tokens;
            if (dtSec > 0 && dtSec < 10) {
              this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
              this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
            }
          }
        }
      } catch {}
    }

    // Single /metrics fetch: tok/s + slots/sleep (vLLM exposes max_model_len via /v1/models)
    if (!isSglang) {
      try {
        const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
        if (metricsRes.ok) {
metricsText = await metricsRes.text();
          console.log(`[LlmProbe] ${this.spark?.id||"?"} port=${this.port} /metrics OK len=${metricsText.length}`);
        } else {
          console.warn(`[LlmProbe] ${this.spark?.id||"?"} port=${this.port} /metrics HTTP ${metricsRes.status}`);
        }
      } catch (e) { console.warn(`[LlmProbe] ${this.spark?.id||"?"} port=${this.port} /metrics fetch error: ${e.message}`); }

      if (metricsText) {
        // Parse full vLLM telemetry using VllmMetricsParser
        const telemetry = this.vllmParser.parse(metricsText, dtSec);
        console.log(`[LlmProbe] ${this.spark?.id||"?"} port=${this.port} parser: ${telemetry ? "OK running="+telemetry.runningSlots+" kv="+telemetry.kvCacheUsage : "null"}`);
        if (telemetry) {
          this.vllmTelemetry = telemetry;

          // Use the parser's throughput for generationTps/prefillTps
          // (counter-delta based, more accurate than raw gauge)
          if (dtSec > 0 && dtSec < 10) {
            if (telemetry.generationTpsFromCounters > 0) {
              this.generationTps = telemetry.generationTpsFromCounters;
            }
            if (telemetry.promptTpsFromCounters > 0) {
              this.prefillTps = telemetry.promptTpsFromCounters;
            }
          }

          // Also update lastTokenCounts from the parser's raw counters
          // so legacy code stays consistent
          // (the parser tracks its own state internally)

          // Running requests as slotsActive
          this.slotsActive = telemetry.runningSlots;
        }

        // Fallback: use the simple metric extraction if parser returned null
        // or for fields the parser doesn't cover
        if (!this.vllmTelemetry) {
          const promptTokens = this._getVllmMetric(metricsText, "prompt_tokens_total");
          const genTokens = this._getVllmMetric(metricsText, "generation_tokens_total");
          if (promptTokens != null && genTokens != null) {
            const deltaIn = promptTokens - this.lastTokenCounts.input;
            const deltaOut = genTokens - this.lastTokenCounts.output;
            this.lastTokenCounts.input = promptTokens;
            this.lastTokenCounts.output = genTokens;
            this.totalOutputTokens = genTokens;
            if (dtSec > 0 && dtSec < 10) {
              this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
              this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
            }
          }

          const running = this._getVllmMetric(txt, "num_requests_running");
          // Keep requestsRunning in sync with other vLLM tiles (null when missing)
          this.requestsRunning = running;
          if (running != null) this.slotsActive = Math.round(running);

          // Engine sleep state — exposed as a separate field, NOT gpuMemoryUtilization.
          // (engine_sleep_state is a multi-label gauge: awake + weights_offloaded + discard_all;
          //  summing them is meaningless. We only read the "awake" label.)
          if (this.gpuMemoryUtilization == null) {
            const sleepMatch = txt.match(/^vllm:engine_sleep_state\{[^}]*sleep_state="awake"[^}]*\}\s+([\d.eE+-]+)\s*$/m);
            if (sleepMatch) this.gpuMemoryUtilization = null; // intentionally null — not a GPU mem util
          }

          // vLLM inference performance (same /metrics body — no extra HTTP)
          this.requestsWaiting = this._getVllmMetric(txt, "num_requests_waiting");
          this.kvCacheUsage = this._getVllmMetric(txt, "kv_cache_usage_perc");
          this.preemptionsTotal = this._getVllmMetric(txt, "num_preemptions_total");

          const ttftHist = this._parseVllmHistogram(txt, "vllm:time_to_first_token_seconds");
          const ttftP95 = this._histogramQuantile(ttftHist.buckets, ttftHist.total, 0.95);
          // Round to 3 decimals so WS snapshots stay stable (avoids float jitter)
          this.ttftP95Seconds = ttftP95 == null ? null : Math.round(ttftP95 * 1000) / 1000;

          const e2eHist = this._parseVllmHistogram(txt, "vllm:e2e_request_latency_seconds");
          const e2eP95 = this._histogramQuantile(e2eHist.buckets, e2eHist.total, 0.95);
          this.e2eP95Seconds = e2eP95 == null ? null : Math.round(e2eP95 * 1000) / 1000;

          const itlHist = this._parseVllmHistogram(txt, "vllm:inter_token_latency_seconds");
          const itlP95 = this._histogramQuantile(itlHist.buckets, itlHist.total, 0.95);
          this.itlP95Seconds = itlP95 == null ? null : Math.round(itlP95 * 1000) / 1000;

          // Lifetime rates from absolute counters (stable tiles; null when unused)
          const prefixHits = this._getVllmMetric(txt, "prefix_cache_hits_total");
          const prefixQueries = this._getVllmMetric(txt, "prefix_cache_queries_total");
          this.prefixCacheHitRate =
            prefixHits != null && prefixQueries != null && prefixQueries > 0
              ? Math.round((prefixHits / prefixQueries) * 10000) / 10000
              : null;

          const mtpAccepted = this._getVllmMetric(txt, "spec_decode_num_accepted_tokens_total");
          const mtpDrafted = this._getVllmMetric(txt, "spec_decode_num_draft_tokens_total");
          this.mtpAcceptanceRate =
            mtpAccepted != null && mtpDrafted != null && mtpDrafted > 0
              ? Math.round((mtpAccepted / mtpDrafted) * 10000) / 10000
              : null;
        }
      } catch {}
    }

    this.backendType = isSglang ? "sglang" : "vllm";

    return this._getSnapshot();
  }

  // ─── llama.cpp native path ────────────────────────────────
  async _probeLlamaCpp() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    // Slots
    let slotsOk = false;
    try {
      const slotsRes = await this._fetch(`${this.baseUrl}/slots`);
      if (slotsRes.ok) {
        const slots = await slotsRes.json();
        if (Array.isArray(slots)) {
          slotsOk = true;
          this.slotsTotal = slots.length;
          // Some llama.cpp builds use is_processing instead of state
          this.slotsActive = slots.filter((s) => s.is_processing || (s.state && s.state !== "idle")).length;

          let totalGen = 0;
          let totalPrefill = 0;
          let totalDecoded = 0;

          for (const slot of slots) {
            const slotId = slot.id ?? "default";
            const decoded = this._getSlotDecoded(slot);
            const prompted = this._getSlotPrefilled(slot);
            totalDecoded += decoded;
            const lastState = this.slotState.get(slotId) || { decoded: 0, prompted: 0 };
            const dDecoded = decoded - lastState.decoded;
            const dPrompted = prompted - lastState.prompted;
            this.slotState.set(slotId, { decoded, prompted });
            if (dtSec > 0 && dtSec < 10) {
              totalGen += dDecoded / dtSec;
              totalPrefill += dPrompted / dtSec;
            }
          }

          this.totalOutputTokens = totalDecoded;
          this.generationTps = Math.max(0, Math.round(totalGen * 100) / 100);
          this.prefillTps = Math.max(0, Math.round(totalPrefill * 100) / 100);
        }
      }
    } catch {}

    if (!slotsOk) {
      throw new Error("llama.cpp /slots unreachable");
    }

    // Props (model info)
    try {
      const propsRes = await this._fetch(`${this.baseUrl}/props`);
      if (propsRes.ok) {
        const props = await propsRes.json();
        this.modelId = props.model_alias || props.model_path || this.modelId;
        this.modelPath = props.model_path || null;
        this.contextLength = props.total_context_length || props.context_length || this.contextLength;
      }
    } catch {}

    this.backendType = "llama.cpp";
    return this._getSnapshot();
  }

  // ─── Metrics helpers ─────────────────────────────────────
  _getVllmMetric(body, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Allow optional Prometheus labels; sum all series (multi-engine / multi-model)
    const re = new RegExp(`^vllm:${esc}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
    let sum = 0;
    let found = false;
    let m;
    while ((m = re.exec(body)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) {
        sum += v;
        found = true;
      }
    }
    return found ? sum : null;
  }

  /**
   * Parse a vLLM Prometheus histogram from /metrics text.
   * Returns { buckets: [{upper, count}], total } with cumulative counts per `le`,
   * summed across label sets. `total` is the summed `_count` series (or null).
   */
  _parseVllmHistogram(body, metricPrefix) {
    const esc = metricPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Bucket lines: <metricPrefix>_bucket{...le="X"...} VALUE
    const bucketRe = new RegExp(
      `^${esc}_bucket\\{[^}]*\\ble="([^"]+)"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$`,
      "gm"
    );
    const byUpper = new Map();
    let infCount = 0;
    let m;
    while ((m = bucketRe.exec(body)) !== null) {
      const le = m[1];
      const count = parseFloat(m[2]);
      if (!Number.isFinite(count)) continue;
      const upper = le === "+Inf" ? Infinity : parseFloat(le);
      if (upper !== Infinity && !Number.isFinite(upper)) continue;
      if (upper === Infinity) infCount += count;
      byUpper.set(upper, (byUpper.get(upper) || 0) + count);
    }
    const total = this._getVllmMetric(body, `${metricPrefix.replace(/^vllm:/, "")}_count`);
    // Prometheus invariant: +Inf bucket count == _count. Mismatch → refuse quantile.
    if (total != null && infCount > 0 && Math.abs(infCount - total) > 1e-6) {
      return { buckets: [], total: null };
    }
    const buckets = Array.from(byUpper, ([upper, count]) => ({ upper, count }));
    buckets.sort((a, b) => a.upper - b.upper);
    return { buckets, total };
  }

  /**
   * Prometheus-style linear interpolation for a histogram quantile.
   * Returns null when empty / invalid or target is in the +Inf tail.
   */
  _histogramQuantile(buckets, total, quantile) {
    if (!buckets || !buckets.length || total == null || total <= 0) return null;
    const target = total * quantile;
    let prevUpper = 0.0;
    let prevCount = 0.0;
    for (const { upper, count } of buckets) {
      if (count >= target) {
        if (!Number.isFinite(upper)) return null;
        if (count === prevCount) return upper;
        return prevUpper + (upper - prevUpper) * ((target - prevCount) / (count - prevCount));
      }
      prevUpper = upper;
      prevCount = count;
    }
    return null;
  }

  _getSlotDecoded(slot) {
    // Some llama.cpp builds nest n_decoded inside next_token[0]
    if (slot.n_decoded != null) {
      if (Array.isArray(slot.n_decoded)) return slot.n_decoded[0] || 0;
      return slot.n_decoded || 0;
    }
    // Fallback: next_token[0].n_decoded (newer llama.cpp)
    if (Array.isArray(slot.next_token) && slot.next_token[0]?.n_decoded != null) {
      return slot.next_token[0].n_decoded;
    }
    return 0;
  }

  _getSlotPrefilled(slot) {
    return slot.n_prompt_tokens_processed || slot.n_prompt_tokens || 0;
  }

  _getSnapshot() {
    const t = this.vllmTelemetry;
    // Flatten vLLM detailed telemetry into the top-level LlmMetrics fields
    // that the frontend LlmPanel reads directly (see src/api/types.ts).
    // When the backend is llama.cpp or the parser returned null, these
    // expanded fields are simply absent (undefined) and the panel renders
    // them as "—".
    return {
      available: this.serverIsOpenAI !== null,
      backend: this.backendType,
      modelId: this.modelId || null,
      modelPath: this.modelPath || null,
      contextLength: this.contextLength,
      gpuMemoryUtilization: this.gpuMemoryUtilization,
      slotsActive: this.slotsActive,
      slotsTotal: this.slotsTotal,
      generationTps: this.generationTps,
      prefillTps: this.prefillTps,
      totalOutputTokens: this.totalOutputTokens,
      kvCacheUsage: this.kvCacheUsage,
      requestsRunning: this.requestsRunning,
      requestsWaiting: this.requestsWaiting,
      ttftP95Seconds: this.ttftP95Seconds,
      preemptionsTotal: this.preemptionsTotal,
      prefixCacheHitRate: this.prefixCacheHitRate,
      e2eP95Seconds: this.e2eP95Seconds,
      itlP95Seconds: this.itlP95Seconds,
      mtpAcceptanceRate: this.mtpAcceptanceRate,
      error: this.error,
// ── Expanded telemetry (flattened from vllmParser output) ──
      runningSlots: t?.runningSlots,
      waitingSlots: t?.waitingSlots,
      kvCacheUsage: t?.kvCacheUsage,
      ttft: t?.ttft,
      e2eLatency: t?.e2eRequestLatency,
      interTokenLatency: t?.interTokenLatency,
      promptTokensPerReq: t?.promptTokensPerRequest,
      genTokensPerReq: t?.generationTokensPerRequest,
      mtpAcceptanceRate: t?.specAcceptanceRate,
      mtpAcceptedTokens: t?.specAcceptedTokens,
      mtpDraftedTokens: t?.specDraftedTokens,
      prefixCacheHitRate: t?.prefixCacheHitRate,
      perPositionAcceptance: t?.specPerPositionAcceptance,
      rollingAvgE2e: t?.rolling?.avgE2eLatency,
      rollingAvgTtft: t?.rolling?.avgTtft,
      rollingAvgTokensPerReq: t?.rolling?.avgTokensPerRequest,
      rollingAvgTpsPerSlot: t?.rolling?.avgTpsPerSlot,
      // Keep the raw nested object for debugging / future use
      vllmTelemetry: t,
    };
  }

  _defaultLlm() {
    return {
      available: false,
      backend: null,
      modelId: null,
      modelPath: null,
      contextLength: null,
      gpuMemoryUtilization: null,
      slotsActive: 0,
      slotsTotal: 0,
      generationTps: 0,
      prefillTps: 0,
      totalOutputTokens: 0,
      kvCacheUsage: null,
      requestsRunning: null,
      requestsWaiting: null,
      ttftP95Seconds: null,
      preemptionsTotal: null,
      prefixCacheHitRate: null,
      e2eP95Seconds: null,
      itlP95Seconds: null,
      mtpAcceptanceRate: null,
      error: this.error,
    };
  }

  // ─── HTTP helpers ────────────────────────────────────────
  async _fetch(url) {
    return fetch(url, { signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS) });
  }
}
