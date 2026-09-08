import { describe, expect, it } from "vitest";
import { getPreviewRendererResolution, shouldRenderScreenPreview } from "./previewPerformance";

describe("preview performance", () => {
	it("preserves device resolution while the backing canvas stays below 1080p", () => {
		expect(getPreviewRendererResolution(800, 450, 2)).toBe(2);
	});

	it("caps a fullscreen high-DPI preview to a 1080p-sized backing canvas", () => {
		expect(getPreviewRendererResolution(3840, 2160, 2)).toBeCloseTo(0.5);
		expect(getPreviewRendererResolution(2560, 1440, 2)).toBeCloseTo(0.75);
	});

	it("uses at most native CSS resolution while scrubbing", () => {
		expect(getPreviewRendererResolution(800, 450, 2, true)).toBe(1);
	});

	it("skips the hidden screen renderer for webcam-only layouts", () => {
		expect(shouldRenderScreenPreview("only-webcam")).toBe(false);
		expect(shouldRenderScreenPreview("picture-in-picture")).toBe(true);
	});
});
