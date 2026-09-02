import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { OnboardingClient } from "../../platform/messaging/onboarding-client";
import type { SettingsRepository } from "../../platform/storage/settings-repository";
import type {
  ModelDownloadEvent,
  ModelInfo,
  PublicErrorShape,
} from "../../providers/provider";
import { resolveLanguageName } from "../settings/languages";
import {
  createDefaultPreferences,
  type ReadingPreferences,
  type SelectedProvider,
} from "../settings/settings";
import type { OnboardingCommand, OnboardingEvent, ReadinessResult } from "./contracts";

export interface OnboardingClientConnection {
  send(command: OnboardingCommand): void;
  subscribe(listener: (event: OnboardingEvent) => void): () => void;
  subscribeDisconnect(listener: () => void): () => void;
  disconnect(): void;
}

export type OnboardingState =
  | { step: "loading" }
  | { step: "welcome" }
  | { step: "choosing-mode" }
  | { step: "checking-runtime" }
  | {
      step: "runtime-missing";
      error: PublicErrorShape;
      showOriginGuidance: boolean;
    }
  | { step: "origin-guidance"; error: PublicErrorShape }
  | { step: "choosing-model"; models: ModelInfo[] }
  | { step: "downloading"; progress: ModelDownloadEvent }
  | { step: "preferences"; model: string }
  | { step: "context"; preferences: ReadingPreferences }
  | { step: "permission"; preferences: ReadingPreferences }
  | {
      step: "readiness";
      preferences: ReadingPreferences;
      permissionDenied: boolean;
    }
  | { step: "complete"; result: ReadinessResult }
  | { step: "settings" }
  | { step: "failed"; error: PublicErrorShape; interruptedStep: number };

type OnboardingAction =
  | { type: "hydrated"; completed: boolean }
  | { type: "check-runtime" }
  | { type: "mode"; mode: SelectedProvider }
  | {
      type: "runtime-missing";
      error: PublicErrorShape;
      showOriginGuidance: boolean;
    }
  | { type: "show-origin-guidance" }
  | { type: "origin-guidance"; error: PublicErrorShape }
  | { type: "models"; models: ModelInfo[] }
  | { type: "download"; progress: ModelDownloadEvent }
  | { type: "preferences"; model: string }
  | { type: "context"; preferences: ReadingPreferences }
  | { type: "permission"; preferences: ReadingPreferences }
  | {
      type: "readiness";
      preferences: ReadingPreferences;
      permissionDenied: boolean;
    }
  | { type: "complete"; result: ReadinessResult }
  | { type: "back"; models: ModelInfo[]; model: string }
  | { type: "saved" }
  | { type: "failed"; error: PublicErrorShape };

export function onboardingStepNumber(state: OnboardingState): number {
  switch (state.step) {
    case "loading":
    case "welcome":
      return 1;
    case "choosing-mode":
    case "checking-runtime":
    case "runtime-missing":
    case "origin-guidance":
    case "choosing-model":
    case "downloading":
      return 2;
    case "preferences":
    case "context":
    case "permission":
      return 3;
    case "readiness":
    case "complete":
    case "settings":
      return 4;
    case "failed":
      return state.interruptedStep;
  }
}

function reduceOnboarding(
  state: OnboardingState,
  action: OnboardingAction,
): OnboardingState {
  switch (action.type) {
    case "hydrated":
      return { step: action.completed ? "settings" : "welcome" };
    case "check-runtime":
      // From welcome, only advance to the mode choice — the runtime probe itself
      // waits until chooseMode has persisted which mode to probe. Every other
      // caller (origin-guidance retry, settings' "run setup again") keeps probing
      // immediately, as before.
      return state.step === "welcome"
        ? { step: "choosing-mode" }
        : { step: "checking-runtime" };
    case "mode":
      return { step: "checking-runtime" };
    case "back":
      switch (state.step) {
        case "choosing-model":
          return { step: "choosing-mode" };
        case "preferences":
          return { step: "choosing-model", models: action.models };
        case "complete":
          return { step: "preferences", model: action.model };
        default:
          // Downloads and the readiness test own their own cancellation.
          return state;
      }
    case "runtime-missing":
      return {
        step: "runtime-missing",
        error: action.error,
        showOriginGuidance: action.showOriginGuidance,
      };
    case "show-origin-guidance":
      return state.step === "runtime-missing"
        ? { step: "origin-guidance", error: state.error }
        : state;
    case "origin-guidance":
      return { step: "origin-guidance", error: action.error };
    case "models":
      return { step: "choosing-model", models: action.models };
    case "download":
      return { step: "downloading", progress: action.progress };
    case "preferences":
      return { step: "preferences", model: action.model };
    case "context":
      return { step: "context", preferences: action.preferences };
    case "permission":
      return { step: "permission", preferences: action.preferences };
    case "readiness":
      return {
        step: "readiness",
        preferences: action.preferences,
        permissionDenied: action.permissionDenied,
      };
    case "complete":
      return { step: "complete", result: action.result };
    case "saved":
      return state.step === "complete" ? { step: "settings" } : state;
    case "failed":
      return {
        step: "failed",
        error: action.error,
        interruptedStep: onboardingStepNumber(state),
      };
  }
}

