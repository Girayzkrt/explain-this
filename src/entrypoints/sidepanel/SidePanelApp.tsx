import { useEffect, useSyncExternalStore } from "react";
import type { FollowUpIntent, ReadingAction } from "../../core/requests/types";
import { Settings } from "lucide-react";
import { PublicErrorNotice } from "../../components/PublicErrorNotice";
import { SafeMarkdown } from "../../components/SafeMarkdown";
import { providerCopy } from "../../features/reader/provider-copy";
import type { SidePanelController } from "../../features/reader/sidepanel-controller";

export interface SidePanelAppProps {
  controller: SidePanelController;
  copyText(text: string): Promise<void>;
  openSettings(): void;
}

const actionLabels: Record<ReadingAction, string> = {
  explain: "Explain",
  simplify: "Simplify",
  translate: "Translate",
  example: "Example",
};

const followUps: ReadonlyArray<{ intent: FollowUpIntent; label: string }> = [
  { intent: "simpler", label: "Simpler" },
  { intent: "more-detail", label: "More detail" },
  { intent: "why", label: "Why?" },
  { intent: "another-example", label: "Another example" },
];

export function SidePanelApp({
  controller,
  copyText,
  openSettings,
}: SidePanelAppProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);

  if (state.status === "loading") {
    return (
      <main className="sidepanel-shell sidepanel-loading">
        <h1>Explain This</h1>
        <p role="status">Finding the current explanation…</p>
      </main>
    );
  }

  if (state.status === "empty") {
    return (
      <main className="sidepanel-shell sidepanel-empty">
        <header className="panel-titlebar">
          <p className="panel-kicker">{providerCopy(undefined).kicker}</p>
          <h1>Explain This</h1>
        </header>
        <section className="empty-instructions" aria-labelledby="empty-title">
          <span className="empty-mark" aria-hidden="true">
            Aa
          </span>
          <h2 id="empty-title">Select a passage to begin</h2>
          <p>
            Highlight text on this tab, then choose Explain This from the page, context
            menu, or keyboard shortcut.
          </p>
        </section>
        <button className="settings-button" type="button" onClick={openSettings}>
          <Settings size={15} strokeWidth={1.8} aria-hidden="true" focusable="false" />
          Settings
        </button>
      </main>
    );
  }

  const { session, actionError } = state;
  const active = session.status === "pending" || session.status === "streaming";
  const incomplete = session.status === "cancelled" || session.status === "failed";
  const visibleError = actionError ?? session.error;
  const copy = providerCopy(session.provider);

  return (
    <main className="sidepanel-shell">
      <header className="source-region">
        <div className="panel-titlebar">
          <p className="panel-kicker">{copy.kicker}</p>
          <h1>Explain This</h1>
        </div>
        <div className="source-slip">
          <div className="source-meta">
            <span>{actionLabels[session.action]}</span>
            <span>{new URL(session.origin).hostname}</span>
          </div>
          <blockquote>{session.selectionPreview}</blockquote>
          {session.contextIncluded ? (
            <p className="context-indicator">Nearby context included</p>
          ) : null}
        </div>
      </header>

      <section className="answer-region" aria-label="Explanation">
        {active ? (
          <p className="stream-status" role="status">
            {session.status === "pending" ? copy.connecting : copy.explaining}
          </p>
        ) : null}
        {visibleError ? (
          <PublicErrorNotice error={visibleError} onRetry={() => controller.retry()} />
        ) : null}
        {incomplete && session.answer ? (
          <p className="incomplete-label">Incomplete output</p>
        ) : null}
        <div className="answer-copy" aria-live="polite" aria-atomic="false">
          {session.answer ? <SafeMarkdown>{session.answer}</SafeMarkdown> : null}
        </div>

        <div className="primary-actions" aria-label="Explanation actions">
          {active ? (
            <button type="button" onClick={() => controller.stop()}>
              Stop
            </button>
          ) : null}
          {session.status === "cancelled" ? (
            <button type="button" onClick={() => controller.retry()}>
              Retry
            </button>
          ) : null}
          {session.answer ? (
            <button type="button" onClick={() => void copyText(session.answer)}>
              Copy
            </button>
          ) : null}
        </div>

        {session.status === "completed" ? (
          <div className="follow-up-region">
            <p>Keep this passage in focus</p>
            <div className="follow-up-actions" aria-label="Follow-up actions">
              {followUps.map(({ intent, label }) => (
                <button
                  key={intent}
                  type="button"
                  onClick={() => controller.followUp(intent)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <button className="settings-button" type="button" onClick={openSettings}>
          <Settings size={15} strokeWidth={1.8} aria-hidden="true" focusable="false" />
          Settings
        </button>
      </section>
    </main>
  );
}
