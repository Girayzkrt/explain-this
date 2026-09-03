import {
  ArrowLeft,
  Check,
  Cloud,
  Download,
  Laptop,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatBytes, ProgressBar } from "../../components/ProgressBar";
import { PublicErrorNotice } from "../../components/PublicErrorNotice";
import { checkModeConsistency } from "../../core/requests/mode-consistency";
import { DiagnosticsView } from "../../features/onboarding/DiagnosticsView";
import {
  languageLabel,
  READING_LANGUAGES,
  resolveLanguageName,
} from "../../features/settings/languages";
import type { OriginGuidance } from "../../features/onboarding/origin-guidance";
import {
  onboardingStepNumber,
  useOnboarding,
  type OnboardingClientConnection,
  type OnboardingController,
  type OnboardingState,
} from "../../features/onboarding/use-onboarding";
import type { OnboardingClient } from "../../platform/messaging/onboarding-client";
import type { ReaderAccessService } from "../../platform/permissions/reader-access";
import type { SettingsRepository } from "../../platform/storage/settings-repository";
import type { SelectedProvider } from "../../features/settings/settings";
import { RECOMMENDED_CLOUD_MODEL, RECOMMENDED_MODEL } from "../../shared/constants";

const SETUP_STEPS = ["Welcome", "Local model", "Preferences", "Ready"] as const;

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
  getDiagnosticFacts?(): unknown;
  copyDiagnosticReport?(report: string): Promise<void>;
}

export interface OptionsAppProps {
  dependencies: OptionsAppDependencies;
}

