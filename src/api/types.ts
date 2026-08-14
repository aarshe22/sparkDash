// ─── Spark config (matches server/sparks.json) ────────────
export interface SparkConfig {
  id: string;
  name: string;
  lanIp: string;
  cx7Ip?: string | null;
  /**
   * Optional Wake-on-LAN MAC override. When empty, the server uses
   * `detectedMacAddress` from the enP7s7 interface.
   */
  macAddress?: string | null;
  /** Last MAC read from enP7s7 while the Spark was online (read-only). */
  detectedMacAddress?: string | null;
  isLocal: boolean;
  ssh: {
    host: string;
    user: string;
    auth: "key" | "pass";
    /** Request-only: never returned by GET/list */
    password?: string;
    /** Response-only: true when a password is held in server memory */
    hasPassword?: boolean;
  };
  disabledDevices?: string[];
  /** Interface names hidden from the Network panel main view */
  disabledInterfaces?: string[];
  /** HTTP port for the LLM server on this Spark (legacy single-port, prefer llmPorts) */
  llmPort?: number;
  /** HTTP ports for LLM servers on this Spark (default [8888]) */
  llmPorts?: number[];
  /**
   * Cluster role for overview + worker behavior.
   * - head / standalone: local LLM API probed
   * - worker: no local API (LLM card hidden, ports not probed)
   */
  role?: SparkRole;
  /**
   * Legacy/derived: true when role is worker. Prefer `role`.
   * Kept so existing probe/card checks keep working.
   */
  workerNode?: boolean;
  /**
   * Optional label for a worker node (cluster / model name), shown on the overview card.
   * Only meaningful when role is worker.
   */
  workerLabel?: string | null;
  /** Optional id of the head Spark this worker belongs to.
   * Only meaningful when role is worker.
   */
  workerHeadId?: string | null;
  /**
   * Standalone only: probe local LLM and show the LLM card (default true).
   * Forced true for head, forced false for worker.
   */
  llmMonitoring?: boolean;
  /** When true, storage is only updated on manual refresh, not auto-polled. */
  storagePollDisabled?: boolean;
}

export type SparkRole = "head" | "worker" | "standalone";

// ─── Hardware info ───────────────────────────────────────
export interface HardwareInfo {
  device: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryGB: number;
  gpuChip: string;
  cudaDriver: string | null;
  storageModel: string | null;
}

// ─── GPU metrics ─────────────────────────────────────────
export interface GpuMetrics {
  temperature: number;
  usage: number;
  power: {
    draw: number;
    limit: number;
    /** Estimated total system power draw (GPU + CPU + CX7/peripherals). */
    systemDraw?: number;
  };
  vram: {
    used: number;
    total: number;
    percentage: number;
    /** MemAvailable in MB — the real free memory in the shared pool. */
    available: number;
  };
  /** Top GPU processes by VRAM usage (sorted descending, max 5). */
  processes?: Array<{ pid: number; name: string; vramMB: number }>;
}

// ─── CPU metrics ─────────────────────────────────────────
export interface CpuMetrics {
  usage: number;
  temperature: number;
  draw: number;
  tdp: number;
}

// ─── RAM metrics ─────────────────────────────────────────
export interface RamMetrics {
  used: number;
  total: number;
  percentage: number;
}

// ─── Storage metrics ─────────────────────────────────────
export interface StorageMetrics {
  device: string;
  label: string;
  used: number;
  total: number;
  available: number;
  percentage: number;
  readSpeed: number;
  writeSpeed: number;
  /** Present when device is in disabledDevices; still returned for Settings UI */
  disabled?: boolean;
}

// ─── Network metrics ─────────────────────────────────────
export interface NetworkInterface {
  name: string;
  rxSpeed: number;
  txSpeed: number;
  /** IPv4 address, e.g. "192.168.1.143". null when unset. */
  ip: string | null;
  /** Interface operstate: "up" | "down" | "unknown" */
  operstate: string;
  /** Present when interface is in disabledInterfaces; still returned for Settings UI */
  disabled?: boolean;
}

export interface NetworkMetrics {
  primaryInterface: string | null;
  linkSpeedMbps: number | null;
  interfaces: NetworkInterface[];
  /** MAC of enP7s7 when present (same value persisted as detectedMacAddress). */
  wolMac?: string | null;
}

