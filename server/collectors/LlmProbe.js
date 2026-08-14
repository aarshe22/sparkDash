/**
 * LlmProbe — probes an LLM server on port 8888, auto-detects backend,
 * computes live tokens/sec (generation + prefill).
 *
 * Ported from legacy `probeLlamaServerType` and `_getLlamaMetricsFor`.
 *
 * Supports vLLM, llama.cpp, sglang, and ds4 (DeepSeek-V4-Flash CUDA engine).
 * The ds4 backend is detected via /v1/models `owned_by: "ds4.c"` and exposes
 * its own ds4_* Prometheus metrics.
 */
import { LLM_PROBE_TIMEOUT_MS } from "../config.js";
import { VllmMetricsParser } from "./VllmMetricsParser.js";
import { normalizeLlmEngine } from "../llmEngine.js";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const FAIL_RESET_THRESHOLD = 3;
const REDETECT_INTERVAL_MS = 60_000;
const SGLANG_STICKY_TPS_LIVE_MS = 6_000;
const HOST_ROOT = process.env.HOST_ROOT_PATH || "/host/root";
const HOST_PROC = process.env.HOST_PROC_PATH || "/host/proc";

export class LlmProbe {
  constructor(spark, port = 8888) {
    this.spark = spark;
    this.port = port;
    this.baseUrl = `http://${spark.lanIp}:${port}`;

    // State
    this.backendType = null; // 'vllm' | 'llama.cpp' | 'sglang' | 'ds4' | null
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
    this.kvCacheUsage = null;
    this.requestsRunning = null;
    this.requestsWaiting = null;
    this.ttftP95Seconds = null;
    this.ttft = null;
    this.e2eLatency = null;
    this.genTokensPerReq = null;
    this.mtpAcceptedTokens = null;
    this.mtpDraftedTokens = null;
    this.aggregateDecodeTps = null;
    this.rollingAvgE2e = null;
    this.rollingAvgTtft = null;
    this.rollingAvgTokensPerReq = null;
    this.rollingAvgTpsPerSlot = null;
    this.preemptionsTotal = null;
    this.prefixCacheHitRate = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.mtpAcceptanceRate = null;

    // DS4 engine metrics
    this.ds4Uptime = null;
    this.peakAggregateTps = 0;
    this.perStreamHigh = null;
    this.perStreamLow = null;
    this.perStreamAvg = null;
    this.totalTokensDecoded = null;
    this.dsparkAcceptRatio = null;
    this.banksLive = null;
    this.banksTotal = null;
    this.kvPagesResident = null;
    this.prefillCached = null;
    this.prefillComputed = null;
    this.specDrafts = null;
    this.specHits = null;
    this.specQuench = null;
    this.warmRecords = null;
    this.derivedArtifacts = null;
    this.derivedArtifactBytes = null;
    this.requestsStarted = null;
    this.requestsCompleted = null;
    this.requestsFailed = null;
    this.requestsRefusedDeepSerial = null;
    this.requestsInflight = null;
    this.requestsSerial = null;
    this.contAdmitRejects = null;
    this.contBatchFailures = null;
    this.graphFitRefusals = null;
    this.admitsCold = null;
    this.admitsWarm = null;
    this.admitsFork = null;
    this.admitsPartialFork = null;
    this.admitsPartialTruncate = null;
    this.decodeSteps = null;
    this.tokPerStep = null;
    this.recipeMetadata = null;
    this.recipeInfo = null;

    // DS4 per-cycle deltas + rolling window (for latency/moving-avg derivation)
    this._ds4Prev = {
      tokensDecoded: null,
      decodeSteps: null,
      requestsStarted: null,
      requestsCompleted: null,
      prefillComputed: null,
      prefillCached: null,
      time: 0,
    };
    this._ds4Rolling = [];

    this._consecutiveFailures = 0;
    this._lastDetectAt = 0;
    this._vllmMetricsParser = new VllmMetricsParser();
    this._engineHint = this._preferredEngine();
    this._sglangStickyTps = null;
  }

  _preferredEngine() {
    return normalizeLlmEngine(this.spark?.llmEngine);
  }

  /** Re-detect when Edit Spark / card settings change vLLM vs SGLang. */
  syncPreferredEngine() {
    const next = this._preferredEngine();
    if (next !== this._engineHint) {
      this._engineHint = next;
      this._resetDetection();
      this._lastDetectAt = 0;
      this._consecutiveFailures = 0;
    }
  }

  /** Update probe port (and host from spark). Resets detection when the target changes. */
  setPort(port) {
    const next = Number(port);
    const prevUrl = this.baseUrl;
    if (Number.isInteger(next) && next >= 1 && next <= 65535) {
      this.port = next;
    }
    this.baseUrl = `http://${this.spark.lanIp}:${this.port}`;
    if (this.baseUrl !== prevUrl) {
      this._resetDetection();
      this._lastDetectAt = 0;
      this._consecutiveFailures = 0;
    }
  }

