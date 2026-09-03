import { TriangleAlert } from "lucide-react";
import type { PublicErrorShape } from "../providers/provider";
import {
  getErrorPresentation,
  type ErrorControlIntent,
} from "../core/requests/error-copy";

export interface PublicErrorNoticeProps {
  error: PublicErrorShape;
  onRetry?: () => void;
  onOpenSetup?: () => void;
  onChooseModel?: () => void;
  onShowOriginSteps?: () => void;
  onSelectLessText?: () => void;
  onContinueWithoutAccess?: () => void;
  onDismiss?: () => void;
}

function callbackFor(
  intent: ErrorControlIntent,
  props: PublicErrorNoticeProps,
): (() => void) | undefined {
  switch (intent) {
    case "retry":
      return props.onRetry;
    case "open-setup":
      return props.onOpenSetup;
    case "choose-model":
      return props.onChooseModel;
    case "show-origin-steps":
      return props.onShowOriginSteps;
    case "select-less-text":
      return props.onSelectLessText;
    case "continue-without-access":
      return props.onContinueWithoutAccess;
    case "dismiss":
      return props.onDismiss;
  }
}

export function PublicErrorNotice(props: PublicErrorNoticeProps) {
  const presentation = getErrorPresentation(props.error.code);
  const onAction = callbackFor(presentation.primaryAction.intent, props);

  return (
    <div className="error-notice" role="alert">
      <TriangleAlert
        className="error-notice-icon"
        size={18}
        strokeWidth={1.9}
        aria-hidden="true"
        focusable="false"
      />
      <div>
        <strong>{presentation.title}</strong>
        <p>{presentation.explanation}</p>
      </div>
      {onAction ? (
        <button className="button button-secondary" type="button" onClick={onAction}>
          {presentation.primaryAction.label}
        </button>
      ) : null}
    </div>
  );
}
