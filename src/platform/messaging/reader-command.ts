import type { ReadingAction } from "../../core/requests/types";

export type ReaderInvocationCommand =
  | {
      type: "selection-action";
      action: ReadingAction;
      selectionText: string;
    }
  | {
      type: "capture-current-selection";
      action: "explain";
    };
