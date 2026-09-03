import { PublicError } from "../../core/requests/public-error";
import type { ModelConcurrencyGate } from "../../core/requests/model-concurrency-gate";
import type { PortLike, TrustedPortSender } from "../../platform/messaging/port";
import type { SettingsRepository } from "../../platform/storage/settings-repository";
import type { SelectedProvider } from "../settings/settings";
import type {
  DownloadableModelProvider,
  ModelInfo,
  ProviderHealth,
  PublicErrorShape,
} from "../../providers/provider";
import { RECOMMENDED_MODEL } from "../../shared/constants";
import {
  parseOnboardingCommand,
  type OnboardingCommand,
  type OnboardingEvent,
} from "./contracts";
import { runReadiness } from "./readiness";

export const ONBOARDING_PORT_NAME = "explain-this-onboarding";

interface OnboardingPortIdentity {
  name: string;
  sender?: TrustedPortSender | undefined;
}

export function isTrustedOnboardingPort(
  port: OnboardingPortIdentity,
  extensionPagePrefix: string,
): boolean {
  return (
    port.name === ONBOARDING_PORT_NAME &&
    typeof port.sender?.url === "string" &&
    port.sender.url.startsWith(extensionPagePrefix)
  );
}

export interface OnboardingServiceDependencies {
  provider: DownloadableModelProvider;
  settingsRepository: SettingsRepository;
  modelGate: ModelConcurrencyGate;
  now(): number;
}

function toPublicError(error: unknown): PublicErrorShape {
  if (error instanceof PublicError) {
    return { code: error.code, message: error.message, recoverable: error.recoverable };
  }
  return {
    code: "PROVIDER_ERROR",
    message: "The local model provider failed.",
    recoverable: true,
  };
}

function normalizeRuntimeError(error: PublicErrorShape): PublicErrorShape {
  if (error.code !== "CONNECTION_TIMEOUT") return error;
  return { ...error, code: "OLLAMA_UNREACHABLE" };
}

function runtimeFailure(error: unknown): ProviderHealth {
  const safe = normalizeRuntimeError(toPublicError(error));
  if (safe.code === "OLLAMA_ORIGIN_BLOCKED") {
    return {
      available: false,
      status: "origin-blocked",
      message: safe.message,
      error: safe,
      secondaryAction: "show-origin-guidance",
    };
  }
  if (safe.code === "OLLAMA_UNREACHABLE") {
    return {
      available: false,
      status: "unreachable",
      message: safe.message,
      error: safe,
      secondaryAction: "show-origin-guidance",
    };
  }
  return {
    available: false,
    status: "error",
    message: "Ollama could not be checked.",
    error: safe,
  };
}

function unavailableRuntimeHealth(health: ProviderHealth): ProviderHealth {
  const error = health.error ? normalizeRuntimeError(health.error) : undefined;
  if (health.status === undefined && error !== undefined) {
    return runtimeFailure(
      new PublicError(error.code, error.message, error.recoverable),
    );
  }

  const normalized = error === undefined ? health : { ...health, error };
  if (health.status === "origin-blocked" || health.status === "unreachable") {
    return { ...normalized, secondaryAction: "show-origin-guidance" };
  }
  if (health.status !== undefined) return normalized;
  return {
    ...normalized,
    status: "unreachable",
    message: health.message ?? "Ollama is not reachable.",
    secondaryAction: "show-origin-guidance",
  };
}

const CODE_MODEL_NAMES = [
  /(?:^|[:/_-])codegemma(?:$|[:/_-])/i,
  /(?:^|[:/_-])codellama(?:$|[:/_-])/i,
  /(?:^|[:/_-])deepseek-coder(?:$|[:/_-])/i,
  /(?:^|[:/_-])starcoder\d*(?:$|[:/_-])/i,
  /(?:^|[:/_-])qwen[\w.-]*-coder(?:$|[:/_-])/i,
] as const;

function isCodeSpecialized(model: string, family?: string): boolean {
  return CODE_MODEL_NAMES.some(
    (pattern) => pattern.test(model) || pattern.test(family ?? ""),
  );
}

export class OnboardingService {
  constructor(private readonly dependencies: OnboardingServiceDependencies) {}

