import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatBytes, ProgressBar } from "../../components/ProgressBar";
import { PublicErrorNotice } from "../../components/PublicErrorNotice";
import type { OriginGuidance } from "../../features/onboarding/origin-guidance";
import {
  useOnboarding,
  type OnboardingClientConnection,
  type OnboardingController,
  type OnboardingState,
} from "../../features/onboarding/use-onboarding";
import type { OnboardingClient } from "../../platform/messaging/onboarding-client";
import type { ReaderAccessService } from "../../platform/permissions/reader-access";
import type { SettingsRepository } from "../../platform/storage/settings-repository";
import { RECOMMENDED_MODEL } from "../../shared/constants";

const SETUP_STEPS = [
  "Welcome",
  "Check runtime",
  "Install Ollama",
  "Allow origin",
  "Find models",
  "Choose model",
  "Download",
  "Preferences",
  "Nearby context",
  "Page access",
  "Readiness test",
  "Ready",
] as const;

const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

export interface OptionsAppDependencies {
  createClient(): OnboardingClientConnection | OnboardingClient;
  settingsRepository: SettingsRepository;
  readerAccess: Pick<
    ReaderAccessService,
    "requestAutomaticAccess" | "registerAutomaticAccess" | "disableAutomaticAccess"
  >;
  getUiLanguage(): string;
  getOriginGuidance(): OriginGuidance;
}

export interface OptionsAppProps {
  dependencies: OptionsAppDependencies;
}

function currentStep(state: OnboardingState): number {
  switch (state.step) {
    case "loading":
      return 1;
    case "welcome":
      return 1;
    case "checking-runtime":
      return 2;
    case "runtime-missing":
      return 3;
    case "origin-guidance":
      return 4;
    case "choosing-model":
      return 6;
    case "downloading":
      return 7;
    case "preferences":
      return 8;
    case "context":
      return 9;
    case "permission":
      return 10;
    case "readiness":
      return 11;
    case "complete":
    case "settings":
      return 12;
    case "failed":
      return state.interruptedStep;
  }
}

export function OptionsApp({ dependencies }: OptionsAppProps) {
  const controller = useOnboarding({
    createClient: dependencies.createClient,
    settingsRepository: dependencies.settingsRepository,
    getUiLanguage: dependencies.getUiLanguage,
  });
  const step = currentStep(controller.state);

  return (
    <main className="setup-shell">
      <aside className="setup-rail" aria-label="Local setup sequence">
        <div>
          <p className="product-name">Explain This</p>
          <h1>Local explanations, set up clearly.</h1>
          <p className="rail-intro">
            Your reading stays on this computer. Ollama does the explanation work at a
            local address.
          </p>
        </div>

        <div className="local-loop" aria-label="Local data flow">
          <span>text</span>
          <span aria-hidden="true">→</span>
          <code>localhost</code>
          <span aria-hidden="true">→</span>
          <span>explanation</span>
        </div>
        <p className="visually-hidden">text → localhost → explanation</p>

        <ProgressBar
          label="Setup progress"
          max={SETUP_STEPS.length}
          value={step}
          detail={`${step} of ${SETUP_STEPS.length}`}
        />
        <ol className="setup-steps">
          {SETUP_STEPS.map((label, index) => {
            const number = index + 1;
            const status =
              number < step ? "complete" : number === step ? "current" : "upcoming";
            return (
              <li
                key={label}
                data-status={status}
                aria-current={status === "current" ? "step" : undefined}
              >
                <span className="step-number">{number}</span>
                <span>{label}</span>
              </li>
            );
          })}
        </ol>
      </aside>

      <section className="work-surface" aria-live="polite">
        <ActiveStep controller={controller} dependencies={dependencies} />
      </section>
    </main>
  );
}