export function OptionsApp({ dependencies }: OptionsAppProps) {
  const controller = useOnboarding({
    createClient: dependencies.createClient,
    settingsRepository: dependencies.settingsRepository,
    getUiLanguage: dependencies.getUiLanguage,
  });
  const step = onboardingStepNumber(controller.state);
  // The step-2 milestone used to read "Local model" unconditionally, so it could sit
  // right beside a "Choose a cloud model" heading and contradict it. The mode isn't
  // known yet at Welcome/choosing-mode, so it stays neutral there; once chosen (every
  // later step), it names the mode actually in effect.
  //
  // Reads controller.state.mode, not controller.preferences.selectedProvider: chooseMode
  // dispatches the "mode" action (updating state.mode) synchronously, but only persists
  // to preferences after an async storage round trip. A reader who just clicked "Use
  // Ollama Cloud" would otherwise see this label still say "Local model" for the one
  // render before that promise settles — reintroducing the exact contradiction this
  // task removes. state.mode is reducer-owned and carried forward on every other
  // action, so it never disagrees with `step`; it exists only to answer "which mode is
  // active right now" for this label and isn't read anywhere commands are built.
  const modeChosen =
    controller.state.step !== "loading" &&
    controller.state.step !== "welcome" &&
    controller.state.step !== "choosing-mode";
  const isCloudMode = controller.state.mode === "ollama-cloud";
  const modelMilestoneLabel = modeChosen
    ? isCloudMode
      ? "Cloud model"
      : "Local model"
    : "Model";

  return (
    <main className="setup-shell">
      <aside className="setup-rail" aria-label="Setup sequence">
        <div>
          <p className="product-name">Explain This</p>
          <h1>Ollama-powered explanations, set up clearly.</h1>
          <p className="rail-intro">
            Ollama does the explanation work, reached at a local address on this
            computer. Whether your selected text stays there or continues on to
            Ollama&apos;s cloud depends on the mode you choose.
          </p>
        </div>

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
            const displayLabel = index === 1 ? modelMilestoneLabel : label;
            return (
              <li
                key={label}
                data-status={status}
                aria-current={status === "current" ? "step" : undefined}
              >
                <span className="step-number">{number}</span>
                <span>{displayLabel}</span>
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
        <StepFrame eyebrow="Setup" heading="Loading Explain This">
          <div className="working-status" role="status">
            <span className="status-pulse" aria-hidden="true" />
            Loading settings…
          </div>
        </StepFrame>
      );
    case "welcome":
      return (
        <StepFrame eyebrow="Step 1 of 4" heading="Set up Explain This">
          <p>
            Explain This uses Ollama, which runs on this computer. It cannot install or
            start Ollama for you, but this setup checks each part and shows what to do.
          </p>
          <p className="privacy-line">
            Ollama listens at a local address, <code>127.0.0.1</code>. The next step
            lets you choose whether your selected text stays there or is sent on to
            Ollama&apos;s cloud.
          </p>
          <button
            className="button button-primary"
            type="button"
            onClick={controller.begin}
          >
            Start setup
          </button>
        </StepFrame>
      );
    case "choosing-mode":
      return <ModeStep controller={controller} />;
    case "checking-runtime":
      return (
        <StepFrame eyebrow="Step 2 of 4" heading="Checking Ollama">
          <div className="working-status" role="status">
            <span className="status-pulse" aria-hidden="true" />
            Looking for Ollama at <code>127.0.0.1:11434</code>…
          </div>
          <p>This check reads the local model list. It does not send page text.</p>
        </StepFrame>
      );
    case "runtime-missing":
      return (
        <StepFrame eyebrow="Step 2 of 4" heading="Ollama isn’t available">
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
    case "cloud-signin-guidance":
      return <CloudSigninStep error={state.error} onCheckAgain={controller.retry} />;
    case "choosing-model":
      return <ModelStep controller={controller} state={state} />;
    case "downloading":
      return (
        <DownloadStep
          onCancel={controller.cancelDownload}
          state={state}
          selectedProvider={controller.preferences.selectedProvider}
        />
      );
    case "preferences":
      return <PreferencesStep controller={controller} dependencies={dependencies} />;
    case "context":
      return <PreferencesStep controller={controller} dependencies={dependencies} />;
    case "permission":
      return <PreferencesStep controller={controller} dependencies={dependencies} />;
    case "readiness":
      return <ReadinessStep state={state} />;
    case "complete":
      return <ReadyStep controller={controller} resultState={state} />;
    case "settings":
      return <SettingsStep controller={controller} dependencies={dependencies} />;
    case "failed":
      return (
        <StepFrame eyebrow="Setup paused" heading="This step didn’t finish">
          <PublicErrorNotice
            error={state.error}
            onRetry={controller.retry}
            onShowOriginSteps={controller.showOriginGuidance}
            onContinueWithoutAccess={() => controller.resolvePermission(false, true)}
          />
        </StepFrame>
      );
  }
}

function LanguagePicker({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange(name: string): void;
}) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {READING_LANGUAGES.map((entry) => (
          <option key={entry.code} value={entry.name}>
            {languageLabel(entry)}
          </option>
        ))}
      </select>
    </>
  );
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
    <StepFrame eyebrow="Step 2 of 4" heading="Allow this extension in Ollama">
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

function ModeStep({ controller }: { controller: OnboardingController }) {
  return (
    <StepFrame eyebrow="Step 2 of 4" heading="Choose how it runs">
      <div className="mode-option">
        <Laptop size={20} strokeWidth={1.9} aria-hidden="true" focusable="false" />
        <h3>On this computer</h3>
        <p>
          Your selected text does not leave your machine. Requires Ollama and a model,
          about 3.3 GB.
        </p>
        <button
          className="button button-primary"
          type="button"
          onClick={() => controller.chooseMode("ollama-local")}
        >
          Use this computer
        </button>
      </div>

      <div className="mode-option">
        <Cloud size={20} strokeWidth={1.9} aria-hidden="true" focusable="false" />
        <h3>Ollama Cloud</h3>
        <p>
          Your selected text is sent to Ollama&apos;s servers. Ollama states that it
          does not retain your data. Runs larger models with nothing to download.
        </p>
        <button
          className="button button-primary"
          type="button"
          onClick={() => controller.chooseMode("ollama-cloud")}
        >
          Use Ollama Cloud
        </button>
      </div>
    </StepFrame>
  );
}