function recoverableError(
  code: PublicErrorShape["code"],
  message: string,
): PublicErrorShape {
  return { code, message, recoverable: true };
}

export interface OnboardingController {
  state: OnboardingState;
  preferences: ReadingPreferences;
  showOriginGuidance(): void;
  checkRuntime(): void;
  chooseMode(mode: SelectedProvider): void;
  goBack(): void;
  downloadModel(model: string): void;
  useInstalledModel(model: string): void;
  cancelDownload(): void;
  savePreferences(preferences: ReadingPreferences): void;
  saveContext(includeNearbyContext: boolean): void;
  resolvePermission(granted: boolean, denied?: boolean): void;
  runReadiness(preferences?: ReadingPreferences, permissionDenied?: boolean): void;
  finish(): void;
  updateSettings(patch: Partial<ReadingPreferences>): Promise<void>;
  retry(): void;
}

export interface UseOnboardingDependencies {
  createClient(): OnboardingClientConnection | OnboardingClient;
  settingsRepository: SettingsRepository;
  getUiLanguage(): string;
}

function initialPreferences(getUiLanguage: () => string): ReadingPreferences {
  const preferences = createDefaultPreferences();
  const uiLanguage = getUiLanguage().trim();
  if (uiLanguage.length >= 2 && uiLanguage.length <= 64) {
    preferences.preferredLanguage = resolveLanguageName(uiLanguage);
  }
  return preferences;
}

