import { PublicError } from "../../core/requests/public-error";
import type { ModelConcurrencyGate } from "../../core/requests/model-concurrency-gate";
import type { PortLike, TrustedPortSender } from "../../platform/messaging/port";
import type { SettingsRepository } from "../../platform/storage/settings-repository";
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

function runtimeFailure(error: unknown): ProviderHealth {
  const safe = toPublicError(error);
  if (safe.code === "OLLAMA_ORIGIN_BLOCKED") {
    return {
      available: false,
      status: "origin-blocked",
      message: safe.message,
      error: safe,
      secondaryAction: "show-origin-guidance",
    };
  }
  if (safe.code === "OLLAMA_UNREACHABLE" || safe.code === "CONNECTION_TIMEOUT") {
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
  private downloadController: AbortController | undefined;
  private readinessController: AbortController | undefined;

  constructor(private readonly dependencies: OnboardingServiceDependencies) {}

  handle(port: PortLike<OnboardingEvent>): void {
    let disconnected = false;
    const post = (message: OnboardingEvent): void => {
      if (disconnected) return;
      try {
        port.postMessage(message);
      } catch {
        // Runtime disconnects are handled by the port lifecycle listener.
      }
    };
    const fail = (error: unknown): void =>
      post({ type: "onboarding-failed", error: toPublicError(error) });
    const onMessage = (input: unknown): void => {
      let command: OnboardingCommand;
      try {
        command = parseOnboardingCommand(input);
      } catch (error) {
        fail(error);
        return;
      }

      if (command.type === "cancel-download") {
        this.downloadController?.abort();
        return;
      }
      void this.dispatch(command, post).catch(fail);
    };
    const onDisconnect = (): void => {
      if (disconnected) return;
      disconnected = true;
      this.downloadController?.abort();
      this.readinessController?.abort();
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
    };

    // Registration intentionally stays synchronous so early port messages are not lost.
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
  }

  private async dispatch(
    command: Exclude<OnboardingCommand, { type: "cancel-download" }>,
    post: (message: OnboardingEvent) => void,
  ): Promise<void> {
    switch (command.type) {
      case "check-runtime":
        post({ type: "runtime-result", health: await this.checkRuntime() });
        return;
      case "list-models":
        post({ type: "models-result", models: await this.listModels() });
        return;
      case "download-model":
        await this.download(command.model, post);
        return;
      case "run-readiness":
        await this.readiness(command.model, command.preferences, post);
        return;
      case "complete-onboarding":
        await this.dependencies.settingsRepository.update(command.preferences);
        await this.dependencies.settingsRepository.markOnboardingComplete();
        post({ type: "onboarding-complete" });
        return;
    }
  }

  private async checkRuntime(): Promise<ProviderHealth> {
    const controller = new AbortController();
    try {
      const health = await this.dependencies.provider.checkHealth(controller.signal);
      if (!health.available) {
        return {
          available: false,
          status: "unreachable",
          message: health.message ?? "Ollama is not reachable.",
          secondaryAction: "show-origin-guidance",
        };
      }
      const models = await this.dependencies.provider.listModels(controller.signal);
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

  private async listModels(): Promise<ModelInfo[]> {
    const controller = new AbortController();
    const models = await this.dependencies.provider.listModels(controller.signal);
    return Promise.all(
      models.map(async (model) => {
        const details = await this.dependencies.provider.getModelDetails(
          model.id,
          controller.signal,
        );
        if (!isCodeSpecialized(model.id, details.family)) return model;
        return { ...model, displayName: `${model.displayName} · Code-specialized` };
      }),
    );
  }

  private async download(
    model: string,
    post: (message: OnboardingEvent) => void,
  ): Promise<void> {
    const validationController = new AbortController();
    if (model !== RECOMMENDED_MODEL) {
      const installed = await this.dependencies.provider.listModels(
        validationController.signal,
      );
      if (!installed.some((candidate) => candidate.id === model)) {
        throw new PublicError(
          "INVALID_REQUEST",
          "The selected model is not in the local model library.",
          false,
        );
      }
    }

    this.downloadController?.abort();
    const controller = new AbortController();
    this.downloadController = controller;
    try {
      await this.dependencies.modelGate.runExclusive(controller.signal, async () => {
        for await (const progress of this.dependencies.provider.downloadModel(
          model,
          controller.signal,
        )) {
          post({ type: "download-progress", progress });
        }
      });
    } finally {
      if (this.downloadController === controller) this.downloadController = undefined;
    }
  }

  private async readiness(
    model: string,
    preferences: Parameters<typeof runReadiness>[2],
    post: (message: OnboardingEvent) => void,
  ): Promise<void> {
    this.readinessController?.abort();
    const controller = new AbortController();
    this.readinessController = controller;
    try {
      const result = await runReadiness(
        {
          provider: this.dependencies.provider,
          modelGate: this.dependencies.modelGate,
          now: this.dependencies.now,
        },
        model,
        preferences,
        controller.signal,
      );
      post({ type: "readiness-result", result });
    } finally {
      if (this.readinessController === controller) this.readinessController = undefined;
    }
  }
}