function CloudSigninStep({
  error,
  onCheckAgain,
}: {
  error: Extract<OnboardingState, { step: "cloud-signin-guidance" }>["error"];
  onCheckAgain(): void;
}) {
  return (
    <StepFrame eyebrow="Step 2 of 4" heading="Sign in to Ollama Cloud">
      <PublicErrorNotice error={error} />
      <p>Run these commands, then check again.</p>
      <ol className="guidance-list">
        <li>
          <code className="code-block">ollama signin</code>
        </li>
        <li>
          <code className="code-block">ollama pull {RECOMMENDED_CLOUD_MODEL}</code>
        </li>
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
  const selectedProvider = controller.preferences.selectedProvider;
  const isCloudMode = selectedProvider === "ollama-cloud";

  // In cloud mode the headline recommendation must be the cloud model, and there is no
  // "download" concept here — a cloud model only exists in this list once the reader has
  // pulled it via `ollama pull` (see CloudSigninStep). So the block only appears once that
  // model is actually present and the gate accepts it; otherwise there is no recommendation
  // rather than a false or gate-refused one.
  const headlineModelId = isCloudMode ? RECOMMENDED_CLOUD_MODEL : RECOMMENDED_MODEL;
  const headlineModel = state.models.find((model) => model.id === headlineModelId);
  const headlineInstalled =
    headlineModel !== undefined &&
    checkModeConsistency(selectedProvider, headlineModel.origin) === "ok";
  const showHeadline = !isCloudMode || headlineInstalled;

  const usableModels = state.models.filter(
    (model) => checkModeConsistency(selectedProvider, model.origin) === "ok",
  );
  const [installedModel, setInstalledModel] = useState(
    usableModels[0]?.id ?? state.models[0]?.id ?? "",
  );
  const selectedModelEntry = state.models.find((model) => model.id === installedModel);
  const selectionUsable =
    selectedModelEntry !== undefined &&
    checkModeConsistency(selectedProvider, selectedModelEntry.origin) === "ok";
  const hasSpecializedModel = state.models.some((model) =>
    model.displayName.toLowerCase().includes("code-specialized"),
  );

  return (
    <StepFrame
      eyebrow="Step 2 of 4"
      heading={isCloudMode ? "Choose a cloud model" : "Choose a local model"}
    >
      {showHeadline ? (
        <div className="model-recommendation">
          <p className="field-label">Recommended for general reading</p>
          <h3>{headlineModelId}</h3>
          <p>
            {isCloudMode
              ? "Runs on Ollama's servers. Nothing to download on this computer."
              : "Approximately 3.3 GB. The only model measured here that stays usable " +
                "across the European languages this extension targets."}
          </p>
          <button
            className="button button-primary"
            type="button"
            onClick={() => {
              if (headlineInstalled) {
                controller.useInstalledModel(headlineModelId);
              } else {
                controller.downloadModel(headlineModelId);
              }
            }}
          >
            {headlineInstalled ? (
              <Check size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
            ) : (
              <Download
                size={16}
                strokeWidth={1.9}
                aria-hidden="true"
                focusable="false"
              />
            )}
            {headlineInstalled
              ? `Use ${headlineModelId}`
              : `Download ${headlineModelId}`}
          </button>
        </div>
      ) : null}

      {state.models.length > 0 ? (
        <div className="installed-models">
          <label htmlFor="installed-model">Installed model</label>
          <select
            id="installed-model"
            value={installedModel}
            onChange={(event) => setInstalledModel(event.target.value)}
          >
            {state.models.map((model) => {
              const consistency = checkModeConsistency(selectedProvider, model.origin);
              const blocked = consistency !== "ok";
              const reason =
                consistency === "cloud-model-in-local-mode"
                  ? " — runs in Ollama's cloud"
                  : consistency === "local-model-in-cloud-mode"
                    ? " — runs on this computer"
                    : "";
              return (
                <option key={model.id} value={model.id} disabled={blocked}>
                  {model.displayName}
                  {model.sizeBytes === undefined
                    ? ""
                    : ` · ${formatBytes(model.sizeBytes)}`}
                  {reason}
                </option>
              );
            })}
          </select>
          {hasSpecializedModel ? (
            <p className="model-warning" role="status">
              Programming-focused models are better suited to code than general reading.
            </p>
          ) : null}
          <button
            className="button button-secondary"
            type="button"
            disabled={!installedModel || !selectionUsable}
            onClick={() => controller.useInstalledModel(installedModel)}
          >
            Use installed model
          </button>
        </div>
      ) : (
        <p className="empty-note">No installed model was found.</p>
      )}
      <div className="actions">
        <button
          className="button button-secondary"
          type="button"
          onClick={() => controller.goBack()}
        >
          <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
          Back
        </button>
      </div>
    </StepFrame>
  );
}

function DownloadStep({
  onCancel,
  state,
  selectedProvider,
}: {
  onCancel(): void;
  state: Extract<OnboardingState, { step: "downloading" }>;
  selectedProvider: SelectedProvider;
}) {
  const { progress } = state;
  const isLocalMode = selectedProvider === "ollama-local";
  const completed = progress.type === "progress" ? progress.completedBytes : 0;
  const total = progress.type === "progress" ? progress.totalBytes : undefined;
  // A cloud pull moves no weights across the network, so Ollama can report a `total` of
  // 0 rather than omitting it. Either way there is nothing to compute a percentage of.
  const indeterminate = total === undefined || total === 0;
  const detail = indeterminate
    ? completed > 0
      ? `${formatBytes(completed)} downloaded`
      : isLocalMode
        ? "Preparing local download"
        : "Preparing"
    : `${formatBytes(completed)} of ${formatBytes(total)}`;
  const heading = isLocalMode ? "Downloading the local model" : "Downloading the model";
  const storageNote = isLocalMode
    ? "Ollama stores this model on your computer. You can cancel and retry."
    : "Ollama runs this model in its cloud — nothing is stored on your computer. You can " +
      "cancel and retry.";

  return (
    <StepFrame eyebrow="Step 2 of 4" heading={heading}>
      <div role="status">
        {indeterminate ? (
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
      <p>{storageNote}</p>
      <button className="button button-secondary" type="button" onClick={onCancel}>
        Cancel download
      </button>
    </StepFrame>
  );
}

function PreferencesStep({
  controller,
  dependencies,
}: {
  controller: OnboardingController;
  dependencies: OptionsAppDependencies;
}) {
  const [draft, setDraft] = useState(controller.preferences);
  const isCloudMode = controller.preferences.selectedProvider === "ollama-cloud";
  const contextDestination = isCloudMode ? "the cloud model" : "your local model";
  const [nearbyContext, setNearbyContext] = useState(false);
  const [accessGranted, setAccessGranted] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [accessSettled, setAccessSettled] = useState(false);
  const [requesting, setRequesting] = useState(false);

  async function settleAccess(granted: boolean): Promise<void> {
    if (granted) {
      try {
        await dependencies.settingsRepository.update({ automaticToolbar: true });
        await dependencies.readerAccess.registerAutomaticAccess();
        setAccessGranted(true);
        setAccessDenied(false);
        setAccessSettled(true);
        setRequesting(false);
        return;
      } catch {
        // Fall through so the rollback below both persists and revokes.
      }
    }
    await dependencies.settingsRepository
      .update({ automaticToolbar: false })
      .catch(() => undefined);
    await dependencies.readerAccess.disableAutomaticAccess().catch(() => undefined);
    setAccessGranted(false);
    setAccessDenied(true);
    setAccessSettled(true);
    setRequesting(false);
  }

  /** Requested synchronously so the prompt stays inside the user gesture. */
  function toggleAccess(): void {
    if (accessGranted) {
      setAccessGranted(false);
      setAccessSettled(true);
      void dependencies.settingsRepository
        .update({ automaticToolbar: false })
        .then(() => dependencies.readerAccess.disableAutomaticAccess())
        .catch(() => undefined);
      return;
    }
    const request = dependencies.readerAccess.requestAutomaticAccess();
    setRequesting(true);
    void request.then(
      (granted) => settleAccess(granted),
      () => settleAccess(false),
    );
  }

  // Both transitions run in one handler, so React batches them into a single render and
  // the intermediate context state is never painted. Each decision is still recorded.
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // Leaving the toggle off must still revoke access granted in an earlier run, which is
    // what the old dedicated "Not now" button guaranteed.
    if (!accessGranted && !accessSettled) {
      void dependencies.settingsRepository
        .update({ automaticToolbar: false })
        .then(() => dependencies.readerAccess.disableAutomaticAccess())
        .catch(() => undefined);
    }
    controller.savePreferences({ ...draft, includeNearbyContext: nearbyContext });
    controller.resolvePermission(accessGranted, accessDenied && !accessGranted);
  }

  return (
    <StepFrame eyebrow="Step 3 of 4" heading="Choose how explanations read">
      <form onSubmit={submit}>
        <div className="field-group">
          <LanguagePicker
            id="preferred-language"
            label="Preferred language"
            value={resolveLanguageName(draft.preferredLanguage)}
            onChange={(preferredLanguage) => setDraft({ ...draft, preferredLanguage })}
          />
          <p className="field-help">
            Chrome suggested this language. Type the first letters to jump down the
            list.
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

        <label
          className="check-row privacy-choice"
          htmlFor="nearby-context"
          aria-label="Include nearby context. Off by default."
        >
          <input
            id="nearby-context"
            type="checkbox"
            checked={nearbyContext}
            onChange={(event) => setNearbyContext(event.target.checked)}
          />
          <span>
            <strong>Include nearby context</strong>
            <small>
              Off by default. A short piece of visible text beside your selection can
              clarify pronouns and ambiguous phrases, but more page text goes to{" "}
              {contextDestination}. Form values, hidden text, and unrelated regions are
              excluded.
            </small>
          </span>
        </label>

        <label
          className="check-row privacy-choice"
          htmlFor="automatic-toolbar"
          aria-label="Show the selection toolbar automatically. Off by default."
        >
          <input
            id="automatic-toolbar"
            type="checkbox"
            checked={accessGranted}
            disabled={requesting}
            onChange={toggleAccess}
          />
          <span>
            <strong>Show the selection toolbar automatically</strong>
            <small>
              Off by default. Needs optional access to ordinary pages. Without it, the
              context menu and keyboard shortcut still work.
            </small>
          </span>
        </label>

        <div className="actions">
          <button
            className="button button-secondary"
            type="button"
            onClick={() => controller.goBack()}
          >
            <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
            Back
          </button>
          <button className="button button-primary" type="submit">
            Confirm and continue
          </button>
        </div>
      </form>
    </StepFrame>
  );
}

function ReadinessStep({
  state,
}: {
  state: Extract<OnboardingState, { step: "readiness" }>;
}) {
  const isCloudMode = state.preferences.selectedProvider === "ollama-cloud";
  return (
    <StepFrame
      eyebrow="Step 4 of 4"
      heading={isCloudMode ? "Testing your cloud model" : "Testing your local model"}
    >
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
  const isCloudMode = controller.preferences.selectedProvider === "ollama-cloud";

  return (
    <StepFrame eyebrow="Step 4 of 4" heading="Ready">
      <div
        className={`readiness-result ${warning ? "warning" : "ready"}`}
        role="status"
      >
        <strong>
          {warning
            ? "Your model is ready, but slower than recommended."
            : isCloudMode
              ? "Your cloud model is ready."
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
          <li>
            Read the {isCloudMode ? "cloud" : "local"} explanation beside the selection.
          </li>
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

function SettingsStep({
  controller,
  dependencies,
}: {
  controller: OnboardingController;
  dependencies: OptionsAppDependencies;
}) {
  const isCloudMode = controller.preferences.selectedProvider === "ollama-cloud";
  const [blockedSites, setBlockedSites] = useState(controller.preferences.blockedSites);
  const [language, setLanguage] = useState(() =>
    resolveLanguageName(controller.preferences.preferredLanguage),
  );
  const [toolbar, setToolbar] = useState(controller.preferences.automaticToolbar);
  const [requesting, setRequesting] = useState(false);

  async function settleToolbar(granted: boolean): Promise<void> {
    if (granted) {
      try {
        await controller.updateSettings({ automaticToolbar: true });
        await dependencies.readerAccess.registerAutomaticAccess();
        setToolbar(true);
        setRequesting(false);
        return;
      } catch {
        // Fall through so the rollback below both persists and revokes.
      }
    }
    await controller.updateSettings({ automaticToolbar: false }).catch(() => undefined);
    await dependencies.readerAccess.disableAutomaticAccess().catch(() => undefined);
    setToolbar(false);
    setRequesting(false);
  }

  /** The optional origin must be requested inside the click, exactly as onboarding does. */
  function toggleToolbar(): void {
    if (toolbar) {
      setToolbar(false);
      void controller
        .updateSettings({ automaticToolbar: false })
        .then(() => dependencies.readerAccess.disableAutomaticAccess())
        .catch(() => undefined);
      return;
    }
    const request = dependencies.readerAccess.requestAutomaticAccess();
    setRequesting(true);
    void request.then(
      (granted) => settleToolbar(granted),
      () => settleToolbar(false),
    );
  }
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

  function readDiagnosticFacts(): unknown {
    try {
      return dependencies.getDiagnosticFacts?.() ?? {};
    } catch {
      return {};
    }
  }

  return (
    <StepFrame eyebrow="Settings" heading="Explanation settings">
      <p>
        Setup is complete. These preferences stay on this computer and can be changed
        without repeating the readiness test.
      </p>

      <div className="settings-group">
        <h3>How explanations read</h3>
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
                htmlFor={`settings-level-${value}`}
                key={value}
                aria-label={`${label}: ${help}`}
              >
                <input
                  id={`settings-level-${value}`}
                  type="radio"
                  name="settings-explanation-level"
                  value={value}
                  checked={controller.preferences.explanationLevel === value}
                  onChange={() =>
                    void controller.updateSettings({ explanationLevel: value })
                  }
                />
                <span>
                  <strong>{label}</strong>
                  <small>{help}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <LanguagePicker
          id="settings-language"
          label="Explanation language"
          value={language}
          onChange={(preferredLanguage) => {
            setLanguage(preferredLanguage);
            void controller.updateSettings({ preferredLanguage });
          }}
        />

        <label className="check-row">
          <input
            type="checkbox"
            checked={controller.preferences.preserveEnglishTerms}
            onChange={(event) =>
              void controller.updateSettings({
                preserveEnglishTerms: event.target.checked,
              })
            }
          />
          <span>Keep established English technical terms recognisable</span>
        </label>
      </div>

      <div className="settings-group">
        <h3>What the model can see</h3>
        <label className="check-row">
          <input
            type="checkbox"
            checked={controller.preferences.includeNearbyContext}
            onChange={(event) =>
              void controller.updateSettings({
                includeNearbyContext: event.target.checked,
              })
            }
          />
          <span>
            Include nearby context — the nearest visible paragraphs around your
            selection
          </span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={toolbar}
            disabled={requesting}
            onChange={toggleToolbar}
          />
          <span>
            Show the selection toolbar automatically — needs optional access to ordinary
            pages
          </span>
        </label>
      </div>

      <div className="settings-group">
        <h3>{isCloudMode ? "Cloud model" : "Local model"}</h3>
        <p className="field-help">
          Currently using <code>{controller.preferences.selectedModel}</code>. Changing
          the model or the Ollama connection runs setup again from the runtime check.
        </p>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => controller.checkRuntime()}
        >
          <RefreshCw size={16} strokeWidth={1.9} aria-hidden="true" focusable="false" />
          Run setup again
        </button>
      </div>

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
            <Plus size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
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
                  <Trash2
                    size={14}
                    strokeWidth={1.8}
                    aria-hidden="true"
                    focusable="false"
                  />
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-note">No blocked hosts.</p>
        )}
      </div>
      {dependencies.getDiagnosticFacts && dependencies.copyDiagnosticReport ? (
        <DiagnosticsView
          facts={readDiagnosticFacts()}
          trustedOverrides={{
            selectedModel: controller.preferences.selectedModel,
            automaticToolbar: controller.preferences.automaticToolbar,
            onboardingVersion: 1,
          }}
          copyReport={dependencies.copyDiagnosticReport}
        />
      ) : null}
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
