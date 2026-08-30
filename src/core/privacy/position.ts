export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function placeFloatingSurface(input: {
  selectionRect: Rect;
  surfaceSize: Size;
  viewportSize: Size;
  margin: number;
}): { left: number; top: number; placement: "above" | "below" } {
  const { selectionRect, surfaceSize, viewportSize, margin } = input;
  const maximumLeft = Math.max(margin, viewportSize.width - surfaceSize.width - margin);
  const centeredLeft =
    selectionRect.left + selectionRect.width / 2 - surfaceSize.width / 2;
  const left = clamp(centeredLeft, margin, maximumLeft);

  const belowTop = selectionRect.bottom + margin;
  const fitsBelow = belowTop + surfaceSize.height <= viewportSize.height - margin;
  const placement = fitsBelow ? "below" : "above";
  const desiredTop = fitsBelow
    ? belowTop
    : selectionRect.top - surfaceSize.height - margin;
  const maximumTop = Math.max(
    margin,
    viewportSize.height - surfaceSize.height - margin,
  );
  const top = clamp(desiredTop, margin, maximumTop);

  return { left, top, placement };
}
