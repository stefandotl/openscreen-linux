import { describe, expect, it } from "vitest";
import {
	formatPreviewSpeedLabel,
	resolvePreviewPlaybackRate,
	stepPreviewSpeed,
} from "./previewSpeed";
import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED, PREVIEW_SPEED_OPTIONS } from "./types";

describe("preview speed ladder", () => {
	it("runs from a quarter speed up to 4x with 1x as the neutral step", () => {
		expect(PREVIEW_SPEED_OPTIONS[0]).toBe(0.25);
		expect(PREVIEW_SPEED_OPTIONS[PREVIEW_SPEED_OPTIONS.length - 1]).toBe(4);
		expect(PREVIEW_SPEED_OPTIONS).toContain(1);
	});

	it("steps to the next faster and slower speed", () => {
		expect(stepPreviewSpeed(1, "faster")).toBe(1.25);
		expect(stepPreviewSpeed(1, "slower")).toBe(0.75);
		expect(stepPreviewSpeed(2, "faster")).toBe(3);
		expect(stepPreviewSpeed(3, "slower")).toBe(2);
	});

	it("clamps at both ends of the ladder", () => {
		expect(stepPreviewSpeed(4, "faster")).toBe(4);
		expect(stepPreviewSpeed(0.25, "slower")).toBe(0.25);
	});

	it("still moves off a speed that is not on the ladder", () => {
		expect(stepPreviewSpeed(1.75, "faster")).toBe(2);
		expect(stepPreviewSpeed(1.75, "slower")).toBe(1.5);
	});

	it("formats the label the same way the editor labels speed regions", () => {
		expect(formatPreviewSpeedLabel(1)).toBe("1×");
		expect(formatPreviewSpeedLabel(0.25)).toBe("0.25×");
		expect(formatPreviewSpeedLabel(1.5)).toBe("1.5×");
	});
});

describe("resolvePreviewPlaybackRate", () => {
	it("multiplies the active speed region by the preview speed", () => {
		expect(resolvePreviewPlaybackRate(2, 1.5)).toBe(3);
		expect(resolvePreviewPlaybackRate(0.5, 2)).toBe(1);
	});

	it("uses the preview speed when no speed region is active", () => {
		expect(resolvePreviewPlaybackRate(null, 4)).toBe(4);
		expect(resolvePreviewPlaybackRate(undefined, 0.5)).toBe(0.5);
	});

	it("stays inside the rate range a decoder can follow", () => {
		expect(resolvePreviewPlaybackRate(5, 4)).toBe(MAX_PLAYBACK_SPEED);
		expect(resolvePreviewPlaybackRate(0.25, 0.25)).toBe(MIN_PLAYBACK_SPEED);
	});

	it("falls back to 1x for invalid input instead of stalling playback", () => {
		expect(resolvePreviewPlaybackRate(null, Number.NaN)).toBe(1);
		expect(resolvePreviewPlaybackRate(0, 0)).toBe(1);
	});
});
