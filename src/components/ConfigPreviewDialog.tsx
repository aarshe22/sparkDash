import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../hooks/useModalPresence";

interface ConfigPreviewDialogProps {
  open: boolean;
  filename: string;
  content: string;
  mimeType: string;
  onClose: () => void;
}

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall back for HTTP origins and browsers that block Clipboard API access.
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

export function ConfigPreviewDialog({
  open,
  filename,
  content,
  mimeType,
  onClose,
}: ConfigPreviewDialogProps) {
  const { mounted, visible } = useModalPresence(open);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setCopyError(false);
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

  if (!mounted) return null;

  const handleCopy = async () => {
    try {
      await copyText(content);
      setCopied(true);
      setCopyError(false);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyError(true);
    }
  };

  const handleDownload = () => {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return createPortal(
    <div className={`bench-overlay${visible ? " is-open" : ""}`}>
      <button
        type="button"
        className="bench-overlay__scrim"
        onClick={onClose}
        aria-label="Close configuration preview"
      />
      <div
        className="bench-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="config-preview-title"
      >
        <div className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 id="config-preview-title" className="bench-sheet__title">{filename}</h2>
            <p className="bench-sheet__subtitle">Generated from the currently live monitored models</p>
          </div>
          <button type="button" className="bench-sheet__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="bench-sheet__body">
          <pre className="min-h-80 overflow-auto whitespace-pre rounded-lg border border-border bg-[#111] p-4 font-mono text-[11px] leading-relaxed text-[#e8e8e8]">
            {content}
          </pre>
          {copyError && <p className="mt-2 text-xs text-danger">Could not copy to clipboard.</p>}
        </div>
        <div className="bench-sheet__footer">
          <button type="button" className="bench-btn bench-btn--ghost" onClick={() => void handleCopy()}>
            {copied ? "Copied" : "Copy to clipboard"}
          </button>
          <button type="button" className="bench-btn bench-btn--primary" onClick={handleDownload}>
            Download
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
