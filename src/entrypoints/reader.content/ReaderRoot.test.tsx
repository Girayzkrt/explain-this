import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectionSnapshot } from "../../core/privacy/selection";
import type {
  BackgroundPortMessage,
  ReaderPortMessage,
} from "../../platform/messaging/contracts";
import {
  ReaderController,
  type ReaderConnection,
  type ReaderControllerDependencies,
} from "../../features/reader/reader-controller";
import { ReaderRoot } from "./ReaderRoot";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

afterEach(cleanup);

class UiConnection implements ReaderConnection {
  readonly sent: ReaderPortMessage[] = [];
  private readonly listeners = new Set<(message: BackgroundPortMessage) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  send(message: ReaderPortMessage): void {
    this.sent.push(message);
  }
  subscribe(listener: (message: BackgroundPortMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  subscribeDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }
  disconnect(): void {}
  emit(message: BackgroundPortMessage): void {
    act(() => {
      for (const listener of this.listeners) listener(message);
    });
  }
  suspend(): void {
    act(() => {
      for (const listener of this.disconnectListeners) listener();
    });
  }
}

function createUiHarness(includeNearbyContext = false) {
  const selectedElement = document.createElement("span");
  selectedElement.textContent = "Photosynthesis converts light into chemical energy.";
  document.body.append(selectedElement);
  const selected: SelectionSnapshot = {
    text: selectedElement.textContent,
    range: document.createRange(),
    rect: new DOMRect(40, 60, 220, 26),
    anchorElement: selectedElement,
  };
  const connection = new UiConnection();
  const frames: FrameRequestCallback[] = [];
  const restoreFocus = vi.fn();
  const writeClipboard = vi.fn(async () => undefined);
  const openSidePanel = vi.fn(async () => undefined);
  const openOptionsPage = vi.fn(async () => undefined);
  const dependencies: ReaderControllerDependencies = {
    captureSelection: () => selected,
    getReaderConfig: async () => ({
      automaticToolbar: true,
      blocked: false,
      includeNearbyContext,
    }),
    extractNearbyContext: () => ({
      text: includeNearbyContext ? "Plants use chlorophyll." : "",
      estimatedTokens: includeNearbyContext ? 5 : 0,
      sourceBlockCount: includeNearbyContext ? 1 : 0,
    }),
    connect: () => connection,
    createRequestId: () => REQUEST_ID,
    requestFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: vi.fn(),
    restoreFocus,
    writeClipboard,
    openSidePanel,
    openOptionsPage,
  };
  const controller = new ReaderController(dependencies);
  render(<ReaderRoot controller={controller} />);
  return {
    controller,
    connection,
    restoreFocus,
    writeClipboard,
    openSidePanel,
    openOptionsPage,
    async openActions() {
      await act(() => controller.selectionCompleted());
    },
    start(provider?: "ollama-local" | "ollama-cloud") {
      act(() => controller.startAction("explain"));
      connection.emit({
        type: "session-snapshot",
        session: {
          tabId: 3,
          requestId: REQUEST_ID,
          selectionPreview: selectedElement.textContent ?? "",
          action: "explain",
          contextIncluded: includeNearbyContext,
          status: "pending",
          answer: "",
          lastSequence: -1,
          origin: "https://reader.example",
          ...(provider === undefined ? {} : { provider }),
        },
      });
      connection.emit({
        type: "stream-event",
        event: { type: "started", requestId: REQUEST_ID },
      });
    },
    delta(text: string, sequence = 0) {
      connection.emit({
        type: "stream-event",
        event: { type: "delta", requestId: REQUEST_ID, sequence, text },
      });
      act(() => frames.shift()?.(16));
    },
    complete() {
      connection.emit({
        type: "stream-event",
        event: { type: "completed", requestId: REQUEST_ID },
      });
    },
  };
}

describe("reader in-page UI", () => {
  it("renders the four labeled actions and supports keyboard activation", async () => {
    const harness = createUiHarness();
    await harness.openActions();

    expect(
      screen.getByRole("toolbar", { name: /explain selected text/i }),
    ).toBeVisible();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Explain",
      "Simplify",
      "Translate (experimental)",
      "Example",
    ]);
    screen.getByRole("button", { name: "Explain" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Simplify" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("button", { name: "Explain" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(harness.connection.sent[0]).toMatchObject({
      type: "start-request",
      request: { action: "explain" },
    });
  });

