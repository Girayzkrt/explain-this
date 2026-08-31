import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
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

  it("does not update feedback after the view unmounts", async () => {
    const pending = deferred<void>();
    const copyReport = vi.fn(() => pending.promise);
    const view = render(
      <DiagnosticsView facts={{ extensionVersion: "1.0.0" }} copyReport={copyReport} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /copy diagnostics/i }));
    view.unmount();
    await act(async () => pending.resolve());

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("only shows the result of the latest clipboard operation", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const copyReport = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(
      <DiagnosticsView facts={{ extensionVersion: "1.0.0" }} copyReport={copyReport} />,
    );

    const button = screen.getByRole("button", { name: /copy diagnostics/i });
    await userEvent.click(button);
    await userEvent.click(button);
    await act(async () => {
      second.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status")).toHaveTextContent(/copied/i);
    await act(async () => {
      first.reject(new Error("older failure"));
      await Promise.resolve();
    });

    expect(screen.getByRole("status")).toHaveTextContent(/copied/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps clipboard feedback active after StrictMode effect replay", async () => {
    render(
      <StrictMode>
        <DiagnosticsView
          facts={{ extensionVersion: "1.0.0" }}
          copyReport={vi.fn().mockResolvedValue(undefined)}
        />
      </StrictMode>,
    );

    await userEvent.click(screen.getByRole("button", { name: /copy diagnostics/i }));

    expect(screen.getByRole("status")).toHaveTextContent(/copied/i);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
