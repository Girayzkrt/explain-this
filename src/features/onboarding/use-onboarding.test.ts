import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { OnboardingCommand, OnboardingEvent } from "./contracts";
import { getErrorPresentation } from "../../core/requests/error-copy";
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

function renderOnboarding(
  options: {
    failUpdates?: { current: boolean };
    onboardingVersion?: StoredSettings["onboardingVersion"];
  } = {},
) {
  const clients: FakeClient[] = [];
  const settings = storedSettings();
  if (options.onboardingVersion !== undefined) {
    settings.onboardingVersion = options.onboardingVersion;
  }
  const settingsRepository: SettingsRepository = {
    async get() {
      return structuredClone(settings);
    },
    async update(patch) {
      if (options.failUpdates?.current) throw new Error("storage.local.set failed");
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

    act(() => result.current.begin());

    expect(result.current.state.step).toBe("choosing-mode");
  });

  test("keeps the mode choice inside the second milestone", () => {
    expect(onboardingStepNumber({ step: "choosing-mode", mode: "ollama-local" })).toBe(
      2,
    );
  });

  test("returns from model choice to the mode choice", async () => {
    const harness = renderOnboarding();
    await waitFor(() => expect(harness.result.current.state.step).toBe("welcome"));

    act(() => harness.result.current.begin());
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

  test("still probes the runtime when retried from origin guidance", async () => {
    const harness = renderOnboarding();
    await waitFor(() => expect(harness.result.current.state.step).toBe("welcome"));

    act(() => harness.result.current.begin());
    act(() => harness.result.current.chooseMode("ollama-local"));
    act(() => {
      harness.client.emit({
        type: "runtime-result",
        health: {
          available: false,
          status: "origin-blocked",
          secondaryAction: "show-origin-guidance",
        },
      });
    });
    expect(harness.result.current.state.step).toBe("origin-guidance");

    act(() => harness.result.current.checkRuntime());

    expect(harness.result.current.state.step).toBe("checking-runtime");
    expect(harness.client.sent.at(-1)).toEqual({ type: "check-runtime" });
  });

  test("surfaces a mode choice that could not be persisted instead of swallowing it", async () => {
    const failUpdates = { current: true };
    const harness = renderOnboarding({ failUpdates });
    await waitFor(() => expect(harness.result.current.state.step).toBe("welcome"));

    act(() => harness.result.current.begin());
    act(() => harness.result.current.chooseMode("ollama-cloud"));

    await waitFor(() => expect(harness.result.current.state.step).toBe("failed"));
    const state = harness.result.current.state;
    if (state.step !== "failed") throw new Error("expected failed step");
    // A dedicated code, not the reader-card copy of INVALID_REQUEST, and one whose
    // presentation names the problem and offers a retry control.
    expect(state.error.code).toBe("MODE_NOT_SAVED");
    const presentation = getErrorPresentation(state.error.code);
    expect(presentation.title).toMatch(/mode/i);
    expect(presentation.explanation).toMatch(/previous mode is still in effect/i);
    expect(presentation.primaryAction.intent).toBe("retry");
    // The runtime probe must not fire on a failed save — its later result would
    // silently replace this failure notice before the reader can read it.
    expect(harness.client.sent).not.toContainEqual({ type: "check-runtime" });

    // The reader is not dead-ended: retrying re-attempts the same save, and once
    // storage stops failing it proceeds exactly like a first-time success would.
    failUpdates.current = false;
    act(() => harness.result.current.retry());
    await waitFor(() =>
      expect(harness.result.current.state.step).toBe("checking-runtime"),
    );
    expect(harness.client.sent).toContainEqual({ type: "check-runtime" });
  });

  test("surfaces a Settings mode change that could not be persisted instead of swallowing it", async () => {
    const failUpdates = { current: false };
    const harness = renderOnboarding({
      failUpdates,
      onboardingVersion: 1,
    });
    await waitFor(() => expect(harness.result.current.state.step).toBe("settings"));

    failUpdates.current = true;
    act(() => harness.result.current.changeMode("ollama-cloud"));

    await waitFor(() => expect(harness.result.current.state.step).toBe("failed"));
    const state = harness.result.current.state;
    if (state.step !== "failed") throw new Error("expected failed step");
    expect(state.error.code).toBe("MODE_NOT_SAVED");
    const presentation = getErrorPresentation(state.error.code);
    expect(presentation.primaryAction.intent).toBe("retry");
    // The revalidation list-models must not fire on a failed save — its later
    // result could silently replace this failure notice before the reader reads it.
    expect(harness.client.sent).not.toContainEqual({
      type: "list-models",
      mode: "ollama-cloud",
    });

    // Retrying re-attempts the same save rather than dead-ending the reader.
    failUpdates.current = false;
    act(() => harness.result.current.retry());
    await waitFor(() =>
      expect(harness.client.sent).toContainEqual({
        type: "list-models",
        mode: "ollama-cloud",
      }),
    );
  });
});