  /** Probe the LLM server and return a snapshot. */
  async probe() {
    try {
      this.syncPreferredEngine();
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
        if (this.backendType === "ds4") {
          const snap = await this._probeDs4();
          this._noteSuccess();
          return snap;
        }
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
  }

  _noteFailure(message) {
    this.error = message;
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
    this.ttft = null;
    this.e2eLatency = null;
    this.genTokensPerReq = null;
    this.mtpAcceptedTokens = null;
    this.mtpDraftedTokens = null;
    this.aggregateDecodeTps = null;
    this.rollingAvgE2e = null;
    this.rollingAvgTtft = null;
    this.rollingAvgTokensPerReq = null;
    this.rollingAvgTpsPerSlot = null;
    this.preemptionsTotal = null;
    this.prefixCacheHitRate = null;
    this.e2eP95Seconds = null;
    this.itlP95Seconds = null;
    this.mtpAcceptanceRate = null;
    // DS4
    this.ds4Uptime = null;
    this.peakAggregateTps = 0;
    this.perStreamHigh = null;
    this.perStreamLow = null;
    this.perStreamAvg = null;
    this.totalTokensDecoded = null;
    this.dsparkAcceptRatio = null;
    this.banksLive = null;
    this.banksTotal = null;
    this.kvPagesResident = null;
    this.prefillCached = null;
    this.prefillComputed = null;
    this.specDrafts = null;
    this.specHits = null;
    this.specQuench = null;
    this.warmRecords = null;
    this.derivedArtifacts = null;
    this.derivedArtifactBytes = null;
    this.requestsStarted = null;
    this.requestsCompleted = null;
    this.requestsFailed = null;
    this.requestsRefusedDeepSerial = null;
    this.requestsInflight = null;
    this.requestsSerial = null;
    this.contAdmitRejects = null;
    this.contBatchFailures = null;
    this.graphFitRefusals = null;
    this.admitsCold = null;
    this.admitsWarm = null;
    this.admitsFork = null;
    this.admitsPartialFork = null;
    this.admitsPartialTruncate = null;
    this.decodeSteps = null;
    this.tokPerStep = null;
    this.recipeMetadata = null;
    this.recipeInfo = null;
    this._ds4Prev = {
      tokensDecoded: null,
      decodeSteps: null,
      requestsStarted: null,
      requestsCompleted: null,
      prefillComputed: null,
      prefillCached: null,
      time: 0,
    };
    this._ds4Rolling = [];
    this.slotState.clear();
    this.lastTokenCounts = { input: 0, output: 0 };
    this._sglangStickyTps = null;
  }

  // ─── Server type detection ───────────────────────────────
  async _detectServerType() {
    const preferred = this._preferredEngine();

    // llama.cpp /slots — skip when the user forced vLLM or SGLang
    if (preferred !== "vllm" && preferred !== "sglang") {
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
    }

    // Try OpenAI-compatible
    try {
      const modelRes = await this._fetch(`${this.baseUrl}/v1/models`);
      if (modelRes.ok) {
        this.serverIsOpenAI = true;
        try {
          const modelsData = await modelRes.clone().json();
          const model = modelsData?.data?.[0];
          if (model?.owned_by === "ds4.c") {
            this.backendType = "ds4";
            this.modelId = model?.id || null;
            this.contextLength = model?.context_length || null;
            this.recipeMetadata = {
              name: model?.id || null,
              model: model?.name || null,
              contextLength: model?.context_length || null,
              ownedBy: model?.owned_by || null,
              supportedParameters: model?.supported_parameters || [],
            };
            return;
          }
          if (typeof model?.owned_by === "string" && /sglang/i.test(model.owned_by)) {
            this.backendType = "sglang";
            return;
          }
        } catch {}
        if (preferred === "sglang") {
          this.backendType = "sglang";
          return;
        }
        if (preferred === "ollama") {
          this.backendType = "ollama";
          return;
        }
        if (preferred === "vllm") {
          this.backendType = "vllm";
          return;
        }
        if (await this._probeIsSglang()) {
          this.backendType = "sglang";
          return;
        }
        try {
          const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
          if (metricsRes.ok) {
            const txt = await metricsRes.text();
            if (/(?:^|\n)sglang[:_]/.test(txt) && !/(?:^|\n)vllm:/.test(txt)) {
              this.backendType = "sglang";
              return;
            }
          }
        } catch {}
        this.backendType = "vllm";
        return;
      }
    } catch {}

    this.serverIsOpenAI = null;
    this.backendType = null;
  }

  async _probeIsSglang() {
    for (const path of ["/get_server_info", "/server_info"]) {
      try {
        const res = await this._fetch(`${this.baseUrl}${path}`);
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        if (data && typeof data === "object" && !Array.isArray(data)) return true;
      } catch {}
    }
    return false;
  }

  // ─── DS4 engine path ─────────────────────────────────────
  async _probeDs4() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    // Model info from /v1/models
    let modelsOk = false;
    try {
      const modelsRes = await this._fetch(`${this.baseUrl}/v1/models`);
      if (modelsRes.ok) {
        modelsOk = true;
        const modelsData = await modelsRes.json();
        const model = modelsData?.data?.[0];
        this.modelId = model?.id || null;
        this.contextLength = model?.context_length || null;
        this.recipeMetadata = {
          name: model?.id || null,
          model: model?.name || null,
          contextLength: model?.context_length || null,
          ownedBy: model?.owned_by || null,
          supportedParameters: model?.supported_parameters || [],
        };
      }
    } catch {}

    if (!modelsOk) {
      throw new Error("ds4 /v1/models unreachable");
    }

    // Parse /metrics
    try {
      const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
      if (metricsRes.ok) {
        const txt = await metricsRes.text();

        // Gauges
        this.ds4Uptime = this._getDs4Metric(txt, "ds4_uptime_seconds");
        this.generationTps = this._getDs4Metric(txt, "ds4_decode_tok_s") ?? 0;
        this.prefillTps = this._getDs4Metric(txt, "ds4_prefill_tok_s") ?? 0;
        this.dsparkAcceptRatio = this._getDs4Metric(txt, "ds4_spec_accept_ratio");
        this.tokPerStep = this._getDs4Metric(txt, "ds4_tok_per_step");
        this.banksLive = this._getDs4Metric(txt, "ds4_banks_live");
        this.banksTotal = this._getDs4Metric(txt, "ds4_banks_total");
        this.kvPagesResident = this._getDs4Metric(txt, "ds4_kv_pages_resident");
        this.warmRecords = this._getDs4Metric(txt, "ds4_warm_records");
        this.derivedArtifacts = this._getDs4Metric(txt, "ds4_derived_artifacts");
        this.derivedArtifactBytes = this._getDs4Metric(txt, "ds4_derived_artifact_bytes");
        this.requestsInflight = this._getDs4Metric(txt, "ds4_requests_inflight");

        // Counters
        this.totalTokensDecoded = this._getDs4Metric(txt, "ds4_tokens_decoded_total");
        this.decodeSteps = this._getDs4Metric(txt, "ds4_decode_steps_total");
        this.specDrafts = this._getDs4Metric(txt, "ds4_spec_drafts_total");
        this.specHits = this._getDs4Metric(txt, "ds4_spec_hits_total");
        this.specQuench = this._getDs4Metric(txt, "ds4_spec_quench_total");
        this.requestsStarted = this._getDs4Metric(txt, "ds4_requests_started_total");
        this.requestsSerial = this._getDs4Metric(txt, "ds4_requests_serial_total");
        this.contAdmitRejects = this._getDs4Metric(txt, "ds4_cont_admit_rejects_total");
        this.contBatchFailures = this._getDs4Metric(txt, "ds4_cont_batch_failures_total");
        this.graphFitRefusals = this._getDs4Metric(txt, "ds4_graph_fit_refusals_total");

        // Labeled counters
        this.requestsCompleted = this._getDs4LabeledMetric(txt, "ds4_requests_total", "outcome", "completed");
        this.requestsFailed = this._getDs4LabeledMetric(txt, "ds4_requests_total", "outcome", "failed");
        this.requestsRefusedDeepSerial = this._getDs4LabeledMetric(txt, "ds4_requests_total", "outcome", "refused_deep_serial");
        this.prefillCached = this._getDs4LabeledMetric(txt, "ds4_tokens_prefilled_total", "kind", "cached");
        this.prefillComputed = this._getDs4LabeledMetric(txt, "ds4_tokens_prefilled_total", "kind", "computed");
        this.admitsCold = this._getDs4LabeledMetric(txt, "ds4_admits_total", "kind", "cold");
        this.admitsWarm = this._getDs4LabeledMetric(txt, "ds4_admits_total", "kind", "warm");
        this.admitsFork = this._getDs4LabeledMetric(txt, "ds4_admits_total", "kind", "fork");
        this.admitsPartialFork = this._getDs4LabeledMetric(txt, "ds4_admits_total", "kind", "partial_fork");
        this.admitsPartialTruncate = this._getDs4LabeledMetric(txt, "ds4_admits_total", "kind", "partial_truncate");

        // Slots = banks_live (active lanes), slotsTotal = banks_total
        this.slotsActive = this.banksLive != null ? Math.round(this.banksLive) : 0;
        this.slotsTotal = this.banksTotal != null ? Math.round(this.banksTotal) : 0;
        this.requestsRunning = this.requestsInflight;

        // Total output tokens from decoded counter
        if (this.totalTokensDecoded != null) {
          this.totalOutputTokens = Math.round(this.totalTokensDecoded);
        }

        // Track peak aggregate tok/s
        const currentAggregate = this.generationTps;
        if (currentAggregate > this.peakAggregateTps) {
          this.peakAggregateTps = currentAggregate;
        }

        // Per-stream tracking: use banks_live as the number of active streams
        // When inflight > 0, per-stream = decode_tok_s / inflight
        const inflight = this.requestsInflight != null ? this.requestsInflight : 0;
        if (inflight > 0 && currentAggregate > 0) {
          const perStream = currentAggregate / inflight;
          if (this.perStreamHigh == null || perStream > this.perStreamHigh) {
            this.perStreamHigh = Math.round(perStream * 100) / 100;
          }
          if (this.perStreamLow == null || perStream < this.perStreamLow) {
            this.perStreamLow = Math.round(perStream * 100) / 100;
          }
          this.perStreamAvg = Math.round(perStream * 100) / 100;
        }

        // MTP/spec acceptance — use ds4_spec_accept_ratio as the gauge
        this.mtpAcceptanceRate = this.dsparkAcceptRatio;
        this.mtpAcceptedTokens = this.specHits;
        this.mtpDraftedTokens = this.specDrafts;

        // ── Derive latency, genTokensPerReq, and rolling averages from
        //    ds4 counter deltas (ds4 has no latency histograms, so we
        //    approximate from throughput + completed-request counts). ──
        const nowMs = Date.now();
        const prev = this._ds4Prev;
        const dt = prev.time > 0 ? (nowMs - prev.time) / 1000 : 0;

        const deltaDecoded =
            this.totalTokensDecoded != null && prev.tokensDecoded != null
                ? Math.max(0, this.totalTokensDecoded - prev.tokensDecoded)
                : 0;
        const deltaSteps =
            this.decodeSteps != null && prev.decodeSteps != null
                ? Math.max(0, this.decodeSteps - prev.decodeSteps)
                : 0;
        const deltaStarted =
            this.requestsStarted != null && prev.requestsStarted != null
                ? Math.max(0, this.requestsStarted - prev.requestsStarted)
                : 0;
        const deltaCompleted =
            this.requestsCompleted != null && prev.requestsCompleted != null
                ? Math.max(0, this.requestsCompleted - prev.requestsCompleted)
                : 0;
        const deltaPrefillComputed =
            this.prefillComputed != null && prev.prefillComputed != null
                ? Math.max(0, this.prefillComputed - prev.prefillComputed)
                : 0;

        // Per-request average tokens (generation) — if requests completed
        // this cycle, avg tokens per request = deltaDecoded / deltaCompleted.
        // Fallback to cumulative if we have totals.
        if (deltaCompleted > 0) {
          this.genTokensPerReq =
              Math.round((deltaDecoded / deltaCompleted) * 100) / 100;
        } else if (this.requestsCompleted != null && this.requestsCompleted > 0) {
          this.genTokensPerReq =
              Math.round((this.totalTokensDecoded / this.requestsCompleted) * 100) / 100;
        }

        // Approximate TTFT: prefill time for the average request.
        // Use counter-based prefill rate (deltaPrefillComputed / dt) instead of
        // the instantaneous prefillTps gauge, which is near-zero between bursts.
        const prefillRate = dt > 0 && deltaPrefillComputed > 0
            ? deltaPrefillComputed / dt
            : this.prefillTps;
        if (deltaCompleted > 0 && deltaPrefillComputed > 0 && prefillRate > 0) {
          const avgPromptTokens = deltaPrefillComputed / deltaCompleted;
          this.ttft = Math.round((avgPromptTokens / prefillRate) * 1000) / 1000;
          this.ttftP95Seconds = this.ttft; // best estimate (no histogram)
        }

        // Approximate E2E: TTFT + decode time for avg request.
        // decode time ≈ avgGenTokens / decodeRate, where decodeRate = generationTps / inflight.
        if (deltaCompleted > 0 && this.genTokensPerReq != null && this.genTokensPerReq > 0) {
          const inflight = this.requestsInflight != null ? Math.max(1, this.requestsInflight) : 1;
          const decodeRate = this.generationTps > 0 ? this.generationTps / inflight : 0;
          const ttftEst = this.ttft ?? 0;
          if (decodeRate > 0) {
            const decodeTime = this.genTokensPerReq / decodeRate;
            this.e2eLatency = Math.round((ttftEst + decodeTime) * 1000) / 1000;
            this.e2eP95Seconds = this.e2eLatency;
          } else {
            this.e2eLatency = Math.round(ttftEst * 1000) / 1000;
            this.e2eP95Seconds = this.e2eLatency;
          }
        }

        // ── Rolling window: last 10 completed-request batches ──
        if (deltaCompleted > 0 && this.e2eLatency != null) {
          const activeSlots = this.banksLive != null ? Math.max(1, this.banksLive) : 1;
          const tpsPerSlot = dt > 0 && this.generationTps > 0
              ? this.generationTps / activeSlots
              : 0;
          const tokensPerReq = (deltaPrefillComputed + deltaDecoded) / deltaCompleted;

          this._ds4Rolling.push({
            e2e: this.e2eLatency,
            ttft: this.ttft ?? 0,
            tokens: tokensPerReq,
            tpsPerSlot: Math.round(tpsPerSlot * 100) / 100,
          });
          if (this._ds4Rolling.length > 10) {
            this._ds4Rolling = this._ds4Rolling.slice(-10);
          }
        }

        // Compute rolling averages
        if (this._ds4Rolling.length > 0) {
          const n = this._ds4Rolling.length;
          let sumE2e = 0, sumTtft = 0, sumTokens = 0, sumTps = 0;
          for (const r of this._ds4Rolling) {
            sumE2e += r.e2e;
            sumTtft += r.ttft;
            sumTokens += r.tokens;
            sumTps += r.tpsPerSlot;
          }
          this.rollingAvgE2e = Math.round((sumE2e / n) * 1000) / 1000;
          this.rollingAvgTtft = Math.round((sumTtft / n) * 1000) / 1000;
          this.rollingAvgTokensPerReq = Math.round((sumTokens / n) * 100) / 100;
          this.rollingAvgTpsPerSlot = Math.round((sumTps / n) * 100) / 100;
        }

        // Aggregate decode TPS alias
        this.aggregateDecodeTps = this.generationTps;

        // Save state for next cycle
        this._ds4Prev = {
          tokensDecoded: this.totalTokensDecoded,
          decodeSteps: this.decodeSteps,
          requestsStarted: this.requestsStarted,
          requestsCompleted: this.requestsCompleted,
          prefillComputed: this.prefillComputed,
          prefillCached: this.prefillCached,
          time: nowMs,
        };
      }
    } catch {}

    this.backendType = "ds4";
    this._collectRecipeInfo();
    return this._getSnapshot();
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

    const preferred = this._preferredEngine();
    const forceSglang = preferred === "sglang" || this.backendType === "sglang";
    const skipSglang = preferred === "vllm" && this.backendType !== "sglang";

    if (!skipSglang && (forceSglang || this.backendType !== "vllm")) {
      try {
        const sgRes = await this._fetch(`${this.baseUrl}/get_server_info`);
        if (sgRes.ok) {
          this.backendType = "sglang";
          const sgData = await sgRes.json();
          this._applySglangServerInfo(sgData, dtSec);
        }
      } catch {}
      if (this.backendType !== "sglang") {
        try {
          const sgRes = await this._fetch(`${this.baseUrl}/server_info`);
          if (sgRes.ok) {
            this.backendType = "sglang";
            const sgData = await sgRes.json();
            this._applySglangServerInfo(sgData, dtSec);
          }
        } catch {}
      }
    }

    if (this.backendType === "sglang" || forceSglang) {
      this.backendType = "sglang";
      try {
        const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
        if (metricsRes.ok) {
          this._applySglangMetrics(await metricsRes.text(), dtSec);
        }
      } catch {}
      this._collectRecipeInfo();
      return this._getSnapshot();
    }

    // Single /metrics fetch: tok/s + slots/sleep (vLLM exposes max_model_len via /v1/models)
      try {
        const metricsRes = await this._fetch(`${this.baseUrl}/metrics`);
        if (metricsRes.ok) {
          const txt = await metricsRes.text();

          const promptTokens = this._getVllmMetric(txt, "prompt_tokens_total");
          const genTokens = this._getVllmMetric(txt, "generation_tokens_total");
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
          this.requestsRunning = running;
          if (running != null) this.slotsActive = Math.round(running);

          if (this.gpuMemoryUtilization == null) {
            const sleepState = this._getVllmMetric(txt, "engine_sleep_state");
            if (sleepState != null) this.gpuMemoryUtilization = sleepState;
          }

          this.requestsWaiting = this._getVllmMetric(txt, "num_requests_waiting");
          this.kvCacheUsage = this._getVllmMetric(txt, "kv_cache_usage_perc");
          this.preemptionsTotal = this._getVllmMetric(txt, "num_preemptions_total");

          const ttftHist = this._parseVllmHistogram(txt, "vllm:time_to_first_token_seconds");
          const ttftP95 = this._histogramQuantile(ttftHist.buckets, ttftHist.total, 0.95);
          this.ttftP95Seconds = ttftP95 == null ? null : Math.round(ttftP95 * 1000) / 1000;

          const e2eHist = this._parseVllmHistogram(txt, "vllm:e2e_request_latency_seconds");
          const e2eP95 = this._histogramQuantile(e2eHist.buckets, e2eHist.total, 0.95);
          this.e2eP95Seconds = e2eP95 == null ? null : Math.round(e2eP95 * 1000) / 1000;

          const itlHist = this._parseVllmHistogram(txt, "vllm:inter_token_latency_seconds");
          const itlP95 = this._histogramQuantile(itlHist.buckets, itlHist.total, 0.95);
          this.itlP95Seconds = itlP95 == null ? null : Math.round(itlP95 * 1000) / 1000;

          const prefixHits = this._getVllmMetric(txt, "prefix_cache_hits_total");
          const prefixQueries = this._getVllmMetric(txt, "prefix_cache_queries_total");
          this.prefixCacheHitRate =
            prefixHits != null && prefixQueries != null && prefixQueries > 0
              ? Math.round((prefixHits / prefixQueries) * 10000) / 10000
              : null;

          const mtpAccepted = this._getVllmMetric(txt, "spec_decode_num_accepted_tokens_total");
          const mtpDrafted = this._getVllmMetric(txt, "spec_decode_num_draft_tokens_total");
          const vllmMetrics = this._vllmMetricsParser.parse(txt, dtSec);
          if (vllmMetrics) {
            this.ttft = vllmMetrics.ttft;
            this.e2eLatency = vllmMetrics.e2eRequestLatency;
            this.genTokensPerReq = vllmMetrics.generationTokensPerRequest;
            this.mtpAcceptedTokens = vllmMetrics.specAcceptedTokens;
            this.mtpDraftedTokens = vllmMetrics.specDraftedTokens;
            this.aggregateDecodeTps = vllmMetrics.generationTpsFromCounters;
            if (vllmMetrics.rolling) {
              this.rollingAvgE2e = vllmMetrics.rolling.avgE2eLatency;
              this.rollingAvgTtft = vllmMetrics.rolling.avgTtft;
              this.rollingAvgTokensPerReq = vllmMetrics.rolling.avgTokensPerRequest;
              this.rollingAvgTpsPerSlot = vllmMetrics.rolling.avgTpsPerSlot;
            }
          }

          this.mtpAcceptanceRate =
            mtpAccepted != null && mtpDrafted != null && mtpDrafted > 0
              ? Math.round((mtpAccepted / mtpDrafted) * 10000) / 10000
              : null;
        }
      } catch {}

    this.backendType = "vllm";
    this._collectRecipeInfo();

    return this._getSnapshot();
  }

