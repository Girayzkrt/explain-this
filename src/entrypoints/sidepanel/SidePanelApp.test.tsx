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
  const result = render(
    <SidePanelApp
      controller={controller}
      copyText={copyText}
      optionsUrl="chrome-extension://extension-id/options.html"
    />,
  );
  return { controller, copyText, ...result };
}

afterEach(cleanup);

describe("focused explanation side panel", () => {
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
    expect(
      screen.getByRole("link", { name: /model and connection settings/i }),
    ).toHaveAttribute("href", "chrome-extension://extension-id/options.html");

    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(copyText).toHaveBeenCalledWith(session().answer);
    expect(controller.loadCalls).toBe(1);
  });

  it("shows streamed status and preserves partial output as incomplete", () => {
    const { controller } = renderPanel({
      status: "session",
      session: session({ status: "streaming", answer: "A partial answer" }),
    });

    expect(screen.getByRole("status")).toHaveTextContent(/explaining locally/i);
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();

    act(() => {
      controller.setState({
        status: "session",
        session: session({ status: "failed", answer: "A partial answer" }),
      });
    });
    expect(screen.getByText("A partial answer")).toBeVisible();
    expect(screen.getByText(/incomplete output/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
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
          code: "INVALID_REQUEST",
          message: "Select the passage again to continue.",
          recoverable: false,
        },
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/select the passage again/i);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(controller.retryCalls).toBe(1);
  });
});
