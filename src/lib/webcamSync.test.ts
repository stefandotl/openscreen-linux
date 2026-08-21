import { describe, expect, it } from "vitest";
import {
	DROIDCAM_WEBCAM_VIDEO_OFFSET_MS,
	getRecommendedWebcamVideoOffsetMs,
	normalizeWebcamVideoOffsetMs,
	WEBCAM_VIDEO_OFFSET_DEFAULT_MS,
	WEBCAM_VIDEO_OFFSET_MAX_MS,
	WEBCAM_VIDEO_OFFSET_MIN_MS,
} from "./webcamSync";

describe("normalizeWebcamVideoOffsetMs", () => {
	it("keeps finite values inside the supported range", () => {
		expect(normalizeWebcamVideoOffsetMs(275)).toBe(275);
		expect(normalizeWebcamVideoOffsetMs(-125.5)).toBe(-125.5);
	});

	it("clamps values to the supported range", () => {
		expect(normalizeWebcamVideoOffsetMs(-5_000)).toBe(WEBCAM_VIDEO_OFFSET_MIN_MS);
		expect(normalizeWebcamVideoOffsetMs(5_000)).toBe(WEBCAM_VIDEO_OFFSET_MAX_MS);
	});

	it("uses the default for invalid values", () => {
		expect(normalizeWebcamVideoOffsetMs(undefined)).toBe(WEBCAM_VIDEO_OFFSET_DEFAULT_MS);
		expect(normalizeWebcamVideoOffsetMs(Number.NaN)).toBe(WEBCAM_VIDEO_OFFSET_DEFAULT_MS);
		expect(normalizeWebcamVideoOffsetMs("200")).toBe(WEBCAM_VIDEO_OFFSET_DEFAULT_MS);
	});
});

describe("getRecommendedWebcamVideoOffsetMs", () => {
	it.each([
		"DroidCam Source 3",
		"droidcam usb",
		"Iriun DroidCam Camera",
	])("recommends the DroidCam compensation for %s", (deviceName) => {
		expect(getRecommendedWebcamVideoOffsetMs(deviceName)).toBe(DROIDCAM_WEBCAM_VIDEO_OFFSET_MS);
	});

	it("recognizes DroidCam's exact generic device name", () => {
		expect(getRecommendedWebcamVideoOffsetMs("Virtual Camera")).toBe(
			DROIDCAM_WEBCAM_VIDEO_OFFSET_MS,
		);
	});

	it.each([
		"Built-in Camera",
		"OBS Virtual Camera",
		"virtual camera",
		"",
		undefined,
	])("does not compensate an unrelated camera name (%s)", (deviceName) => {
		expect(getRecommendedWebcamVideoOffsetMs(deviceName)).toBe(WEBCAM_VIDEO_OFFSET_DEFAULT_MS);
	});
});