export function useOnboarding({
  createClient,
  settingsRepository,
  getUiLanguage,
}: UseOnboardingDependencies): OnboardingController {
  const [state, dispatch] = useReducer(reduceOnboarding, { step: "loading" });
  const [preferences, setPreferences] = useState(() =>
    initialPreferences(getUiLanguage),
  );
  const preferencesRef = useRef(preferences);
  const lastModelsRef = useRef<ModelInfo[]>([]);
  const clientRef = useRef<OnboardingClientConnection | undefined>(undefined);
  const resumableCommandRef = useRef<OnboardingCommand | undefined>(undefined);
  const retryCommandRef = useRef<OnboardingCommand | undefined>(undefined);
  const [connectionGeneration, reconnect] = useReducer(
    (generation: number) => generation + 1,
    0,
  );

  useEffect(() => {
    let mounted = true;
    void settingsRepository.get().then((stored) => {
      if (!mounted) return;
      preferencesRef.current = stored.preferences;
      setPreferences(stored.preferences);
      dispatch({ type: "hydrated", completed: stored.onboardingVersion === 1 });
    });
    return () => {
      mounted = false;
    };
  }, [settingsRepository]);

  const send = useCallback(
    (
      command: OnboardingCommand,
      options: { resumable?: boolean; retryable?: boolean } = {},
    ): void => {
      const { resumable = true, retryable = true } = options;
      if (resumable) resumableCommandRef.current = command;
      if (retryable) retryCommandRef.current = command;
      clientRef.current?.send(command);
    },
    [],
  );

  const setChosenPreferences = useCallback((next: ReadingPreferences): void => {
    preferencesRef.current = next;
    setPreferences(next);
  }, []);

  const handleEvent = useCallback(
    (event: OnboardingEvent): void => {
      switch (event.type) {
        case "runtime-result":
          if (event.health.available) {
            send({ type: "list-models" });
            return;
          }
          resumableCommandRef.current = undefined;
          if (event.health.status === "origin-blocked") {
            dispatch({
              type: "origin-guidance",
              error:
                event.health.error ??
                recoverableError(
                  "OLLAMA_ORIGIN_BLOCKED",
                  event.health.message ?? "Ollama rejected this extension origin.",
                ),
            });
            return;
          }
          dispatch({
            type: "runtime-missing",
            error:
              event.health.error ??
              recoverableError(
                "OLLAMA_UNREACHABLE",
                event.health.message ?? "Ollama is not available.",
              ),
            showOriginGuidance: event.health.secondaryAction === "show-origin-guidance",
          });
          return;
        case "models-result":
          lastModelsRef.current = event.models;
          resumableCommandRef.current = undefined;
          dispatch({ type: "models", models: event.models });
          return;
        case "download-progress":
          dispatch({ type: "download", progress: event.progress });
          if (event.progress.type === "completed") {
            resumableCommandRef.current = undefined;
            const next = {
              ...preferencesRef.current,
              selectedModel: event.progress.model,
            };
            setChosenPreferences(next);
            dispatch({ type: "preferences", model: event.progress.model });
          } else if (event.progress.type === "failed") {
            resumableCommandRef.current = undefined;
            dispatch({ type: "failed", error: event.progress.error });
          }
          return;
        case "readiness-result":
          resumableCommandRef.current = undefined;
          dispatch({ type: "complete", result: event.result });
          return;
        case "onboarding-complete":
          resumableCommandRef.current = undefined;
          dispatch({ type: "saved" });
          return;
        case "onboarding-failed":
          resumableCommandRef.current = undefined;
          dispatch({ type: "failed", error: event.error });
      }
    },
    [send, setChosenPreferences],
  );

  useEffect(() => {
    const client = createClient() as OnboardingClientConnection;
    clientRef.current = client;
    const unsubscribeMessage = client.subscribe(handleEvent);
    const unsubscribeDisconnect = client.subscribeDisconnect(() => reconnect());
    const resumableCommand = resumableCommandRef.current;
    if (resumableCommand) client.send(resumableCommand);

    return () => {
      unsubscribeMessage();
      unsubscribeDisconnect();
      if (clientRef.current === client) clientRef.current = undefined;
      client.disconnect();
    };
  }, [connectionGeneration, createClient, handleEvent]);

  const checkRuntime = useCallback((): void => {
    dispatch({ type: "check-runtime" });
    // From welcome this only advances to the mode choice (handled in the
    // reducer); probing the runtime before a mode is chosen would check the
    // wrong provider. Every other caller still probes immediately.
    if (state.step === "welcome") return;
    send({ type: "check-runtime" });
  }, [send, state.step]);

  const goBack = useCallback((): void => {
    dispatch({
      type: "back",
      models: lastModelsRef.current,
      model: preferencesRef.current.selectedModel,
    });
  }, []);

  const showOriginGuidance = useCallback((): void => {
    dispatch({ type: "show-origin-guidance" });
  }, []);

  const downloadModel = useCallback(
    (model: string): void => {
      dispatch({ type: "download", progress: { type: "started", model } });
      send({ type: "download-model", model });
    },
    [send],
  );

  const useInstalledModel = useCallback(
    (model: string): void => {
      const next = { ...preferencesRef.current, selectedModel: model };
      setChosenPreferences(next);
      dispatch({ type: "preferences", model });
    },
    [setChosenPreferences],
  );

  const cancelDownload = useCallback((): void => {
    resumableCommandRef.current = undefined;
    send({ type: "cancel-download" }, { resumable: false, retryable: false });
    dispatch({
      type: "failed",
      error: recoverableError("REQUEST_CANCELLED", "The model download was cancelled."),
    });
  }, [send]);

  const savePreferences = useCallback(
    (next: ReadingPreferences): void => {
      setChosenPreferences(next);
      dispatch({ type: "context", preferences: next });
    },
    [setChosenPreferences],
  );

  const saveContext = useCallback(
    (includeNearbyContext: boolean): void => {
      const next = { ...preferencesRef.current, includeNearbyContext };
      setChosenPreferences(next);
      dispatch({ type: "permission", preferences: next });
    },
    [setChosenPreferences],
  );

  const runReadiness = useCallback(
    (next = preferencesRef.current, permissionDenied = false): void => {
      dispatch({ type: "readiness", preferences: next, permissionDenied });
      send({
        type: "run-readiness",
        model: next.selectedModel,
        preferences: next,
      });
    },
    [send],
  );

  const resolvePermission = useCallback(
    (granted: boolean, denied = false): void => {
      const next = { ...preferencesRef.current, automaticToolbar: granted };
      setChosenPreferences(next);
      runReadiness(next, denied && !granted);
    },
    [runReadiness, setChosenPreferences],
  );

  const finish = useCallback((): void => {
    send({
      type: "complete-onboarding",
      preferences: preferencesRef.current,
    });
  }, [send]);

  const updateSettings = useCallback(
    async (patch: Partial<ReadingPreferences>): Promise<void> => {
      const stored = await settingsRepository.update(patch);
      setChosenPreferences(stored.preferences);
    },
    [settingsRepository, setChosenPreferences],
  );

  const chooseMode = useCallback(
    (mode: SelectedProvider): void => {
      dispatch({ type: "mode", mode });
      // Persist before probing so the runtime check reads the mode just chosen,
      // not whatever was stored before. A persistence failure must not strand
      // the reader on the checking-runtime screen, so the probe still runs.
      void updateSettings({ selectedProvider: mode })
        .catch(() => undefined)
        .then(() => {
          send({ type: "check-runtime" });
        });
    },
    [send, updateSettings],
  );

  const retry = useCallback((): void => {
    const command = retryCommandRef.current;
    if (!command) return;

    switch (command.type) {
      case "check-runtime":
      case "list-models":
        dispatch({ type: "check-runtime" });
        break;
      case "download-model":
        dispatch({
          type: "download",
          progress: { type: "started", model: command.model },
        });
        break;
      case "run-readiness":
        dispatch({
          type: "readiness",
          preferences: command.preferences,
          permissionDenied: !command.preferences.automaticToolbar,
        });
        break;
      case "complete-onboarding":
      case "cancel-download":
        break;
    }
    send(command);
  }, [send]);

  return {
    state,
    preferences,
    showOriginGuidance,
    checkRuntime,
    chooseMode,
    goBack,
    downloadModel,
    useInstalledModel,
    cancelDownload,
    savePreferences,
    saveContext,
    resolvePermission,
    runReadiness,
    finish,
    updateSettings,
    retry,
  };
}