// ─── Unified memory metrics ──────────────────────────────
export interface UnifiedMemoryMetrics {
  total: number;
  gpuUsed: number;
  cpuUsed: number;
  used: number;
  available: number;
  percentage: number;
  oomRisk: "low" | "medium" | "high";
  bandwidth: {
    current: number;
    peak: number;
  };
}

// ─── Per-slot telemetry (one row per active slot) ────────
export interface SlotTelemetry {
  /** Slot index, e.g. 0..N-1 */
  id: number;
  /** Current context length of the request in that slot (tokens). */
  contextLength: number;
  /** Per-slot generation rate (tok/s). */
  tps: number;
  /** Time-to-first-token for the most recent completion (seconds). */
  ttft: number;
  /** Round-trip latency for the most recent completion (seconds). */
  roundTrip: number;
}

// ─── Recipe metadata (ds4 engine) ───────────────────────
export interface RecipeMetadata {
  name: string | null;
  model: string | null;
  contextLength: number | null;
  ownedBy: string | null;
  supportedParameters: string[];
}

// ─── Recipe info / attribution ──────────────────────────
/** Rich recipe configuration + attribution shown in the Recipe Info card. */
export interface RecipeInfo {
  /** Engine type label, e.g. "DS4 CUDA Engine", "vLLM v26", "vLLM-Moet" */
  engineType: string | null;
  /** Model display name, e.g. "DeepSeek V4 Flash" */
  modelName: string | null;
  /** Container image (vLLM) or "Native build" (ds4) */
  containerImage: string | null;
  /** Recipe author / attribution handle, e.g. "@bleysg", "@styles01" */
  author: string | null;
  /** Author display name, e.g. "Bleys Goodson" */
  authorName: string | null;
  /** Context length in tokens */
  contextLength: number | null;
  /** Max lanes / parallel context banks */
  maxLanes: number | null;
  /** Speculative decode method label, e.g. "DSpark k=4", "MTP k=2" */
  specDecodeMethod: string | null;
  /** Quantization label, e.g. "IQ2XXS", "FP8", "NVFP4" */
  quantization: string | null;
  /** GPU memory utilization (0-1) */
  gmu: number | null;
  /** KV cache dtype label, e.g. "fp8", "auto" */
  kvCacheDtype: string | null;
  /** Prefix caching enabled */
  prefixCaching: boolean | null;
  /** DSpark / MTP acceptance ratio (0-1) */
  acceptRatio: number | null;
  /** Engine uptime in seconds */
  uptime: number | null;
}

// ─── LLM metrics ─────────────────────────────────────────
export interface LlmMetrics {
  available: boolean;
  /** HTTP port this probe is watching (vLLM / llama.cpp / sglang / ds4). */
  port?: number;
  backend: "vllm" | "llama.cpp" | "sglang" | "ds4" | null;
  modelId: string | null;
  modelPath: string | null;
  contextLength: number | null;
  /** GPU memory utilization for the LLM engine (0–1), e.g. 0.9. Only from vLLM internal info. */
  gpuMemoryUtilization: number | null;
  slotsActive: number;
  slotsTotal: number;
  generationTps: number;
  prefillTps: number;
  /** Cumulative total output (generation) tokens as reported by the LLM server */
  totalOutputTokens: number;
  /** vLLM KV cache usage fraction (0–1). null when backend !== vllm or unreachable. */
  kvCacheUsage?: number | null;
  /** vLLM running request count. null when unavailable. */
  requestsRunning?: number | null;
  /** vLLM waiting request count. null when unavailable. */
  requestsWaiting?: number | null;
  /** vLLM time-to-first-token p95 in seconds. null when unavailable. */
  ttftP95Seconds?: number | null;
  /** vLLM cumulative preemption count. null when unavailable. */
  preemptionsTotal?: number | null;
  /** vLLM prefix-cache hit rate (hits/queries, 0–1). null when unavailable. */
  prefixCacheHitRate?: number | null;
  /** vLLM end-to-end request latency p95 in seconds. null when unavailable. */
  e2eP95Seconds?: number | null;
  /** vLLM inter-token latency p95 in seconds. null when unavailable. */
  itlP95Seconds?: number | null;
  /** vLLM speculative/MTP acceptance rate (accepted/drafted, 0–1). null when unavailable. */
  mtpAcceptanceRate?: number | null;
  error: string | null;

