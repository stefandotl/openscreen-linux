import { describe, expect, it } from "vitest";
import { getWebcamSourceTimestampMs, offsetWebcamTimelineRegions } from "./webcamTiming";

describe("getWebcamSourceTimestampMs", () => {
	it("advances webcam video for a positive offset", () => {
		expect(getWebcamSourceTimestampMs(500, 125, 2)).toBe(625);
	});

	it("clamps adjusted timestamps to the webcam file boundaries", () => {
		expect(getWebcamSourceTimestampMs(50, -100, 1)).toBe(0);
		expect(getWebcamSourceTimestampMs(950, 100, 1)).toBe(1000);
	});

	it("defaults an omitted offset to synchronized playback", () => {
		expect(getWebcamSourceTimestampMs(500, undefined, 2)).toBe(500);
	});

	it("rejects an invalid offset", () => {
		expect(() => getWebcamSourceTimestampMs(500, Number.NaN, 2)).toThrow(
			"Webcam video offset must be a finite number",
		);
	});
});

describe("offsetWebcamTimelineRegions", () => {
	it("shifts trim and speed boundaries onto the webcam source clock", () => {
		expect(
			offsetWebcamTimelineRegions([{ id: "trim", startMs: 2_000, endMs: 4_000 }], 200),
		).toEqual([{ id: "trim", startMs: 2_200, endMs: 4_200 }]);
	});

	it("preserves the existing regions when no offset is configured", () => {
		const regions = [{ id: "trim", startMs: 2_000, endMs: 4_000 }];
		expect(offsetWebcamTimelineRegions(regions, 0)).toBe(regions);
	});
});
