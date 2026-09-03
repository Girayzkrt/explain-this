import { afterEach, describe, expect, it } from "vitest";
import { placeFloatingSurface, type Rect } from "./position";

const baseRect: Rect = {
  left: 100,
  top: 100,
  right: 140,
  bottom: 120,
  width: 40,
  height: 20,
};

afterEach(() => {
  Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
});

describe("placeFloatingSurface", () => {
  it("prefers a centered placement below the selection", () => {
    expect(
      placeFloatingSurface({
        selectionRect: baseRect,
        surfaceSize: { width: 80, height: 40 },
        viewportSize: { width: 500, height: 500 },
        margin: 8,
      }),
    ).toEqual({ left: 80, top: 128, placement: "below" });
  });

  it("falls back above when the surface does not fit below", () => {
    expect(
      placeFloatingSurface({
        selectionRect: { ...baseRect, top: 450, bottom: 470 },
        surfaceSize: { width: 80, height: 40 },
        viewportSize: { width: 500, height: 500 },
        margin: 8,
      }),
    ).toEqual({ left: 80, top: 402, placement: "above" });
  });

  it.each([
    ["left", { ...baseRect, left: -20, right: 20 }, 8],
    ["right", { ...baseRect, left: 470, right: 510 }, 412],
  ])(
    "clamps a %s-edge selection to the viewport margin",
    (_edge, selectionRect, left) => {
      expect(
        placeFloatingSurface({
          selectionRect,
          surfaceSize: { width: 80, height: 40 },
          viewportSize: { width: 500, height: 500 },
          margin: 8,
        }).left,
      ).toBe(left);
    },
  );

  it("anchors an over-wide surface at the margin in a narrow viewport", () => {
    expect(
      placeFloatingSurface({
        selectionRect: baseRect,
        surfaceSize: { width: 100, height: 40 },
        viewportSize: { width: 60, height: 300 },
        margin: 8,
      }).left,
    ).toBe(8);
  });

  it("uses fixed viewport coordinates without adding document scroll offsets", () => {
    Object.defineProperty(window, "scrollX", { configurable: true, value: 600 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 900 });

    expect(
      placeFloatingSurface({
        selectionRect: baseRect,
        surfaceSize: { width: 80, height: 40 },
        viewportSize: { width: 500, height: 500 },
        margin: 8,
      }),
    ).toEqual({ left: 80, top: 128, placement: "below" });
  });

  it("keeps the final fallback at the 8-pixel viewport margin", () => {
    expect(
      placeFloatingSurface({
        selectionRect: { left: -5, top: 2, right: 5, bottom: 10, width: 10, height: 8 },
        surfaceSize: { width: 100, height: 100 },
        viewportSize: { width: 80, height: 80 },
        margin: 8,
      }),
    ).toEqual({ left: 8, top: 8, placement: "above" });
  });
});