  // ── Expanded telemetry (all optional — populated when the backend exposes it) ──
  /** Running (decoding) slots — vLLM num_requests_running. */
  runningSlots?: number;
  /** Waiting (queued) slots — vLLM num_requests_waiting. */
  waitingSlots?: number;
  /** KV cache utilization 0–1. */
  kvCacheUsage?: number;
  /** Average time-to-first-token over the last sampling window (seconds). */
  ttft?: number;
  /** Histogram of TTFT samples (seconds), oldest→newest. */
  ttftHistogram?: number[];
  /** Inter-token latency (ms/token) for the last sampling window. */
  interTokenLatency?: number;
  /** Average end-to-end latency per request over the last window (seconds). */
  e2eLatency?: number;
  /** Average prompt tokens per request. */
  promptTokensPerReq?: number;
  /** Average generated tokens per request. */
  genTokensPerReq?: number;
  /** Multi-Token Prediction / speculative-decoding acceptance rate (0–1). */
  mtpAcceptanceRate?: number;
  /** Tokens accepted by the verifier. */
  mtpAcceptedTokens?: number;
  /** Tokens drafted by the proposer. */
  mtpDraftedTokens?: number;
  /** Prefix cache hit rate (0–1). */
  prefixCacheHitRate?: number;
  /** Aggregate generation tok/s (alias of generationTps for clarity). */
  generationTpsAgg?: number;
  /** Aggregate prefill tok/s (alias of prefillTps for clarity). */
  prefillTpsAgg?: number;
  /** Rolling average E2E latency over the last 10 inferences (seconds). */
  rollingAvgE2e?: number;
  /** Rolling average TTFT over the last 10 inferences (seconds). */
  rollingAvgTtft?: number;
  /** Rolling average tokens per request over the last 10 inferences. */
  rollingAvgTokensPerReq?: number;
  /** Rolling average tok/s per slot over the last 10 inferences. */
  rollingAvgTpsPerSlot?: number;
  /** Per-position speculative-decode acceptance (pos0, pos1, pos2, ...), 0–1 each. */
  perPositionAcceptance?: number[];
  /** Per-slot telemetry rows for the table view. */
  slots?: SlotTelemetry[];

  // ── DS4 engine metrics ────────────────────────────────
  /** DS4 engine uptime in seconds */
  ds4Uptime?: number | null;
  /** Peak aggregate decode tok/s tracked over session */
  peakAggregateTps?: number;
  /** Per-stream throughput high (tok/s) */
  perStreamHigh?: number;
  /** Per-stream throughput low (tok/s) */
  perStreamLow?: number;
  /** Per-stream throughput avg (tok/s) */
  perStreamAvg?: number;
  /** Total decoded tokens (cumulative, ds4_tokens_decoded_total) */
  totalTokensDecoded?: number;
  /** DSpark speculative acceptance ratio (0-1, ds4_spec_accept_ratio) */
  dsparkAcceptRatio?: number | null;
  /** Active context banks / lanes in use (ds4_banks_live) */
  banksLive?: number;
  /** Total configured banks / max lanes (ds4_banks_total) */
  banksTotal?: number;
  /** KV cache pages resident in memory (ds4_kv_pages_resident) */
  kvPagesResident?: number;
  /** Prefill tokens from cache (cumulative, ds4_tokens_prefilled_total{kind=cached}) */
  prefillCached?: number;
  /** Prefill tokens computed (cumulative, ds4_tokens_prefilled_total{kind=computed}) */
  prefillComputed?: number;
  /** Spec decode drafts total (ds4_spec_drafts_total) */
  specDrafts?: number;
  /** Spec decode hits total (ds4_spec_hits_total) */
  specHits?: number;
  /** Spec decode quench total (ds4_spec_quench_total) */
  specQuench?: number;
  /** Prefix cache warm records (ds4_warm_records) */
  warmRecords?: number;
  /** Derived artifacts count (ds4_derived_artifacts) */
  derivedArtifacts?: number;
  /** Derived artifact bytes (ds4_derived_artifact_bytes) */
  derivedArtifactBytes?: number;
  /** Requests started total (ds4_requests_started_total) */
  requestsStarted?: number;
  /** Requests completed (ds4_requests_total{outcome=completed}) */
  requestsCompleted?: number;
  /** Requests failed (ds4_requests_total{outcome=failed}) */
  requestsFailed?: number;
  /** Requests refused deep serial (ds4_requests_total{outcome=refused_deep_serial}) */
  requestsRefusedDeepSerial?: number;
  /** Requests currently inflight (ds4_requests_inflight) */
  requestsInflight?: number;
  /** Requests serial total (ds4_requests_serial_total) */
  requestsSerial?: number;
  /** Continuity admit rejects total (ds4_cont_admit_rejects_total) */
  contAdmitRejects?: number;
  /** Continuity batch failures total (ds4_cont_batch_failures_total) */
  contBatchFailures?: number;
  /** Graph fit refusals total (ds4_graph_fit_refusals_total) */
  graphFitRefusals?: number;
  /** Admits: cold (ds4_admits_total{kind=cold}) */
  admitsCold?: number;
  /** Admits: warm (ds4_admits_total{kind=warm}) */
  admitsWarm?: number;
  /** Admits: fork (ds4_admits_total{kind=fork}) */
  admitsFork?: number;
  /** Admits: partial_fork (ds4_admits_total{kind=partial_fork}) */
  admitsPartialFork?: number;
  /** Admits: partial_truncate (ds4_admits_total{kind=partial_truncate}) */
  admitsPartialTruncate?: number;
  /** Decode steps total (ds4_decode_steps_total) */
  decodeSteps?: number;
  /** Tokens per step (speculative efficiency, ds4_tok_per_step) */
  tokPerStep?: number;
  /** Recipe metadata from /v1/models */
  recipeMetadata?: RecipeMetadata | null;
  /** Rich recipe info / attribution for the Recipe Info card */
  recipeInfo?: RecipeInfo | null;
}

