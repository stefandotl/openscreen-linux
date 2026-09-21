import { describe, expect, it } from "vitest";
import {
	DROIDCAM_WEBCAM_VIDEO_OFFSET_MS,
	getRecommendedWebcamVideoOffsetMs,
	inspectWebcamSyncDurations,
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

describe("inspectWebcamSyncDurations", () => {
	it("treats matching lengths as a constant offset", () => {
		const report = inspectWebcamSyncDurations(278.4, 278.55);

		expect(report?.skewed).toBe(false);
		expect(report?.deltaMs).toBeCloseTo(150, 1);
		expect(report?.webcamTimeScale).toBeCloseTo(1.0005, 4);
	});

	it("flags a sidecar that gained timeline while the camera stalled", () => {
		const report = inspectWebcamSyncDurations(278.4, 280.2);

		expect(report?.skewed).toBe(true);
		expect(report?.deltaMs).toBeCloseTo(1800, 1);
		expect(report?.webcamTimeScale).toBeGreaterThan(1);
	});

	it("flags a shortened sidecar and keeps the scale below one", () => {
		const report = inspectWebcamSyncDurations(60, 58.5);

		expect(report?.skewed).toBe(true);
		expect(report?.webcamTimeScale).toBeLessThan(1);
	});

	it("scales the tolerance with the recording length", () => {
		// 0.5 s is inside the 0.3 % band of a 20 minute recording and outside it for a short one.
		expect(inspectWebcamSyncDurations(1_200, 1_200.5)?.skewed).toBe(false);
		expect(inspectWebcamSyncDurations(60, 60.5)?.skewed).toBe(true);
	});

	it("ignores durations that are missing or not usable", () => {
		expect(inspectWebcamSyncDurations(undefined, 10)).toBeNull();
		expect(inspectWebcamSyncDurations(10, 0)).toBeNull();
		expect(inspectWebcamSyncDurations(Number.NaN, 10)).toBeNull();
		expect(inspectWebcamSyncDurations(Infinity, 10)).toBeNull();
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
