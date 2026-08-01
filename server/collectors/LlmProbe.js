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

const FAIL_RESET_THRESHOLD = 3;
const REDETECT_INTERVAL_MS = 60_000;

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

    this._consecutiveFailures = 0;
    this._lastDetectAt = 0;
    this._vllmMetricsParser = new VllmMetricsParser();
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
    this.slotState.clear();
    this.lastTokenCounts = { input: 0, output: 0 };
  }

  // ─── Server type detection ───────────────────────────────
  async _detectServerType() {
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
        // Detect ds4 engine by owned_by field
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
        } catch {}
        this.backendType = "vllm";
        return;
      }
    } catch {}

    this.serverIsOpenAI = null;
    this.backendType = null;
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
      }
    } catch {}

    this.backendType = "ds4";
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
    }

    this.backendType = isSglang ? "sglang" : "vllm";

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

  _getSnapshot() {
    const snap = {
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

    return snap;
  }

  _defaultLlm() {
    const snap = {
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
    };
    return snap;
  }

  // ─── HTTP helpers ────────────────────────────────────────
  async _fetch(url) {
    return fetch(url, { signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS) });
  }
}