// ─── Full metrics snapshot ────────────────────────────────
export interface SparkMetrics {
  gpu: GpuMetrics | null;
  cpu: CpuMetrics | null;
  ram: RamMetrics | null;
  storage: StorageMetrics[];
  network: NetworkMetrics | null;
  unifiedMemory: UnifiedMemoryMetrics | null;
  /** Array of LLM metrics, one per configured port. Empty array when no ports. */
  llm: LlmMetrics[];
}

// ─── Spark snapshot (server pushes this) ──────────────────
export interface SparkSnapshot {
  id: string;
  name: string;
  online: boolean;
  /** Uptime in seconds, or null when offline */
  uptime: number | null;
  /** LAN IP for OpenCode / browser deep-links. */
  lanIp?: string;
  disabledDevices: string[];
  disabledInterfaces: string[];
  storagePollDisabled?: boolean;
  /** Cluster role (head / worker / standalone) */
  role?: SparkRole;
  /** Distributed LLM worker — LLM card inactive / not shown (role === worker) */
  workerNode?: boolean;
  /** Optional cluster/model label when role is worker */
  workerLabel?: string | null;
  /** Optional head Spark id when role is worker */
  workerHeadId?: string | null;
  /** Standalone: whether LLM is probed (head always true, worker always false) */
  llmMonitoring?: boolean;
  /** LLM server port (first port, for backward compat) */
  llmPort: number;
  /** All LLM server ports configured for this Spark */
  llmPorts: number[];
  hardware: HardwareInfo;
  metrics: SparkMetrics;
}

// ─── WebSocket envelope ───────────────────────────────────
export interface WsSnapshot {
  type: "snapshot";
  sparks: SparkSnapshot[];
  refreshInterval: number;
}

// ─── API responses ────────────────────────────────────────
export interface Settings {
  pollIntervalMs: number;
  defaultLlmPort: number;
  autoHideOffline: boolean;
  temperatureUnit: "celsius" | "fahrenheit" | null;
  /** Persist prompts / HTTP traces / GPU samples on decode benchmark runs. */
  benchDebugTraces: boolean;
  /** Layout density — comfortable (default) or compact. */
  density: "comfortable" | "compact";
  /** Overview cards: tiled (3 per row) or horizontal (1 per row). */
  overviewLayout: "tiled" | "horizontal";
}

export interface SparksListResponse {
  sparks: SparkConfig[];
}

export interface SparkTestResponse {
  id: string;
  ssh: { ok: boolean; message: string };
  llm: { ok: boolean; message: string };
  ok: boolean;
}

export interface ApiError {
  error: string;
}

// ─── LLM decode benchmark ────────────────────────────────
export interface DecodeBenchConfig {
  port: number;
  modelId: string | null;
  concurrencies: number[];
  maxTokens: number;
}