  // ─── llama.cpp native path ────────────────────────────────
  async _probeLlamaCpp() {
    const now = Date.now();
    const dtSec = (now - this.lastProbeTime) / 1000;
    this.lastProbeTime = now;

    let slotsOk = false;
    try {
      const slotsRes = await this._fetch(`${this.baseUrl}/slots`);
      if (slotsRes.ok) {
        const slots = await slotsRes.json();
        if (Array.isArray(slots)) {
          slotsOk = true;
          this.slotsTotal = slots.length;
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

  // ─── SGLang helpers ─────────────────────────────────────
  static _positiveNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  static _sglangLastGenThroughput(sgData) {
    if (!sgData || typeof sgData !== "object") return null;
    const top = Number(sgData.last_gen_throughput);
    if (Number.isFinite(top) && top >= 0) return top;
    const states = sgData.internal_states;
    if (!Array.isArray(states) || !states.length) return null;
    let best = null;
    for (const st of states) {
      if (!st || typeof st !== "object") continue;
      const v = Number(st.last_gen_throughput);
      if (!Number.isFinite(v) || v < 0) continue;
      if (best == null || v > best) best = v;
    }
    return best;
  }

  _sglangStickyThroughput(raw) {
    if (raw == null || !Number.isFinite(raw) || raw < 0) {
      this._sglangStickyTps = null;
      return 0;
    }
    const rounded = Math.round(raw * 100) / 100;
    const now = Date.now();
    const prev = this._sglangStickyTps;
    if (!prev) {
      this._sglangStickyTps = { value: rounded, liveUntil: 0 };
      return 0;
    }
    if (rounded !== prev.value) {
      this._sglangStickyTps = { value: rounded, liveUntil: now + SGLANG_STICKY_TPS_LIVE_MS };
      return rounded;
    }
    if (prev.liveUntil > now) return rounded;
    return 0;
  }

  _applySglangServerInfo(sgData, dtSec) {
    const explicitCtx =
      LlmProbe._positiveNumber(sgData.context_length) ??
      LlmProbe._positiveNumber(sgData.max_total_tokens);
    if (explicitCtx != null) this.contextLength = explicitCtx;

    const maxRunning = Number(sgData.max_running_requests);
    if (Number.isFinite(maxRunning) && maxRunning > 0) {
      this.slotsTotal = Math.round(maxRunning);
    }

    const inTok = sgData.total_input_tokens;
    const outTok = sgData.total_output_tokens;
    if (inTok != null && outTok != null) {
      const input = Number(inTok);
      const output = Number(outTok);
      if (Number.isFinite(input) && Number.isFinite(output)) {
        const deltaIn = input - this.lastTokenCounts.input;
        const deltaOut = output - this.lastTokenCounts.output;
        this.lastTokenCounts.input = input;
        this.lastTokenCounts.output = output;
        this.totalOutputTokens = output;
        if (dtSec > 0 && dtSec < 10) {
          this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
          this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
        }
        return;
      }
    }
    this.generationTps = this._sglangStickyThroughput(LlmProbe._sglangLastGenThroughput(sgData));
  }

  _sglangMetric(txt, name) {
    return this._getPromMetric(txt, `sglang:${name}`) ?? this._getPromMetric(txt, `sglang_${name}`);
  }

  _applySglangMetrics(txt, dtSec) {
    const gen = this._sglangMetric(txt, "generation_tokens_total");
    const prompt = this._sglangMetric(txt, "prompt_tokens_total");
    if (gen != null) {
      if (dtSec > 0 && dtSec < 10) {
        const deltaOut = gen - this.lastTokenCounts.output;
        this.generationTps = Math.max(0, Math.round((deltaOut / dtSec) * 100) / 100);
        if (prompt != null) {
          const deltaIn = prompt - this.lastTokenCounts.input;
          this.prefillTps = Math.max(0, Math.round((deltaIn / dtSec) * 100) / 100);
          this.lastTokenCounts.input = prompt;
        }
      }
      this.lastTokenCounts.output = gen;
      this.totalOutputTokens = gen;
    } else {
      const gauge = this._sglangMetric(txt, "gen_throughput");
      if (gauge != null) {
        this.generationTps = Math.max(0, Math.round(gauge * 100) / 100);
      }
    }

    const running = this._sglangMetric(txt, "num_running_reqs");
    if (running != null) {
      this.requestsRunning = running;
      this.slotsActive = Math.round(running);
    }
    const waiting = this._sglangMetric(txt, "num_queue_reqs");
    if (waiting != null) this.requestsWaiting = waiting;

    const tokenUsage = this._sglangMetric(txt, "token_usage");
    if (tokenUsage != null) this.kvCacheUsage = tokenUsage;

    const cacheHit = this._sglangMetric(txt, "cache_hit_rate");
    if (cacheHit != null) this.prefixCacheHitRate = Math.round(cacheHit * 10000) / 10000;

    const specRate = this._sglangMetric(txt, "spec_accept_rate");
    const specLen = this._sglangMetric(txt, "spec_accept_length");
    if (specRate != null) this.mtpAcceptanceRate = Math.round(specRate * 10000) / 10000;
    else if (specLen != null) this.mtpAcceptanceRate = Math.round(specLen * 10000) / 10000;

    const ttftHist = this._parseVllmHistogram(txt, "sglang:time_to_first_token_seconds");
    const ttftP95 = this._histogramQuantile(ttftHist.buckets, ttftHist.total, 0.95);
    if (ttftP95 != null) this.ttftP95Seconds = Math.round(ttftP95 * 1000) / 1000;
  }

  _getPromMetric(body, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
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

  // ─── DS4 metrics helpers ──────────────────────────────────
  /** Extract a plain ds4_* gauge/counter (sum across all label permutations). */
  _getDs4Metric(body, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
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

  /** Extract a labeled ds4_* counter for a specific label=value pair. */
  _getDs4LabeledMetric(body, name, label, value) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const labelEsc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const valueEsc = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `^${esc}\\{[^}]*\\b${labelEsc}="${valueEsc}"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$`,
      "gm"
    );
    let m;
    while ((m = re.exec(body)) !== null) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v)) return v;
    }
    return null;
  }

  // ─── vLLM metrics helpers ─────────────────────────────
  _getVllmMetric(body, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  _parseVllmHistogram(body, metricPrefix) {
    const esc = metricPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    if (total != null && infCount > 0 && Math.abs(infCount - total) > 1e-6) {
      return { buckets: [], total: null };
    }
    const buckets = Array.from(byUpper, ([upper, count]) => ({ upper, count }));
    buckets.sort((a, b) => a.upper - b.upper);
    return { buckets, total };
  }

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
    if (slot.n_decoded != null) {
      if (Array.isArray(slot.n_decoded)) return slot.n_decoded[0] || 0;
      return slot.n_decoded || 0;
    }
    if (Array.isArray(slot.next_token) && slot.next_token[0]?.n_decoded != null) {
      return slot.next_token[0].n_decoded;
    }
    return 0;
  }

  _getSlotPrefilled(slot) {
    return slot.n_prompt_tokens_processed || slot.n_prompt_tokens || 0;
  }

  // ─── Recipe info / attribution collection ────────────────
  /**
   * Collect rich recipe info (engine type, model, container, author, config badges)
   * by inspecting the host process environment and command line.
   * Called once per probe cycle; cheap because it caches and short-circuits.
   */
  _collectRecipeInfo() {
    try {
      if (this.backendType === "ds4") {
        this.recipeInfo = this._collectDs4RecipeInfo();
      } else if (this.backendType === "vllm") {
        this.recipeInfo = this._collectVllmRecipeInfo();
      } else if (this.backendType === "sglang") {
        this.recipeInfo = this._collectSglangRecipeInfo();
      } else {
        this.recipeInfo = null;
      }
    } catch(e) {
      console.error("[ds4-recipe] ERROR:", e.message, e.stack?.substring(0, 200));
      this.recipeInfo = null;
    }
  }

  /** Find the PID of the process listening on this.port by scanning host /proc. */
  _findHostPid() {
    try {
      const procDir = HOST_PROC;
      const entries = readdirSync(procDir);
      for (const pid of entries) {
        if (!/^\d+$/.test(pid)) continue;
        const cmdlinePath = `${procDir}/${pid}/cmdline`;
        try {
          const cmdline = readFileSync(cmdlinePath, "utf8");
          const parts = cmdline.split("\0").filter(Boolean);
          if (parts.length === 0) continue;
          // ds4-server or vllm or python processes
          const exe = parts[0].toLowerCase();
          if (exe.includes("ds4-server") || exe.includes("ds4")) {
            // Check if this process has --port matching our port
            const portArg = parts.find((p, i) => parts[i - 1] === "--port" && /^\d+$/.test(p));
            if (portArg && parseInt(portArg) === this.port) return parseInt(pid);
            // Also check for --host 0.0.0.0 --port <port> pattern
            const allArgs = parts.join(" ");
            if (allArgs.includes(`--port ${this.port}`) || allArgs.includes(`port=${this.port}`)) return parseInt(pid);
          }
          if (exe.includes("sglang") || exe.includes("vllm") || exe.includes("python")) {
            const allArgs = parts.join(" ");
            if (allArgs.includes(`--port ${this.port}`) || allArgs.includes(`port=${this.port}`)) return parseInt(pid);
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  /** Collect recipe info for the ds4 CUDA engine backend. */
  _collectDs4RecipeInfo() {
    const pid = this._findHostPid();
    if (!pid) return null;

    let environ = {};
    let cmdline = "";
    try {
      const envRaw = readFileSync(`${HOST_PROC}/${pid}/environ`, "utf8");
      for (const pair of envRaw.split("\0")) {
        if (!pair) continue;
        const eq = pair.indexOf("=");
        if (eq > 0) environ[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    } catch {}
    try {
      cmdline = readFileSync(`${HOST_PROC}/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch {}

    // Parse model file from cmdline: -m <path>
    const modelMatch = cmdline.match(/-m\s+(\S+)/);
    const modelPath = modelMatch ? modelMatch[1] : null;
    const modelFile = modelPath ? modelPath.split("/").pop() : null;

    // Detect quantization from model filename
    let quantization = null;
    if (modelFile) {
      if (/IQ2XXS/i.test(modelFile)) quantization = "IQ2XXS";
      else if (/IQ3/i.test(modelFile)) quantization = "IQ3";
      else if (/IQ4/i.test(modelFile)) quantization = "IQ4";
      else if (/Q2K/i.test(modelFile)) quantization = "Q2_K";
      else if (/Q4_K/i.test(modelFile)) quantization = "Q4_K";
      else if (/Q8_0/i.test(modelFile)) quantization = "Q8_0";
      else if (/FP8/i.test(modelFile)) quantization = "FP8";
      else if (/NVFP4/i.test(modelFile)) quantization = "NVFP4";
    }

    // Context length from cmdline: -c <num> (take last occurrence)
    let contextLength = this.contextLength;
    const ctxMatches = [...cmdline.matchAll(/-c\s+(\d+)/g)];
    if (ctxMatches.length > 0) {
      contextLength = parseInt(ctxMatches[ctxMatches.length - 1][1]);
    }

    // Max lanes from DS4_BATCH_FIT_HEADROOM_MB (maps to banks_total)
    const maxLanes = this.banksTotal ?? null;

    // DSpark config
    const dsparkEnabled = environ.DS4_CONT_DSPARK === "1" || environ.DS4_CONT_DSPARK === "true";
    const mtpMode = environ.DS4_CONT_MTP_MODE || null;
    const dsparkModel = environ.DS4_DSPARK_MODEL || null;

    let specDecodeMethod = null;
    if (dsparkEnabled) {
      const drafterFile = dsparkModel ? dsparkModel.split("/").pop() : null;
      // k value: MTP mode 2 = k=4 for DSpark typically
      const k = mtpMode ? `k=${mtpMode}` : "k=4";
      specDecodeMethod = `DSpark ${k}`;
    } else if (mtpMode) {
      specDecodeMethod = `MTP k=${mtpMode}`;
    }

    // KV cache dtype: ds4 uses native CUDA cache, no env var for dtype
    const kvCacheDtype = "native";

    // Prefix caching: ds4 always has warm/prefix cache (warmRecords)
    const prefixCaching = this.warmRecords != null ? this.warmRecords > 0 : null;

    // Author attribution for ds4
    const author = "@bleysg";
    const authorName = "Bleys Goodson";

    // Engine type
    const engineType = "DS4 CUDA Engine";

    // Container: native build
    const containerImage = "Native build (Entrpi/ds4 fork)";

    // Model display name from recipeMetadata
    const modelName = this.recipeMetadata?.model || this.modelId || modelFile || null;

    // Accept ratio
    const acceptRatio = this.dsparkAcceptRatio ?? null;

    // Uptime
    const uptime = this.ds4Uptime ?? null;

    return {
      engineType,
      modelName,
      containerImage,
      author,
      authorName,
      contextLength,
      maxLanes,
      specDecodeMethod,
      quantization,
      gmu: null, // ds4 doesn't expose GMU directly
      kvCacheDtype,
      prefixCaching,
      acceptRatio,
      uptime,
    };
  }

  /** Collect recipe info for a vLLM container backend. */
  _collectVllmRecipeInfo() {
    // Try to find the container via docker
    let containerImage = null;
    let containerName = null;
    try {
      // List containers, find one with port mapping to this.port
      const containersRaw = execSync("docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'", {
        timeout: 5000,
        encoding: "utf8",
      });
      for (const line of containersRaw.trim().split("\n")) {
        if (!line) continue;
        const [name, image, ports] = line.split("\t");
        if (ports && ports.includes(`${this.port}->`)) {
          containerImage = image;
          containerName = name;
          break;
        }
      }
    } catch {}

    if (!containerImage) return null;

    // Try docker inspect for env vars
    let environ = {};
    if (containerName) {
      try {
        const inspectRaw = execSync(
          `docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ${containerName}`,
          { timeout: 5000, encoding: "utf8" }
        );
        for (const line of inspectRaw.trim().split("\n")) {
          if (!line) continue;
          const eq = line.indexOf("=");
          if (eq > 0) environ[line.slice(0, eq)] = line.slice(eq + 1);
        }
      } catch {}
    }

    // Try docker inspect for cmdline args
    let cmdline = "";
    if (containerName) {
      try {
        cmdline = execSync(
          `docker inspect --format '{{range .Args}}{{.}} {{end}}' ${containerName}`,
          { timeout: 5000, encoding: "utf8" }
        ).trim();
      } catch {}
    }

    // Parse model from cmdline: --model <path>
    const modelMatch = cmdline.match(/--model\s+(\S+)/);
    const modelPath = modelMatch ? modelMatch[1] : null;
    const modelFile = modelPath ? modelPath.split("/").pop() : null;

    // Detect quantization
    let quantization = null;
    const quantArg = cmdline.match(/--quantization\s+(\S+)/);
    if (quantArg) {
      quantization = quantArg[1].toUpperCase();
    } else if (modelFile) {
      if (/FP8/i.test(modelFile)) quantization = "FP8";
      else if (/NVFP4/i.test(modelFile)) quantization = "NVFP4";
      else if (/AWQ/i.test(modelFile)) quantization = "AWQ";
      else if (/GPTQ/i.test(modelFile)) quantization = "GPTQ";
    }

    // Context length from cmdline: --max-model-len <num>
    let contextLength = this.contextLength;
    const ctxMatch = cmdline.match(/--max-model-len\s+(\d+)/);
    if (ctxMatch) contextLength = parseInt(ctxMatch[1]);

    // Max lanes from cmdline: --tensor-parallel-size or --gpu-memory-utilization
    const tpMatch = cmdline.match(/--tensor-parallel-size\s+(\d+)/);
    const maxLanes = tpMatch ? parseInt(tpMatch[1]) : null;

    // Speculative decode method
    let specDecodeMethod = null;
    if (/--speculative-model/.test(cmdline) || /--speculative_config/.test(cmdline)) {
      const numSpecMatch = cmdline.match(/--num-speculative-tokens\s+(\d+)/);
      const k = numSpecMatch ? numSpecMatch[1] : "?";
      specDecodeMethod = `MTP k=${k}`;
    }

    // KV cache dtype
    let kvCacheDtype = null;
    const kvMatch = cmdline.match(/--kv-cache-dtype\s+(\S+)/);
    if (kvMatch) kvCacheDtype = kvMatch[1];
    else kvCacheDtype = "auto";

    // Prefix caching
    let prefixCaching = null;
    if (/--enable-prefix-caching/.test(cmdline)) prefixCaching = true;
    else if (/--no-prefix-caching/.test(cmdline)) prefixCaching = false;

    // GMU
    let gmu = null;
    const gmuMatch = cmdline.match(/--gpu-memory-utilization\s+([\d.]+)/);
    if (gmuMatch) gmu = parseFloat(gmuMatch[1]);

    // Author attribution for vLLM recipes
    const author = "@styles01";
    const authorName = "styles01";

    // Engine type
    const engineType = "vLLM";

    // Model display name
    const modelName = this.modelId || modelFile || null;

    // Accept ratio
    const acceptRatio = this.mtpAcceptanceRate ?? null;

    return {
      engineType,
      modelName,
      containerImage,
      author,
      authorName,
      contextLength,
      maxLanes,
      specDecodeMethod,
      quantization,
      gmu,
      kvCacheDtype,
      prefixCaching,
      acceptRatio,
      uptime: null,
    };
  }

  _collectSglangRecipeInfo() {
    const vllm = this._collectVllmRecipeInfo();
    const base = vllm || {
      engineType: "SGLang",
      modelName: this.modelId || null,
      containerImage: null,
      author: null,
      authorName: null,
      contextLength: this.contextLength,
      maxLanes: this.slotsTotal || null,
      specDecodeMethod: null,
      quantization: null,
      gmu: null,
      kvCacheDtype: null,
      prefixCaching: null,
      acceptRatio: this.mtpAcceptanceRate ?? null,
      uptime: null,
    };
    return {
      ...base,
      engineType: "SGLang",
      acceptRatio: this.mtpAcceptanceRate ?? base.acceptRatio ?? null,
      contextLength: this.contextLength ?? base.contextLength,
    };
  }

  _getSnapshot() {
    const snap = {
      available: this.serverIsOpenAI !== null,
      port: this.port,
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
      ttft: this.ttft ?? this.ttftP95Seconds,
      e2eLatency: this.e2eLatency ?? this.e2eP95Seconds,
      genTokensPerReq: this.genTokensPerReq,
      mtpAcceptedTokens: this.mtpAcceptedTokens,
      mtpDraftedTokens: this.mtpDraftedTokens,
      aggregateDecodeTps: this.aggregateDecodeTps,
      rollingAvgE2e: this.rollingAvgE2e,
      rollingAvgTtft: this.rollingAvgTtft,
      rollingAvgTokensPerReq: this.rollingAvgTokensPerReq,
      rollingAvgTpsPerSlot: this.rollingAvgTpsPerSlot,
      error: this.error,
    };

    // DS4 fields (always include — null for non-ds4 backends)
    snap.ds4Uptime = this.ds4Uptime;
    snap.peakAggregateTps = this.peakAggregateTps;
    snap.perStreamHigh = this.perStreamHigh;
    snap.perStreamLow = this.perStreamLow;
    snap.perStreamAvg = this.perStreamAvg;
    snap.totalTokensDecoded = this.totalTokensDecoded;
    snap.dsparkAcceptRatio = this.dsparkAcceptRatio;
    snap.banksLive = this.banksLive;
    snap.banksTotal = this.banksTotal;
    snap.kvPagesResident = this.kvPagesResident;
    snap.prefillCached = this.prefillCached;
    snap.prefillComputed = this.prefillComputed;
    snap.specDrafts = this.specDrafts;
    snap.specHits = this.specHits;
    snap.specQuench = this.specQuench;
    snap.warmRecords = this.warmRecords;
    snap.derivedArtifacts = this.derivedArtifacts;
    snap.derivedArtifactBytes = this.derivedArtifactBytes;
    snap.requestsStarted = this.requestsStarted;
    snap.requestsCompleted = this.requestsCompleted;
    snap.requestsFailed = this.requestsFailed;
    snap.requestsRefusedDeepSerial = this.requestsRefusedDeepSerial;
    snap.requestsInflight = this.requestsInflight;
    snap.requestsSerial = this.requestsSerial;
    snap.contAdmitRejects = this.contAdmitRejects;
    snap.contBatchFailures = this.contBatchFailures;
    snap.graphFitRefusals = this.graphFitRefusals;
    snap.admitsCold = this.admitsCold;
    snap.admitsWarm = this.admitsWarm;
    snap.admitsFork = this.admitsFork;
    snap.admitsPartialFork = this.admitsPartialFork;
    snap.admitsPartialTruncate = this.admitsPartialTruncate;
    snap.decodeSteps = this.decodeSteps;
    snap.tokPerStep = this.tokPerStep;
    snap.recipeMetadata = this.recipeMetadata;
    snap.recipeInfo = this.recipeInfo;

    return snap;
  }

  _defaultLlm() {
    const snap = {
      available: false,
      port: this.port,
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
      ttft: null,
      e2eLatency: null,
      genTokensPerReq: null,
      mtpAcceptedTokens: null,
      mtpDraftedTokens: null,
      aggregateDecodeTps: null,
      rollingAvgE2e: null,
      rollingAvgTtft: null,
      rollingAvgTokensPerReq: null,
      rollingAvgTpsPerSlot: null,
      error: this.error,
      ds4Uptime: null,
      peakAggregateTps: 0,
      perStreamHigh: null,
      perStreamLow: null,
      perStreamAvg: null,
      totalTokensDecoded: null,
      dsparkAcceptRatio: null,
      banksLive: null,
      banksTotal: null,
      kvPagesResident: null,
      prefillCached: null,
      prefillComputed: null,
      specDrafts: null,
      specHits: null,
      specQuench: null,
      warmRecords: null,
      derivedArtifacts: null,
      derivedArtifactBytes: null,
      requestsStarted: null,
      requestsCompleted: null,
      requestsFailed: null,
      requestsRefusedDeepSerial: null,
      requestsInflight: null,
      requestsSerial: null,
      contAdmitRejects: null,
      contBatchFailures: null,
      graphFitRefusals: null,
      admitsCold: null,
      admitsWarm: null,
      admitsFork: null,
      admitsPartialFork: null,
      admitsPartialTruncate: null,
      decodeSteps: null,
      tokPerStep: null,
      recipeMetadata: null,
      recipeInfo: null,
    };
    return snap;
  }

  // ─── HTTP helpers ────────────────────────────────────────
  async _fetch(url) {
    return fetch(url, { signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS) });
  }
}