import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionToolbar } from "./ActionToolbar";

describe("ActionToolbar", () => {
  it("prevents selection collapse before the Explain button click fires", () => {
    const onAction = vi.fn();
    const { container } = render(<ActionToolbar onAction={onAction} />);

    const explainButton = within(container).getByRole("button", {
      name: "Explain",
    });
    const mouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });

    explainButton.dispatchEvent(mouseDown);

    expect(mouseDown.defaultPrevented).toBe(true);
    fireEvent.click(explainButton);
    expect(onAction).toHaveBeenCalledWith("explain");
  });
});