function ActiveStep({
  controller,
  dependencies,
}: {
  controller: OnboardingController;
  dependencies: OptionsAppDependencies;
}) {
  const { state } = controller;

  switch (state.step) {
    case "loading":
      return (
        <StepFrame eyebrow="Local setup" heading="Loading Explain This">
          <div className="working-status" role="status">
            <span className="status-pulse" aria-hidden="true" />
            Loading settings…
          </div>
        </StepFrame>
      );
    case "welcome":
      return (
        <StepFrame eyebrow="Step 1 of 12" heading="Understand text locally">
          <p>
            Explain This uses Ollama on your computer. It cannot install or start Ollama
            for you, but this setup checks each part and shows what to do.
          </p>
          <p className="privacy-line">
            Selected text goes only to <code>127.0.0.1</code>. No cloud account is
            required.
          </p>
          <button
            className="button button-primary"
            type="button"
            onClick={controller.checkRuntime}
          >
            Start local setup
          </button>
        </StepFrame>
      );
    case "checking-runtime":
      return (
        <StepFrame eyebrow="Step 2 of 12" heading="Checking Ollama">
          <div className="working-status" role="status">
            <span className="status-pulse" aria-hidden="true" />
            Looking for Ollama at <code>127.0.0.1:11434</code>…
          </div>
          <p>This check reads the local model list. It does not send page text.</p>
        </StepFrame>
      );
    case "runtime-missing":
      return (
        <StepFrame eyebrow="Step 3 of 12" heading="Ollama isn’t available">
          <PublicErrorNotice error={state.error} />
          <p>
            Install and start Ollama, then return here. This extension cannot silently
            install or launch another app.
          </p>
          <div className="actions">
            <a
              className="button button-primary"
              href={OLLAMA_DOWNLOAD_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Install Ollama
            </a>
            <button
              className="button button-secondary"
              type="button"
              onClick={controller.checkRuntime}
            >
              Check again
            </button>
            {state.showOriginGuidance ? (
              <button
                className="button button-secondary"
                type="button"
                onClick={controller.showOriginGuidance}
              >
                Show exact-origin guidance
              </button>
            ) : null}
          </div>
        </StepFrame>
      );
    case "origin-guidance":
      return (
        <OriginStep
          error={state.error}
          guidance={dependencies.getOriginGuidance()}
          onCheckAgain={controller.checkRuntime}
        />
      );
    case "choosing-model":
      return <ModelStep controller={controller} state={state} />;
    case "downloading":
      return <DownloadStep onCancel={controller.cancelDownload} state={state} />;
    case "preferences":
      return <PreferencesStep controller={controller} />;
    case "context":
      return <ContextStep controller={controller} />;
    case "permission":
      return (
        <PermissionStep
          controller={controller}
          readerAccess={dependencies.readerAccess}
          settingsRepository={dependencies.settingsRepository}
        />
      );
    case "readiness":
      return <ReadinessStep state={state} />;
    case "complete":
      return <ReadyStep controller={controller} resultState={state} />;
    case "settings":
      return <SettingsStep controller={controller} />;
    case "failed":
      return (
        <StepFrame eyebrow="Setup paused" heading="This step didn’t finish">
          <PublicErrorNotice error={state.error} onRetry={controller.retry} />
        </StepFrame>
      );
  }
}

function StepFrame({
  eyebrow,
  heading,
  children,
}: {
  eyebrow: string;
  heading: string;
  children: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [heading]);

  return (
    <div className="step-frame">
      <p className="eyebrow">{eyebrow}</p>
      <h2 ref={headingRef} tabIndex={-1}>
        {heading}
      </h2>
      <div className="step-content">{children}</div>
    </div>
  );
}

function OriginStep({
  error,
  guidance,
  onCheckAgain,
}: {
  error: Extract<OnboardingState, { step: "origin-guidance" }>["error"];
  guidance: OriginGuidance;
  onCheckAgain(): void;
}) {
  return (
    <StepFrame eyebrow="Step 4 of 12" heading="Allow this extension in Ollama">
      <PublicErrorNotice error={error} />
      <p>Use this exact origin. Do not use a wildcard or a network-wide bind.</p>
      <ol className="guidance-list">
        {guidance.steps.map((step, index) => (
          <li key={`${step.kind}-${index}`}>
            {step.kind === "code" ? (
              <code className="code-block">{step.text}</code>
            ) : step.kind === "link" ? (
              <a href={step.href} target="_blank" rel="noopener noreferrer">
                {step.text}
              </a>
            ) : (
              step.text
            )}
          </li>
        ))}
      </ol>
      <button className="button button-primary" type="button" onClick={onCheckAgain}>
        Check again
      </button>
    </StepFrame>
  );
}

function ModelStep({
  controller,
  state,
}: {
  controller: OnboardingController;
  state: Extract<OnboardingState, { step: "choosing-model" }>;
}) {
  const [installedModel, setInstalledModel] = useState(state.models[0]?.id ?? "");
  const recommendationInstalled = state.models.some(
    (model) => model.id === RECOMMENDED_MODEL,
  );
  const hasSpecializedModel = state.models.some((model) =>
    model.displayName.toLowerCase().includes("code-specialized"),
  );

  return (
    <StepFrame eyebrow="Steps 5–6 of 12" heading="Choose a local model">
      <div className="model-recommendation">
        <p className="field-label">Recommended for general reading</p>
        <h3>{RECOMMENDED_MODEL}</h3>
        <p>
          Approximately 2.5 GB. Multilingual and balanced for everyday explanations on
          desktop-class computers.
        </p>
        <button
          className="button button-primary"
          type="button"
          onClick={() => {
            if (recommendationInstalled) {
              controller.useInstalledModel(RECOMMENDED_MODEL);
            } else {
              controller.downloadModel(RECOMMENDED_MODEL);
            }
          }}
        >
          {recommendationInstalled ? "Use qwen3:4b" : "Download qwen3:4b"}
        </button>
      </div>

      {state.models.length > 0 ? (
        <div className="installed-models">
          <label htmlFor="installed-model">Installed model</label>
          <select
            id="installed-model"
            value={installedModel}
            onChange={(event) => setInstalledModel(event.target.value)}
          >
            {state.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
                {model.sizeBytes === undefined
                  ? ""
                  : ` · ${formatBytes(model.sizeBytes)}`}
              </option>
            ))}
          </select>
          {hasSpecializedModel ? (
            <p className="model-warning" role="status">
              Programming-focused models are better suited to code than general reading.
            </p>
          ) : null}
          <button
            className="button button-secondary"
            type="button"
            disabled={!installedModel}
            onClick={() => controller.useInstalledModel(installedModel)}
          >
            Use installed model
          </button>
        </div>
      ) : (
        <p className="empty-note">No installed model was found.</p>
      )}
    </StepFrame>
  );
}

