import type { EngineMarkKind } from "../lib/llmEngine";
import { sparkEngineMarks } from "../lib/llmEngine";
import {
  BotIcon,
  ComfyIcon,
  LlamaCppIcon,
  OllamaIcon,
  SglangIcon,
  VllmIcon,
} from "./ui/icons";

const LABELS: Record<EngineMarkKind, string> = {
  vllm: "vLLM",
  sglang: "SGLang",
  ollama: "Ollama",
  comfy: "ComfyUI",
  "llama.cpp": "llama.cpp",
  ds4: "DS4",
};

function MarkIcon({ kind, className }: { kind: EngineMarkKind; className?: string }) {
  if (kind === "vllm") return <VllmIcon className={className} />;
  if (kind === "sglang") return <SglangIcon className={className} />;
  if (kind === "ollama") return <OllamaIcon className={className} />;
  if (kind === "comfy") return <ComfyIcon className={className} />;
  if (kind === "llama.cpp") return <LlamaCppIcon className={className} />;
  return <BotIcon className={className} />;
}

export function EngineMarks({
  spark,
  className = "",
}: {
  spark: Parameters<typeof sparkEngineMarks>[0];
  className?: string;
}) {
  const kinds = sparkEngineMarks(spark);
  if (kinds.length === 0) return null;
  return (
    <span className={`overview-engine-marks ${className}`.trim()}>
      {kinds.map((kind) => (
        <span key={kind} className="overview-engine-mark" title={`${LABELS[kind]} monitoring`}>
          <MarkIcon kind={kind} className="h-3.5 w-3.5" />
          <span>{LABELS[kind]}</span>
        </span>
      ))}
    </span>
  );
}
