const EXCLUDED_READING_ELEMENTS = new Set([
  "BUTTON",
  "FORM",
  "INPUT",
  "NOSCRIPT",
  "OPTION",
  "SCRIPT",
  "SELECT",
  "STYLE",
  "TEXTAREA",
]);

function elementForNode(node: Node): Element | null {
  if (node instanceof Element) return node;
  return node.parentElement;
}

export function isVisibleReadingNode(node: Node): boolean {
  let element = elementForNode(node);
  if (element === null) return false;

  while (element !== null) {
    if (EXCLUDED_READING_ELEMENTS.has(element.tagName)) return false;
    if (element.hasAttribute("contenteditable")) return false;
    if (element.hasAttribute("hidden") || element.hasAttribute("inert")) return false;
    if (element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true") {
      return false;
    }

    const view = element.ownerDocument.defaultView;
    if (view === null) return false;
    const style = view.getComputedStyle(element);
    if (style.display === "none") return false;
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;

    const opacity = Number.parseFloat(style.opacity);
    if (Number.isFinite(opacity) && opacity <= 0) return false;

    element = element.parentElement;
  }

  return true;
}
