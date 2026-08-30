import { ONBOARDING_PORT_NAME } from "../../features/onboarding/onboarding-service";
import {
  parseOnboardingCommand,
  parseOnboardingEvent,
  type OnboardingCommand,
  type OnboardingEvent,
} from "../../features/onboarding/contracts";
import type { ListenerSet } from "./port";

export interface OnboardingClientPort {
  postMessage(message: OnboardingCommand): void;
  onMessage: ListenerSet<(message: unknown) => void>;
  disconnect(): void;
}

export interface OnboardingClientRuntime {
  connect(options: { name: typeof ONBOARDING_PORT_NAME }): OnboardingClientPort;
}

export class OnboardingClient {
  private readonly port: OnboardingClientPort;

  constructor(runtime: OnboardingClientRuntime) {
    this.port = runtime.connect({ name: ONBOARDING_PORT_NAME });
  }

  send(input: unknown): void {
    this.port.postMessage(parseOnboardingCommand(input));
  }

  subscribe(listener: (event: OnboardingEvent) => void): () => void {
    const onMessage = (input: unknown): void => listener(parseOnboardingEvent(input));
    this.port.onMessage.addListener(onMessage);
    return () => this.port.onMessage.removeListener(onMessage);
  }

  disconnect(): void {
    this.port.disconnect();
  }
}
