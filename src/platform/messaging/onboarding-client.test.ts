import { describe, expect, it } from "vitest";
import { ONBOARDING_PORT_NAME } from "../../features/onboarding/onboarding-service";
import { OnboardingClient, type OnboardingClientPort } from "./onboarding-client";

class ListenerSet<T> {
  readonly listeners = new Set<T>();
  addListener(listener: T): void {
    this.listeners.add(listener);
  }
  removeListener(listener: T): void {
    this.listeners.delete(listener);
  }
}

function fakePort() {
  return {
    postMessage() {},
    onMessage: new ListenerSet<(message: unknown) => void>(),
    onDisconnect: new ListenerSet<() => void>(),
    disconnect() {},
  } satisfies OnboardingClientPort;
}

describe("onboarding client", () => {
  it("exposes disconnect so the onboarding state machine can reconnect after suspension", () => {
    const port = fakePort();
    const client = new OnboardingClient({
      connect(options) {
        expect(options).toEqual({ name: ONBOARDING_PORT_NAME });
        return port;
      },
    });
    let disconnects = 0;
    const unsubscribe = client.subscribeDisconnect(() => {
      disconnects += 1;
    });

    for (const listener of [...port.onDisconnect.listeners]) listener();
    unsubscribe();
    for (const listener of [...port.onDisconnect.listeners]) listener();

    expect(disconnects).toBe(1);
  });
});
