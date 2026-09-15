import { describe, expect, it } from "vitest";
import { getWebcamSourceCrop, getWebcamVideoStyle, normalizeWebcamFraming } from "./webcamFraming";

const source = { width: 1920, height: 1080 };
const square = { width: 300, height: 300 };

describe("webcam framing", () => {
	it("preserves the centered cover crop for existing projects", () => {
		expect(getWebcamSourceCrop(source, square)).toEqual({
			x: 420,
			y: 0,
			width: 1080,
			height: 1080,
		});
		expect(normalizeWebcamFraming(undefined)).toEqual({ zoom: 1, x: 0.5, y: 0.5 });
	});
	it("zooms inside the window and reaches all edges without exposing empty pixels", () => {
		expect(getWebcamSourceCrop(source, square, { zoom: 2, x: 0, y: 1 })).toEqual({
			x: 0,
			y: 540,
			width: 540,
			height: 540,
		});
		expect(getWebcamSourceCrop(source, square, { zoom: 2, x: 1, y: 0 })).toEqual({
			x: 1380,
			y: 0,
			width: 540,
			height: 540,
		});
	});
	it.each([
		0, 90, 180, 270,
	] as const)("keeps cropped pixels in bounds at rotation %s", (rotation) => {
		for (const mirrored of [false, true])
			for (const x of [0, 0.3, 1])
				for (const y of [0, 0.7, 1]) {
					const crop = getWebcamSourceCrop(
						source,
						{ width: 180, height: 320 },
						{ zoom: 4, x, y },
						rotation,
						mirrored,
					);
					expect(crop.x).toBeGreaterThanOrEqual(0);
					expect(crop.y).toBeGreaterThanOrEqual(0);
					expect(crop.x + crop.width).toBeLessThanOrEqual(source.width);
					expect(crop.y + crop.height).toBeLessThanOrEqual(source.height);
				}
	});
	it("pans in the displayed orientation when mirrored and rotated", () => {
		expect(getWebcamSourceCrop(source, square, { zoom: 2, x: 0, y: 1 }, 90, true)).toEqual({
			x: 0,
			y: 540,
			width: 540,
			height: 540,
		});
		expect(getWebcamSourceCrop(source, square, { zoom: 2, x: 0, y: 1 }, 0, true)).toEqual({
			x: 1380,
			y: 540,
			width: 540,
			height: 540,
		});
	});
	it("normalizes invalid persisted fields without affecting valid ones", () => {
		expect(normalizeWebcamFraming({ zoom: 100, x: -2, y: 0.7 })).toEqual({ zoom: 4, x: 0, y: 0.7 });
		expect(normalizeWebcamFraming({ zoom: NaN, x: Infinity, y: "no" })).toEqual({
			zoom: 1,
			x: 0.5,
			y: 0.5,
		});
	});
	it("rejects invalid runtime settings", () => {
		expect(() => getWebcamSourceCrop(source, square, { zoom: 0, x: 0, y: 0 })).toThrow("invalid");
	});
	it("scales the preview media without changing the destination window", () => {
		const destination = { width: 320, height: 180 };
		const style = getWebcamVideoStyle(source, destination, { zoom: 2, x: 0.5, y: 0.5 });
		expect(style.width).toBe(640);
		expect(style.height).toBe(360);
		expect(style.transform).toContain("translate(0px, 0px)");
		expect(destination).toEqual({ width: 320, height: 180 });
	});
});
