import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectionSnapshot } from "../core/privacy/selection";
import type { ReaderUiState } from "../features/reader/reader-controller";
import { ResponseCard } from "./ResponseCard";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174020";

function anchor(): SelectionSnapshot {
  const anchorElement = document.createElement("p");
  anchorElement.textContent = "A selected sentence.";
  document.body.append(anchorElement);
  return {
    text: "A selected sentence.",
    range: document.createRange(),
    rect: new DOMRect(10, 10, 100, 20),
    anchorElement,
  };
}

function connectingState(
  provider?: "ollama-local" | "ollama-cloud",
): Extract<ReaderUiState, { status: "connecting" }> {
  return {
    status: "connecting",
    requestId: REQUEST_ID,
    preview: "A selected sentence.",
    action: "explain",
    contextIncluded: false,
    anchor: anchor(),
    ...(provider === undefined ? {} : { provider }),
  };
}

function generatingState(
  provider?: "ollama-local" | "ollama-cloud",
): Extract<ReaderUiState, { status: "generating" }> {
  return {
    ...connectingState(provider),
    status: "generating",
    answer: "Partial answer",
  };
}

function renderCard(state: ReaderUiState) {
  return render(
    <ResponseCard
      state={state as never}
      onStop={vi.fn()}
      onRetry={vi.fn()}
      onCopy={vi.fn()}
      onOpenSidePanel={vi.fn()}
      onOpenSetup={vi.fn()}
      onChooseModel={vi.fn()}
      onShowOriginSteps={vi.fn()}
      onFollowUp={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("ResponseCard provider wording", () => {
  it("keeps the local claim and label when the session's provider is local", () => {
    renderCard(connectingState("ollama-local"));

    expect(screen.getByRole("article")).toHaveAccessibleName("Local explanation");
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to local model…");

    cleanup();
    renderCard(generatingState("ollama-local"));
    expect(screen.getByRole("status")).toHaveTextContent(/explaining locally/i);
  });

  it("never claims local processing when the session's provider is cloud", () => {
    renderCard(connectingState("ollama-cloud"));

    const article = screen.getByRole("article");
    expect(article).toHaveAccessibleName("Cloud explanation");
    expect(article.getAttribute("aria-label")).not.toMatch(/local/i);
    expect(screen.getByRole("status")).toHaveTextContent(/ollama/i);
    expect(screen.getByRole("status")).not.toHaveTextContent(/local/i);

    cleanup();
    renderCard(generatingState("ollama-cloud"));
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/ollama/i);
    expect(status).not.toHaveTextContent(/locally/i);
  });

  it("claims neither mode when the session carries no provider field", () => {
    renderCard(connectingState());

    const article = screen.getByRole("article");
    expect(article.getAttribute("aria-label")).not.toMatch(/local|cloud/i);
    const status = screen.getByRole("status");
    expect(status).not.toHaveTextContent(/local/i);
    expect(status).not.toHaveTextContent(/cloud/i);

    cleanup();
    renderCard(generatingState());
    const generatingStatus = screen.getByRole("status");
    expect(generatingStatus).not.toHaveTextContent(/local/i);
    expect(generatingStatus).not.toHaveTextContent(/cloud/i);
  });
});