export interface DecodeBenchStreamResult {
  index: number;
  ttftMs: number;
  decodeTps: number;
  decodeTokens: number;
  completionTokens: number;
  totalMs: number;
  error: string | null;
  /** Exact prompt used for this stream (debug). */
  prompt?: string | null;
  /** Compact HTTP/SSE trace (no full completion body). */
  http?: {
    url: string | null;
    status: number | null;
    headers: Record<string, string>;
    completionId: string | null;
    finishReason: string | null;
    sseEventCount: number;
    firstSseDataPreview: string | null;
    request: {
      model: string | null;
      maxTokens: number | null;
      temperature: number;
      stream: boolean;
      promptChars: number;
    };
  };
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  contentPreview?: {
    first: string;
    last: string;
    chars: number;
  } | null;
  decodeMs?: number | null;
}

/** One concurrency wave (all streams at that concurrency). */
export interface DecodeBenchLevelResult {
  concurrency: number;
  streamsOk: number;
  streamsFailed: number;
  /** Mean per-stream decode tok/s after first token */
  meanDecodeTps: number;
  medianDecodeTps: number;
  minDecodeTps: number;
  maxDecodeTps: number;
  meanTtftMs: number;
  medianTtftMs: number;
  /** Client: total post-first-token tokens / concurrent decode window */
  aggregateDecodeTps: number;
  /**
   * Median server-side generation tok/s from live-style /metrics polls during the wave.
   * Null when the backend does not expose counters.
   */
  serverGenerationTps: number | null;
  /** Peak sample of server generation tok/s during the wave */
  serverGenerationTpsMax?: number | null;
  /** Number of positive rate samples collected from the engine */
  serverGenerationSamples?: number;
  totalDecodeTokens: number;
  totalCompletionTokens: number;
  durationMs: number;
  error: string | null;
  streams: DecodeBenchStreamResult[];
  model: string | null;
  /** ~1 Hz GPU/VRAM/power samples during the wave (debug). */
  hardwareSamples?: Array<{
    t: number;
    gpuUsage: number | null;
    temperature: number | null;
    powerDraw: number | null;
    powerLimit?: number | null;
    vramUsed: number | null;
    vramTotal: number | null;
    vramAvailable?: number | null;
    memAvailable?: number | null;
  }>;
}

export interface DecodeBenchProgress {
  currentConcurrency: number | null;
  completedLevels: number;
  totalLevels: number;
  message: string;
}

export interface DecodeBenchJob {
  benchId: string;
  sparkId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  config: DecodeBenchConfig & { debug?: boolean };
  progress: DecodeBenchProgress;
  results: DecodeBenchLevelResult[];
  error: string | null;
  durationMs: number;
}

export interface DecodeBenchDefaults {
  allowedConcurrencies: number[];
  defaultMaxTokens: number;
  minMaxTokens: number;
  maxMaxTokens: number;
}

export interface DecodeBenchListResponse {
  active: DecodeBenchJob | null;
  /** Most recent finished job (optionally for a given port) */
  last: DecodeBenchJob | null;
  history: DecodeBenchJob[];
  defaults: DecodeBenchDefaults;
}

export interface StartDecodeBenchRequest {
  port?: number;
  concurrencies: number[];
  maxTokens?: number;
  modelId?: string | null;
}

// ─── LLM Prompt Showcase ─────────────────────────────────
export interface ShowcaseStartRequest {
  port: number;
  modelId?: string | null;
  maxTokens?: number;
  /** When true, enable model thinking/reasoning flags (UI defaults to off). */
  thinking?: boolean;
  prompts: string[];
}

export interface ShowcaseStreamState {
  streamId: string;
  label: string;
  prompt: string;
  status: "pending" | "streaming" | "completed" | "error" | "cancelled";
  contentAppend?: string;
  content?: string;
  contentLength: number;
  reasoningAppend?: string;
  reasoning?: string;
  reasoningLength?: number;
  resetContent?: boolean;
  tokenCount: number;
  ttftMs: number | null;
  decodeTps: number;
  liveTokPerSec: number;
  model: string | null;
  error: string | null;
}

export interface ShowcaseSessionState {
  sessionId: string;
  sparkId: string;
  status: "running" | "completed" | "cancelled" | "error";
  rev: number;
  port: number;
  modelId?: string | null;
  startedAt?: number;
  /** Median server generation tok/s from /metrics during the run (null if unavailable). */
  serverGenerationTps?: number | null;
  serverGenerationTpsMax?: number | null;
  serverGenerationSamples?: number;
  streams: ShowcaseStreamState[];
  error?: string | null;
}

export interface ShowcaseStartResponse {
  sessionId: string;
  status: "running";
}