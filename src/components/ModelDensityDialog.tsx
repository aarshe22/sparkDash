import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../hooks/useModalPresence";
import type { ModelDensity } from "../lib/modelDensity";

interface ModelDensityDialogProps {
  open: boolean;
  density: ModelDensity | null;
  modelId: string | null;
  onClose: () => void;
}

export function ModelDensityDialog({
  open,
  density,
  modelId,
  onClose,
}: ModelDensityDialogProps) {
  const { mounted, visible } = useModalPresence(open);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!mounted || density == null) return null;

  const sparse = density === "sparse";
  const title = sparse ? "Sparse (MoE) model" : "Dense model";

  return createPortal(
    <div className={`bench-overlay${visible ? " is-open" : ""}`}>
      <button
        type="button"
        className="bench-overlay__scrim"
        onClick={onClose}
        aria-label="Close architecture explanation"
      />
      <div
        className="bench-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-density-title"
      >
        <div className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 id="model-density-title" className="bench-sheet__title">
              {title}
            </h2>
            <p className="bench-sheet__subtitle">
              {modelId || "How this architecture affects speed and quality"}
            </p>
          </div>
          <button type="button" className="bench-sheet__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="bench-sheet__body density-dialog-body">
          <p className="density-dialog-lead">
            {sparse
              ? "This checkpoint is a mixture of experts: only a subset of parameters runs for each token."
              : "This checkpoint is dense: every parameter participates in every generated token."}
          </p>

          <section className={`density-dialog-panel${sparse ? " is-active" : ""}`}>
            <h3>Sparse / MoE</h3>
            <p>
              Names like <code>30B-A3B</code> mean ~30B total weights with ~3B active per token.
              Decode moves far fewer bytes, so tok/s is higher on bandwidth-limited hardware such
              as GB10 unified memory.
            </p>
            <p>
              Quality stays strong for the active size, but a router picks experts each token, so
              answers can vary a little more than a dense model. The unused experts still occupy
              RAM — sparsity speeds compute, it does not shrink the loaded footprint by the same
              factor.
            </p>
          </section>

          <section className={`density-dialog-panel${!sparse ? " is-active" : ""}`}>
            <h3>Dense</h3>
            <p>
              Every layer and every weight is used on every token. That is simpler and usually more
              consistent, with no expert-routing misses.
            </p>
            <p>
              The cost is memory traffic: a 27B dense model streams the full 27B each step, so it
              is slower than an MoE with a similar total size unless it is quantized (NVFP4/FP8)
              or the context/KV cache is kept modest. Quality per activated parameter is typically
              the more predictable of the two.
            </p>
          </section>
        </div>
        <div className="bench-sheet__footer">
          <button type="button" className="bench-btn bench-btn--primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
