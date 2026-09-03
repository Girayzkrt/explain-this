import { Languages, Lightbulb, Sparkles, WandSparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReadingAction } from "../core/requests/types";
import type { KeyboardEvent } from "react";

const actions: ReadonlyArray<{
  action: ReadingAction;
  label: string;
  Icon: LucideIcon;
}> = [
  { action: "explain", label: "Explain", Icon: Sparkles },
  { action: "simplify", label: "Simplify", Icon: WandSparkles },
  { action: "translate", label: "Translate (experimental)", Icon: Languages },
  { action: "example", label: "Example", Icon: Lightbulb },
];

export interface ActionToolbarProps {
  onAction(action: ReadingAction): void;
}

export function ActionToolbar({ onAction }: ActionToolbarProps) {
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    );
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
            buttons.length;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <div
      className="reader-toolbar"
      role="toolbar"
      aria-label="Explain selected text"
      onKeyDown={moveFocus}
    >
      {actions.map(({ action, label, Icon }) => (
        <button
          className="reader-toolbar-button"
          key={action}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onAction(action)}
        >
          {/* Decorative: the visible label already names the action, so the icon stays
              out of the accessible name. */}
          <Icon size={15} strokeWidth={1.75} aria-hidden="true" focusable="false" />
          {label}
        </button>
      ))}
    </div>
  );
}
