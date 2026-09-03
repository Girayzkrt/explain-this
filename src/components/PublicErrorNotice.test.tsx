import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PublicErrorNotice } from "./PublicErrorNotice";

describe("PublicErrorNotice", () => {
  it("uses the public code copy and renders only a supplied compatible control", async () => {
    const retry = vi.fn();
    render(
      <PublicErrorNotice
        error={{
          code: "PROVIDER_ERROR",
          message: "Sensitive provider response: token=do-not-display",
          recoverable: true,
        }}
        onRetry={retry}
        onOpenSetup={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Model could not finish");
    expect(screen.getByRole("alert")).not.toHaveTextContent("token=do-not-display");
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Open setup" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