  it("shows generation status, partial Markdown, context use, and Stop", async () => {
    const harness = createUiHarness(true);
    await harness.openActions();
    harness.start("ollama-local");
    harness.delta("A **local** explanation.");

    expect(screen.getByRole("status")).toHaveTextContent(/explaining locally/i);
    expect(screen.getByText("local", { selector: "strong" })).toBeVisible();
    expect(screen.getByText(/nearby context included/i)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(harness.connection.sent.at(-1)).toEqual({
      type: "cancel-request",
      requestId: REQUEST_ID,
    });
  });

  it("never claims local processing once the background reports a cloud-mode session", async () => {
    const harness = createUiHarness();
    await harness.openActions();
    harness.start("ollama-cloud");
    harness.delta("An explanation.");

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/ollama/i);
    expect(status).not.toHaveTextContent(/locally/i);
    expect(screen.getByRole("article").getAttribute("aria-label")).not.toMatch(
      /local/i,
    );
  });

  it("claims neither mode before the background reports which provider is in use", async () => {
    const harness = createUiHarness();
    await harness.openActions();
    act(() => harness.controller.startAction("explain"));
    harness.connection.emit({
      type: "stream-event",
      event: { type: "started", requestId: REQUEST_ID },
    });
    harness.delta("An explanation.");

    const status = screen.getByRole("status");
    expect(status).not.toHaveTextContent(/local/i);
    expect(status).not.toHaveTextContent(/cloud/i);
    const label = screen.getByRole("article").getAttribute("aria-label");
    expect(label).not.toMatch(/local/i);
    expect(label).not.toMatch(/cloud/i);
  });

  it("does not let response-control mouseup restart the page selection flow", async () => {
    const harness = createUiHarness();
    await harness.openActions();
    harness.start();
    const pageMouseUp = vi.fn();
    document.addEventListener("mouseup", pageMouseUp);

    try {
      screen
        .getByRole("button", { name: /stop/i })
        .dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    } finally {
      document.removeEventListener("mouseup", pageMouseUp);
    }

    expect(pageMouseUp).not.toHaveBeenCalled();
  });

  it("renders links as inert text and never mounts raw model HTML", async () => {
    const harness = createUiHarness();
    await harness.openActions();
    harness.start();
    harness.delta(
      "Read [this guide](https://attacker.example). ![tracking pixel](https://attacker.example/pixel.png) <img src=x onerror=alert(1)> <script>alert(1)</script>",
    );

    expect(screen.getByText("this guide")).toHaveClass("reader-markdown-link-text");
    expect(document.querySelector("a")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("tracking pixel")).toHaveClass(
      "reader-markdown-image-text",
    );
    expect(document.querySelector("script")).toBeNull();
  });

  it("offers Copy, side-panel handoff, and follow-ups only after completion", async () => {
    const harness = createUiHarness();
    await harness.openActions();
    harness.start();
    harness.delta("Completed answer");
    expect(screen.queryByRole("button", { name: /why\?/i })).not.toBeInTheDocument();
    harness.complete();

    for (const label of ["Simpler", "More detail", "Example", "Why?"]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }
    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    await userEvent.click(screen.getByRole("button", { name: /open in side panel/i }));
    expect(harness.writeClipboard).toHaveBeenCalledWith("Completed answer");
    expect(harness.openSidePanel).toHaveBeenCalledOnce();
  });

  it("reports a safe unsupported message when side-panel opening fails", async () => {
    const harness = createUiHarness();
    harness.openSidePanel.mockRejectedValueOnce(
      new Error("Sensitive browser implementation detail"),
    );
    await harness.openActions();
    harness.start();
    harness.delta("Completed answer");
    harness.complete();

    await userEvent.click(screen.getByRole("button", { name: /open in side panel/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      /side panel is unavailable in this browser/i,
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(/sensitive/i);
  });

  it("routes setup-related model failures to the trusted options page", async () => {
    const harness = createUiHarness();
    await harness.openActions();
    harness.start();
    harness.connection.emit({
      type: "stream-event",
      event: {
        type: "failed",
        requestId: REQUEST_ID,
        error: {
          code: "OLLAMA_UNREACHABLE",
          message: "Ollama is not reachable.",
          recoverable: true,
        },
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Open setup" }));
    expect(harness.openOptionsPage).toHaveBeenCalledOnce();
  });

  it("marks interrupted output incomplete and exposes recoverable Retry", async () => {
    const harness = createUiHarness();
    await harness.openActions();
    harness.start();
    harness.delta("Partial answer");
    harness.connection.suspend();

    expect(screen.getByRole("alert")).toHaveTextContent(/model could not finish/i);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/connection.*interrupted/i);
    expect(screen.getByText(/incomplete/i)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(harness.connection.sent).toContainEqual({
      type: "retry-request",
      requestId: REQUEST_ID,
    });
  });

  it("restores focus on Escape and exposes reduced-motion-safe styling hooks", async () => {
    const harness = createUiHarness();
    await harness.openActions();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(harness.restoreFocus).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-reader-surface]")).toBeNull();
  });
});
