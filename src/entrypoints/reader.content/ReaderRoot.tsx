import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ActionToolbar } from "../../components/ActionToolbar";
import { ResponseCard } from "../../components/ResponseCard";
import { placeFloatingSurface } from "../../core/privacy/position";
import type { ReaderController } from "../../features/reader/reader-controller";

export interface ReaderRootProps {
  controller: ReaderController;
}

export function ReaderRoot({ controller }: ReaderRootProps) {
  const [sidePanelError, setSidePanelError] = useState<string>();
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      controller.closeFor("escape");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [controller]);

  const surfaceStyle = useMemo(() => {
    if (state.status === "idle") return undefined;
    const anchor = state.status === "actions" ? state.selection : state.anchor;
    const width = state.status === "actions" ? 392 : 416;
    const height = state.status === "actions" ? 52 : 360;
    const position = placeFloatingSurface({
      selectionRect: anchor.rect,
      surfaceSize: { width, height },
      viewportSize: { width: window.innerWidth, height: window.innerHeight },
      margin: 8,
    });
    return { left: position.left, top: position.top };
  }, [state]);

  if (state.status === "idle" || !surfaceStyle) return null;

  return (
    <div
      className="reader-surface"
      data-reader-surface
      style={surfaceStyle}
      data-state={state.status}
    >
      {state.status === "actions" ? (
        <ActionToolbar onAction={(action) => controller.startAction(action)} />
      ) : (
        <ResponseCard
          state={state}
          onStop={() => controller.stop()}
          onRetry={() => controller.retry()}
          onCopy={() => void controller.copyAnswer()}
          onOpenSidePanel={() => {
            setSidePanelError(undefined);
            void controller.openSidePanel().catch(() => {
              setSidePanelError("The side panel is unavailable in this browser.");
            });
          }}
          onFollowUp={(intent) => controller.followUp(intent)}
          onClose={() => controller.closeFor("invalidation")}
          {...(sidePanelError === undefined ? {} : { sidePanelError })}
        />
      )}
    </div>
  );
}
