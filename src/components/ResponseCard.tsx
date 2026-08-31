import type { FollowUpIntent } from "../core/requests/types";
import type { ReaderUiState } from "../features/reader/reader-controller";
import { SafeMarkdown } from "./SafeMarkdown";

type ResponseState = Exclude<ReaderUiState, { status: "idle" | "actions" }>;

export interface ResponseCardProps {
  state: ResponseState;
  onStop(): void;
  onRetry(): void;
  onCopy(): void;
  onOpenSidePanel(): void;
  onFollowUp(intent: FollowUpIntent): void;
  onClose(): void;
  sidePanelError?: string;
}

const actionLabels = {
  explain: "Explain",
  simplify: "Simplify",
  translate: "Translate",
  example: "Example",
} as const;

const followUps: ReadonlyArray<{ intent: FollowUpIntent; label: string }> = [
  { intent: "simpler", label: "Simpler" },
  { intent: "more-detail", label: "More detail" },
  { intent: "another-example", label: "Example" },
  { intent: "why", label: "Why?" },
];

function answerFor(state: ResponseState): string {
  return "answer" in state ? state.answer : "";
}

export function ResponseCard({
  state,
  onStop,
  onRetry,
  onCopy,
  onOpenSidePanel,
  onFollowUp,
  onClose,
  sidePanelError,
}: ResponseCardProps) {
  const answer = answerFor(state);
  const active = state.status === "connecting" || state.status === "generating";
  const incomplete = state.status === "cancelled" || state.status === "failed";

  return (
    <article
      className={`reader-card reader-card-${state.status}`}
      aria-label="Local explanation"
    >
      <div className="reader-spine" aria-hidden="true" />
      <header className="reader-card-header">
        <div>
          <span className="reader-action-label">{actionLabels[state.action]}</span>
          <p className="reader-preview">“{state.preview}”</p>
        </div>
        <button
          className="reader-icon-button"
          type="button"
          aria-label="Close explanation"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      {active ? (
        <p className="reader-status" role="status">
          {state.status === "connecting"
            ? "Connecting to local model…"
            : "Explaining locally…"}
        </p>
      ) : null}
      {state.status === "failed" ? (
        <div className="reader-alert" role="alert">
          {state.error.message}
        </div>
      ) : null}
      {sidePanelError ? (
        <div className="reader-alert" role="alert">
          {sidePanelError}
        </div>
      ) : null}
      {incomplete ? <p className="reader-incomplete">Incomplete output</p> : null}
      {state.contextIncluded ? (
        <p className="reader-context-indicator">Nearby context included</p>
      ) : null}

      <div className="reader-answer" aria-live="polite" aria-atomic="false">
        {answer ? <SafeMarkdown>{answer}</SafeMarkdown> : null}
      </div>

      <footer className="reader-card-footer">
        <div className="reader-control-row">
          {active ? (
            <button type="button" onClick={onStop}>
              Stop
            </button>
          ) : null}
          {state.status === "failed" && state.error.recoverable ? (
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          ) : null}
          {answer ? (
            <button type="button" onClick={onCopy}>
              Copy
            </button>
          ) : null}
          <button type="button" onClick={onOpenSidePanel}>
            Open in side panel
          </button>
        </div>
        {state.status === "complete" ? (
          <div className="reader-follow-ups" aria-label="Follow-up actions">
            {followUps.map(({ intent, label }) => (
              <button key={intent} type="button" onClick={() => onFollowUp(intent)}>
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </footer>
    </article>
  );
}
