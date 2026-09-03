import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FollowUpIntent } from "../../core/requests/types";
import type { ReaderSession } from "../../features/reader/session";
import type {
  SidePanelController,
  SidePanelState,
} from "../../features/reader/sidepanel-controller";
import { SidePanelApp } from "./SidePanelApp";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174014";

function session(overrides: Partial<ReaderSession> = {}): ReaderSession {
  return {
    tabId: 7,
    requestId: REQUEST_ID,
    selectionPreview: "A compact passage selected in the active article.",
    action: "explain",
    contextIncluded: true,
    status: "completed",
    answer:
      "A **local** explanation with [offsite](https://tracker.example) and ![beacon](https://tracker.example/pixel.png). <script>bad()</script>",
    lastSequence: 0,
    origin: "https://article.example",
    ...overrides,
  };
}

class TestController implements SidePanelController {
  private listeners = new Set<() => void>();
  state: SidePanelState;
  loadCalls = 0;
  disposeCalls = 0;
  stopCalls = 0;
  retryCalls = 0;
  followUps: FollowUpIntent[] = [];

  constructor(state: SidePanelState) {
    this.state = state;
  }

  getSnapshot = (): SidePanelState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async load(): Promise<void> {
    this.loadCalls += 1;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  retry(): void {
    this.retryCalls += 1;
  }

  followUp(intent: FollowUpIntent): void {
    this.followUps.push(intent);
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  setState(state: SidePanelState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

function renderPanel(state: SidePanelState) {
  const controller = new TestController(state);
  const copyText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
  const openSettings = vi.fn();
  const result = render(
    <SidePanelApp
      controller={controller}
      copyText={copyText}
      openSettings={openSettings}
    />,
  );
  return { controller, copyText, openSettings, ...result };
}

afterEach(cleanup);

describe("focused explanation side panel", () => {
  // A link navigated the panel itself away from the current explanation.
  it("opens settings from a button without navigating the panel", async () => {
    const { openSettings } = renderPanel({ status: "session", session: session() });

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(openSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
  });

  it("renders the current selection, context, safe Markdown, copy, and diagnostics", async () => {
    const { controller, copyText } = renderPanel({
      status: "session",
      session: session(),
    });

    expect(screen.getByRole("heading", { name: "Explain This" })).toBeVisible();
    expect(screen.getByText(/compact passage selected/i)).toBeVisible();
    expect(screen.getByText(/nearby context included/i)).toBeVisible();
    expect(screen.getByText("local", { selector: "strong" })).toBeVisible();
    expect(screen.getByText("offsite")).toBeVisible();
    expect(document.querySelector("a[href='https://tracker.example']")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(copyText).toHaveBeenCalledWith(session().answer);
    expect(controller.loadCalls).toBe(1);
  });

  it("never claims local processing while a cloud-mode session streams", () => {
    renderPanel({
      status: "session",
      session: session({ status: "streaming", provider: "ollama-cloud" }),
    });

    expect(screen.getByText("Cloud reader")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Explaining via Ollama’s cloud…",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(/locally/i);
    expect(screen.queryByText("Local reader")).not.toBeInTheDocument();
  });

  it("keeps the local reassurance when the session's provider is local", () => {
    renderPanel({
      status: "session",
      session: session({ status: "streaming", provider: "ollama-local" }),
    });

    expect(screen.getByText("Local reader")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(/explaining locally/i);
  });

  it("renders neutral wording that claims neither mode when the provider is unknown", () => {
    const { session: builtSession } = { session: session({ status: "streaming" }) };
    expect(builtSession.provider).toBeUndefined();
    renderPanel({ status: "session", session: builtSession });

    expect(screen.getByText("Reader")).toBeVisible();
    expect(screen.queryByText("Local reader")).not.toBeInTheDocument();
    expect(screen.queryByText("Cloud reader")).not.toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).not.toHaveTextContent(/local/i);
    expect(status).not.toHaveTextContent(/cloud/i);
  });

  it("uses neutral wording in the empty state, before any session exists", () => {
    renderPanel({ status: "empty" });

    expect(screen.getByText("Reader")).toBeVisible();
    expect(screen.queryByText("Local reader")).not.toBeInTheDocument();
  });

  it("shows streamed status and preserves partial output as incomplete", () => {
    const { controller } = renderPanel({
      status: "session",
      session: session({
        status: "streaming",
        answer: "A partial answer",
        provider: "ollama-local",
      }),
    });

    expect(screen.getByRole("status")).toHaveTextContent(/explaining locally/i);
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();

    act(() => {
      controller.setState({
        status: "session",
        session: session({
          status: "failed",
          answer: "A partial answer",
          error: {
            code: "PROVIDER_ERROR",
            message: "private provider detail",
            recoverable: true,
          },
        }),
      });
    });
    expect(screen.getByText("A partial answer")).toBeVisible();
    expect(screen.getByText(/incomplete output/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("exposes only bounded typed follow-ups and keeps their accessible order", async () => {
    const { controller } = renderPanel({
      status: "session",
      session: session(),
    });
    const user = userEvent.setup();
    const names = ["Copy", "Simpler", "More detail", "Why?", "Another example"];

    for (const name of names.slice(1)) {
      await user.click(screen.getByRole("button", { name }));
    }
    expect(controller.followUps).toEqual([
      "simpler",
      "more-detail",
      "why",
      "another-example",
    ]);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    cleanup();
    renderPanel({ status: "session", session: session() });
    for (const name of names) {
      await user.tab();
      expect(screen.getByRole("button", { name })).toHaveFocus();
    }
  });

  it("updates for a tab switch and gives an instructional empty state", () => {
    const { controller, container } = renderPanel({
      status: "session",
      session: session(),
    });
    expect(container.firstElementChild).toHaveClass("sidepanel-shell");

    act(() => controller.setState({ status: "empty" }));

    expect(screen.getByRole("heading", { name: /select a passage/i })).toBeVisible();
    expect(screen.getByText(/choose explain this/i)).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows expired-source guidance and invokes exact Stop and Retry controls", async () => {
    const { controller } = renderPanel({
      status: "session",
      session: session({ status: "streaming" }),
    });

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(controller.stopCalls).toBe(1);

    act(() => {
      controller.setState({
        status: "session",
        session: session({ status: "failed" }),
        actionError: {
          code: "PROVIDER_ERROR",
          message: "Select the passage again: private provider body",
          recoverable: true,
        },
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/model could not finish/i);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/private provider body/i);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(controller.retryCalls).toBe(1);
  });
});
