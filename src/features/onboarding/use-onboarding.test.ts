import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { OnboardingCommand, OnboardingEvent } from "./contracts";
import { DEFAULT_PREFERENCES } from "../settings/settings";
import type {
  SettingsRepository,
  StoredSettings,
} from "../../platform/storage/settings-repository";
import {
  onboardingStepNumber,
  useOnboarding,
  type OnboardingClientConnection,
} from "./use-onboarding";

class FakeClient implements OnboardingClientConnection {
  readonly sent: OnboardingCommand[] = [];
  private readonly listeners = new Set<(event: OnboardingEvent) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  send(command: OnboardingCommand): void {
    this.sent.push(structuredClone(command));
  }

  subscribe(listener: (event: OnboardingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  disconnect(): void {}

  emit(event: OnboardingEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event));
  }
}

function storedSettings(): StoredSettings {
  return {
    onboardingVersion: 0,
    preferences: { ...DEFAULT_PREFERENCES, blockedSites: [] },
  };
}

function renderOnboarding() {
  const clients: FakeClient[] = [];
  const settings = storedSettings();
  const settingsRepository: SettingsRepository = {
    async get() {
      return structuredClone(settings);
    },
    async update(patch) {
      settings.preferences = { ...settings.preferences, ...patch };
      return structuredClone(settings);
    },
    async markOnboardingComplete() {
      settings.onboardingVersion = 1;
      return structuredClone(settings);
    },
  };

  const { result } = renderHook(() =>
    useOnboarding({
      createClient() {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
      settingsRepository,
      getUiLanguage: () => "English",
    }),
  );

  return {
    result,
    settings,
    get client(): FakeClient {
      const client = clients.at(-1);
      if (!client) throw new Error("The onboarding client was not opened.");
      return client;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("choosing how the model runs", () => {
  test("asks how it should run before probing the runtime", async () => {
    const { result } = renderOnboarding();
    await waitFor(() => expect(result.current.state.step).toBe("welcome"));

    act(() => result.current.checkRuntime());

    expect(result.current.state.step).toBe("choosing-mode");
  });

  test("keeps the mode choice inside the second milestone", () => {
    expect(onboardingStepNumber({ step: "choosing-mode" })).toBe(2);
  });

  test("returns from model choice to the mode choice", async () => {
    const harness = renderOnboarding();
    await waitFor(() => expect(harness.result.current.state.step).toBe("welcome"));

    act(() => harness.result.current.checkRuntime());
    act(() => harness.result.current.chooseMode("ollama-cloud"));
    act(() => {
      harness.client.emit({
        type: "runtime-result",
        health: { available: true, status: "ready" },
      });
    });
    act(() => {
      harness.client.emit({
        type: "models-result",
        models: [{ id: "gemma3:4b", displayName: "gemma3:4b", origin: "local" }],
      });
    });
    act(() => harness.result.current.goBack());

    expect(harness.result.current.state.step).toBe("choosing-mode");
  });
});
