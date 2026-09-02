import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import {
  parseReaderInvocationCommand,
  type ReaderInvocationCommand,
} from "../../platform/messaging/reader-command";
import { parseReaderRuntimeConfig } from "../../platform/messaging/reader-runtime";
import { extractNearbyContext } from "../../core/privacy/context-extractor";
import { captureSelection, type SelectionSnapshot } from "../../core/privacy/selection";
import {
  ReaderController,
  type ReaderConnection,
} from "../../features/reader/reader-controller";
import { READER_PORT_NAME } from "../../features/reader/background-events";
import { ReaderRoot } from "./ReaderRoot";
import { createReaderConnection } from "./reader-connection";
import readerCss from "./reader.css?inline";

function connectReader(): ReaderConnection {
  return createReaderConnection(browser.runtime.connect({ name: READER_PORT_NAME }));
}

function restoreReadingFocus(snapshot: SelectionSnapshot): void {
  const element = snapshot.anchorElement;
  if (!(element instanceof HTMLElement)) return;
  const hadTabIndex = element.hasAttribute("tabindex");
  if (!hadTabIndex) element.setAttribute("tabindex", "-1");
  element.focus({ preventScroll: true });
  if (!hadTabIndex) {
    element.addEventListener("blur", () => element.removeAttribute("tabindex"), {
      once: true,
    });
  }
}

export default defineContentScript({
  // This loopback match is only a WXT build-generation input. Task 7 owns the
  // actual optional HTTP(S) runtime registration and activeTab injection.
  matches: ["http://127.0.0.1:11434/*"],
  registration: "runtime",
  runAt: "document_idle",
  world: "ISOLATED",
  cssInjectionMode: "manual",
  async main(ctx) {
    const existing = document.querySelector("explain-this-reader");
    if (existing?.shadowRoot) return;

    const controller = new ReaderController({
      captureSelection,
      async getReaderConfig() {
        const response = await browser.runtime.sendMessage({
          type: "get-reader-config",
        });
        return parseReaderRuntimeConfig(response);
      },
      extractNearbyContext,
      connect: connectReader,
      createRequestId: () => crypto.randomUUID(),
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (id) => cancelAnimationFrame(id),
      restoreFocus: restoreReadingFocus,
      writeClipboard: (text) => navigator.clipboard.writeText(text),
      async openSidePanel() {
        await browser.runtime.sendMessage({ type: "open-side-panel" });
      },
      async openOptionsPage() {
        await browser.runtime.sendMessage({ type: "open-options-page" });
      },
    });

    const onMouseUp = (): void => {
      void controller.selectionCompleted();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === "Escape" || event.key === "Tab") return;
      void controller.selectionCompleted();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") controller.closeFor("escape");
    };
    const onSelectionChange = (): void => controller.contextInvalidated();
    const onBlur = (): void => controller.closeFor("blur");
    const onPageHide = (): void => controller.destroy();
    const onInvocation = (input: unknown): void => {
      let command: ReaderInvocationCommand;
      try {
        command = parseReaderInvocationCommand(input);
      } catch {
        return;
      }
      void controller.handleInvocation(command);
    };

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onPageHide);
    browser.runtime.onMessage.addListener(onInvocation);

    const ui = await createShadowRootUi(ctx, {
      name: "explain-this-reader",
      css: readerCss,
      position: "overlay",
      anchor: "body",
      zIndex: 2147483647,
      isolateEvents: true,
      onMount(container) {
        const root = createRoot(container);
        root.render(<ReaderRoot controller={controller} />);
        return root;
      },
      onRemove(root) {
        document.removeEventListener("mouseup", onMouseUp);
        document.removeEventListener("keyup", onKeyUp);
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("selectionchange", onSelectionChange);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("pagehide", onPageHide);
        browser.runtime.onMessage.removeListener(onInvocation);
        controller.destroy();
        root?.unmount();
      },
    });
    ui.mount();
  },
});