function DownloadStep({
  onCancel,
  state,
}: {
  onCancel(): void;
  state: Extract<OnboardingState, { step: "downloading" }>;
}) {
  const { progress } = state;
  const completed = progress.type === "progress" ? progress.completedBytes : 0;
  const total = progress.type === "progress" ? progress.totalBytes : undefined;
  const detail =
    total === undefined
      ? completed > 0
        ? `${formatBytes(completed)} downloaded`
        : "Preparing local download"
      : `${formatBytes(completed)} of ${formatBytes(total)}`;

  return (
    <StepFrame eyebrow="Step 7 of 12" heading="Downloading the local model">
      <div role="status">
        {total === undefined ? (
          <>
            <progress aria-label="Model download" />
            <p className="byte-count">{detail}</p>
          </>
        ) : (
          <ProgressBar
            label="Model download"
            max={total}
            value={completed}
            detail={detail}
          />
        )}
      </div>
      <p>Ollama stores this model on your computer. You can cancel and retry.</p>
      <button className="button button-secondary" type="button" onClick={onCancel}>
        Cancel download
      </button>
    </StepFrame>
  );
}

function PreferencesStep({ controller }: { controller: OnboardingController }) {
  const [draft, setDraft] = useState(controller.preferences);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    controller.savePreferences(draft);
  }

  return (
    <StepFrame eyebrow="Step 8 of 12" heading="Choose how explanations read">
      <form onSubmit={submit}>
        <div className="field-group">
          <label htmlFor="preferred-language">Preferred language</label>
          <input
            id="preferred-language"
            value={draft.preferredLanguage}
            maxLength={64}
            minLength={2}
            required
            onChange={(event) =>
              setDraft({ ...draft, preferredLanguage: event.target.value })
            }
          />
          <p className="field-help">
            Chrome suggested this language. Confirm or change it before continuing.
          </p>
        </div>

        <fieldset>
          <legend>Explanation level</legend>
          <div className="radio-stack">
            {(
              [
                ["everyday", "Everyday", "Plain language and short examples."],
                ["standard", "Standard", "Balanced detail for general reading."],
                ["technical", "Technical", "Precise terms and deeper detail."],
              ] as const
            ).map(([value, label, help]) => (
              <label
                className="choice-row"
                htmlFor={`level-${value}`}
                key={value}
                aria-label={`${label}: ${help}`}
              >
                <input
                  id={`level-${value}`}
                  type="radio"
                  name="explanation-level"
                  value={value}
                  checked={draft.explanationLevel === value}
                  onChange={() => setDraft({ ...draft, explanationLevel: value })}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{help}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.preserveEnglishTerms}
            onChange={(event) =>
              setDraft({ ...draft, preserveEnglishTerms: event.target.checked })
            }
          />
          <span>Preserve important English terms in parentheses</span>
        </label>

        <button className="button button-primary" type="submit">
          Confirm preferences
        </button>
      </form>
    </StepFrame>
  );
}

function ContextStep({ controller }: { controller: OnboardingController }) {
  const [includeNearbyContext, setIncludeNearbyContext] = useState(false);

  return (
    <StepFrame eyebrow="Step 9 of 12" heading="Nearby context is your choice">
      <p>
        A short piece of visible text beside your selection can clarify pronouns and
        ambiguous phrases. It means more page text goes to your local model.
      </p>
      <label
        className="check-row privacy-choice"
        htmlFor="nearby-context"
        aria-label="Include nearby context. Off by default."
      >
        <input
          id="nearby-context"
          type="checkbox"
          checked={includeNearbyContext}
          onChange={(event) => setIncludeNearbyContext(event.target.checked)}
        />
        <span>
          <strong>Include nearby context</strong>
          <small>
            Off by default. Form values, hidden text, and unrelated regions are
            excluded.
          </small>
        </span>
      </label>
      <button
        className="button button-primary"
        type="button"
        onClick={() => controller.saveContext(includeNearbyContext)}
      >
        Continue
      </button>
    </StepFrame>
  );
}

function PermissionStep({
  controller,
  readerAccess,
  settingsRepository,
}: {
  controller: OnboardingController;
  readerAccess: OptionsAppDependencies["readerAccess"];
  settingsRepository: SettingsRepository;
}) {
  const [requesting, setRequesting] = useState(false);

  async function settleAutomaticToolbar(granted: boolean): Promise<void> {
    if (granted) {
      try {
        await settingsRepository.update({ automaticToolbar: true });
        await readerAccess.registerAutomaticAccess();
        controller.resolvePermission(true);
        return;
      } catch {
        // Fall through to persist the rollback and revoke any granted access.
      }
    }

    await settingsRepository.update({ automaticToolbar: false }).catch(() => undefined);
    await readerAccess.disableAutomaticAccess().catch(() => undefined);
    controller.resolvePermission(false, true);
  }

  function handleEnableAutomaticToolbar(): void {
    const permissionRequest = readerAccess.requestAutomaticAccess();
    setRequesting(true);
    void permissionRequest.then(
      (granted) => settleAutomaticToolbar(granted),
      () => settleAutomaticToolbar(false),
    );
  }

  return (
    <StepFrame eyebrow="Step 10 of 12" heading="Automatic selection actions">
      <p>
        If enabled, Explain This can notice a selection and show its reading actions on
        ordinary HTTP and HTTPS pages.
      </p>
      <div className="permission-explanation">
        <strong>Optional page access</strong>
        <p>
          This stays off unless you enable it. Without it, the context menu, keyboard
          shortcut, and extension action still work.
        </p>
      </div>
      <div className="actions">
        <button
          className="button button-primary"
          type="button"
          disabled={requesting}
          onClick={handleEnableAutomaticToolbar}
        >
          {requesting ? "Waiting for Chrome…" : "Enable automatic actions"}
        </button>
        <button
          className="button button-secondary"
          type="button"
          disabled={requesting}
          onClick={() => {
            setRequesting(true);
            void settleAutomaticToolbar(false);
          }}
        >
          Not now
        </button>
      </div>
    </StepFrame>
  );
}

function ReadinessStep({
  state,
}: {
  state: Extract<OnboardingState, { step: "readiness" }>;
}) {
  return (
    <StepFrame eyebrow="Step 11 of 12" heading="Testing your local model">
      <div className="working-status" role="status">
        <span className="status-pulse" aria-hidden="true" />
        Generating one harmless sample explanation…
      </div>
      <p>
        This test contains no selected page text and its generated answer is not saved.
      </p>
      {!state.preferences.automaticToolbar ? (
        <p className="invocation-note">
          Automatic actions are off. Use the context menu or keyboard shortcut to
          explain a selection.
        </p>
      ) : null}
    </StepFrame>
  );
}

function ReadyStep({
  controller,
  resultState,
}: {
  controller: OnboardingController;
  resultState: Extract<OnboardingState, { step: "complete" }>;
}) {
  const warning = resultState.result.status === "warning";

  return (
    <StepFrame eyebrow="Step 12 of 12" heading="Ready">
      <div
        className={`readiness-result ${warning ? "warning" : "ready"}`}
        role="status"
      >
        <strong>
          {warning
            ? "Your model is ready, but slower than recommended."
            : "Your local model is ready."}
        </strong>
        <span>
          First response {resultState.result.firstTokenMs.toLocaleString()} ms ·{" "}
          {resultState.result.tokensPerSecond.toFixed(1)} tokens/s
        </span>
      </div>

      <div className="ready-instructions">
        <h3>Explain your first selection</h3>
        <ol>
          <li>Select text on a normal webpage.</li>
          <li>Use Explain This in the context menu or press Alt+Shift+E.</li>
          <li>Read the local explanation beside the selection.</li>
        </ol>
      </div>

      <button
        className="button button-primary"
        type="button"
        onClick={controller.finish}
      >
        Finish setup
      </button>
    </StepFrame>
  );
}

function SettingsStep({ controller }: { controller: OnboardingController }) {
  const [blockedSites, setBlockedSites] = useState(controller.preferences.blockedSites);
  const [blockedHost, setBlockedHost] = useState("");

  async function addBlockedHost(): Promise<void> {
    const normalized = normalizeBlockedHost(blockedHost);
    if (!normalized || blockedSites.includes(normalized)) return;
    const next = [...blockedSites, normalized];
    setBlockedSites(next);
    setBlockedHost("");
    await controller.updateSettings({ blockedSites: next });
  }

  async function removeBlockedHost(host: string): Promise<void> {
    const next = blockedSites.filter((candidate) => candidate !== host);
    setBlockedSites(next);
    await controller.updateSettings({ blockedSites: next });
  }

  return (
    <StepFrame eyebrow="Settings" heading="Explanation settings">
      <p>
        Setup is complete. These preferences stay on this computer and can be changed
        without repeating the readiness test.
      </p>
      <div className="blocked-editor">
        <h3>Sites where automatic actions stay off</h3>
        <p>Stored locally as hostnames only. Explicit invocation remains available.</p>
        <label htmlFor="blocked-host">Blocked host</label>
        <div className="inline-field">
          <input
            id="blocked-host"
            value={blockedHost}
            placeholder="news.example"
            onChange={(event) => setBlockedHost(event.target.value)}
          />
          <button
            className="button button-secondary"
            type="button"
            onClick={() => void addBlockedHost()}
          >
            Add blocked host
          </button>
        </div>
        {blockedSites.length > 0 ? (
          <ul className="blocked-list">
            {blockedSites.map((host) => (
              <li key={host}>
                <code>{host}</code>
                <button
                  type="button"
                  aria-label={`Remove ${host}`}
                  onClick={() => void removeBlockedHost(host)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-note">No blocked hosts.</p>
        )}
      </div>
    </StepFrame>
  );
}

function normalizeBlockedHost(input: string): string | undefined {
  const candidate = input.trim().toLowerCase().replace(/\.$/, "");
  if (!candidate || candidate.length > 255) return undefined;
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      candidate,
    )
  ) {
    return undefined;
  }
  return candidate;
}