  handle(port: PortLike<OnboardingEvent>): void {
    let disconnected = false;
    type Operation = {
      generation: number;
      kind: Exclude<OnboardingCommand["type"], "cancel-download">;
      controller: AbortController;
    };
    let generation = 0;
    let activeOperation: Operation | undefined;
    const owns = (operation?: Operation): boolean =>
      !disconnected && (operation === undefined || activeOperation === operation);
    const post = (message: OnboardingEvent, operation?: Operation): void => {
      if (!owns(operation)) return;
      try {
        port.postMessage(message);
      } catch {
        // Runtime disconnects are handled by the port lifecycle listener.
      }
    };
    const fail = (error: unknown, operation?: Operation): void =>
      post({ type: "onboarding-failed", error: toPublicError(error) }, operation);
    const onMessage = (input: unknown): void => {
      let command: OnboardingCommand;
      try {
        command = parseOnboardingCommand(input);
      } catch (error) {
        fail(error);
        return;
      }

      if (command.type === "cancel-download") {
        if (activeOperation?.kind === "download-model") {
          activeOperation.controller.abort();
        }
        return;
      }

      const operation: Operation = {
        generation: (generation += 1),
        kind: command.type,
        controller: new AbortController(),
      };
      activeOperation?.controller.abort();
      activeOperation = operation;
      const ownedPost = (message: OnboardingEvent): void => post(message, operation);
      void this.dispatch(command, operation.controller.signal, ownedPost)
        .catch((error: unknown) => fail(error, operation))
        .finally(() => {
          if (activeOperation === operation) activeOperation = undefined;
        });
    };
    const onDisconnect = (): void => {
      if (disconnected) return;
      disconnected = true;
      activeOperation?.controller.abort();
      activeOperation = undefined;
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
    };

    // Registration intentionally stays synchronous so early port messages are not lost.
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
  }

  private async dispatch(
    command: Exclude<OnboardingCommand, { type: "cancel-download" }>,
    signal: AbortSignal,
    post: (message: OnboardingEvent) => void,
  ): Promise<void> {
    switch (command.type) {
      case "check-runtime":
        post({ type: "runtime-result", health: await this.checkRuntime(signal) });
        return;
      case "list-models":
        post({
          type: "models-result",
          models: await this.listModels(command.mode, signal),
        });
        return;
      case "download-model":
        await this.download(command.model, signal, post);
        return;
      case "run-readiness":
        await this.readiness(command.model, command.preferences, signal, post);
        return;
      case "complete-onboarding":
        await this.dependencies.settingsRepository.update(command.preferences);
        await this.dependencies.settingsRepository.markOnboardingComplete();
        post({ type: "onboarding-complete" });
        return;
    }
  }

  private async checkRuntime(signal: AbortSignal): Promise<ProviderHealth> {
    try {
      const health = await this.dependencies.provider.checkHealth(signal);
      if (!health.available) {
        return unavailableRuntimeHealth(health);
      }
      const models = await this.dependencies.provider.listModels(signal);
      if (models.length === 0) {
        return {
          available: true,
          status: "model-required",
          message: "Ollama is ready, but no local model is installed.",
        };
      }
      return { available: true, status: "ready", message: "Ollama is ready." };
    } catch (error) {
      return runtimeFailure(error);
    }
  }

  private async listModels(
    mode: SelectedProvider,
    signal: AbortSignal,
  ): Promise<ModelInfo[]> {
    const models = await this.dependencies.provider.listModels(signal);
    // Uncertainty resolves toward cloud (see the spec's "Data model" section): an
    // "unknown" origin model is treated exactly like a "cloud" one here, not like
    // "local". Checking `!== "local"` rather than `=== "cloud"` is what keeps a
    // signed-in reader whose cloud model reports an unrecognised origin out of the
    // sign-in guidance loop they already escaped.
    if (mode === "ollama-cloud" && !models.some((model) => model.origin !== "local")) {
      throw new PublicError(
        "OLLAMA_SIGNIN_REQUIRED",
        "No Ollama Cloud models are available. Run `ollama signin`, then pull a cloud model.",
        true,
      );
    }
    return Promise.all(
      models.map(async (model) => {
        const details = await this.dependencies.provider.getModelDetails(
          model.id,
          signal,
        );
        if (!isCodeSpecialized(model.id, details.family)) return model;
        return { ...model, displayName: `${model.displayName} · Code-specialized` };
      }),
    );
  }

  private async validateModel(model: string, signal: AbortSignal): Promise<void> {
    if (model === RECOMMENDED_MODEL) return;
    const installed = await this.dependencies.provider.listModels(signal);
    if (!installed.some((candidate) => candidate.id === model)) {
      throw new PublicError(
        "INVALID_REQUEST",
        "The selected model is not in the local model library.",
        false,
      );
    }
  }

  private async download(
    model: string,
    signal: AbortSignal,
    post: (message: OnboardingEvent) => void,
  ): Promise<void> {
    await this.validateModel(model, signal);
    await this.dependencies.modelGate.runExclusive(signal, async () => {
      for await (const progress of this.dependencies.provider.downloadModel(
        model,
        signal,
      )) {
        post({ type: "download-progress", progress });
      }
    });
  }

  private async readiness(
    model: string,
    preferences: Parameters<typeof runReadiness>[2],
    signal: AbortSignal,
    post: (message: OnboardingEvent) => void,
  ): Promise<void> {
    await this.validateModel(model, signal);
    const result = await runReadiness(
      {
        provider: this.dependencies.provider,
        modelGate: this.dependencies.modelGate,
        now: this.dependencies.now,
      },
      model,
      preferences,
      signal,
    );
    post({ type: "readiness-result", result });
  }
}
