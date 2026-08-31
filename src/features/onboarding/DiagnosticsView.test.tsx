import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsView } from "./DiagnosticsView";

afterEach(cleanup);

describe("DiagnosticsView", () => {
  it("writes a sanitized two-space report only after an explicit click", async () => {
    const copyReport = vi.fn<(value: string) => Promise<void>>().mockResolvedValue();
    render(
      <DiagnosticsView
        facts={{ extensionVersion: "1.0.0", selection: "private selection" }}
        copyReport={copyReport}
      />,
    );

    expect(copyReport).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /copy diagnostics/i }));
    expect(copyReport).toHaveBeenCalledWith(
      expect.stringMatching(/^\{\n\x20{2}"extensionVersion": "1.0.0"/),
    );
    expect(copyReport.mock.calls[0]?.[0]).not.toContain("private selection");
    expect(screen.getByRole("status")).toHaveTextContent(/copied/i);
  });

  it("shows fixed safe feedback when clipboard writing fails", async () => {
    render(
      <DiagnosticsView
        facts={{ extensionVersion: "1.0.0" }}
        copyReport={vi
          .fn()
          .mockRejectedValue(new Error("clipboard implementation secret"))}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /copy diagnostics/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/could not copy diagnostics/i);
    expect(screen.getByRole("alert")).not.toHaveTextContent("implementation secret");
  });

  it("shows fixed safe feedback when clipboard writing throws synchronously", async () => {
    render(
      <DiagnosticsView
        facts={{ extensionVersion: "1.0.0" }}
        copyReport={() => {
          throw new Error("clipboard implementation secret");
        }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /copy diagnostics/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/could not copy diagnostics/i);
    expect(screen.getByRole("alert")).not.toHaveTextContent("implementation secret");
  });
});
