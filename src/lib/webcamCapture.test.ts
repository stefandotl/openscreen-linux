import { describe, expect, it } from "vitest";
import {
	createWebcamVideoConstraints,
	isLowResolutionVirtualCamera,
	WEBCAM_IDEAL_HEIGHT,
	WEBCAM_IDEAL_WIDTH,
	WEBCAM_TARGET_FRAME_RATE,
} from "./webcamCapture";

describe("createWebcamVideoConstraints", () => {
	it("requests a high-quality camera mode without rejecting lower-capability cameras", () => {
		expect(createWebcamVideoConstraints("virtual-camera-id")).toEqual({
			deviceId: { exact: "virtual-camera-id" },
			width: { ideal: WEBCAM_IDEAL_WIDTH },
			height: { ideal: WEBCAM_IDEAL_HEIGHT },
			frameRate: { ideal: WEBCAM_TARGET_FRAME_RATE, max: WEBCAM_TARGET_FRAME_RATE },
		});
	});
});

describe("isLowResolutionVirtualCamera", () => {
	it.each([
		"Camera Lab",
		"OBS Virtual Camera",
		"DroidCam Video",
		"v4l2loopback",
	])("rejects a low-resolution %s stream", (deviceName) => {
		expect(isLowResolutionVirtualCamera(deviceName, { width: 640, height: 480 })).toBe(true);
	});

	it.each([
		{ width: 1280, height: 720 },
		{ width: 720, height: 1280 },
		{ width: 1920, height: 1080 },
		{ width: 1080, height: 1920 },
	])("accepts a virtual camera at $width x $height", (dimensions) => {
		expect(isLowResolutionVirtualCamera("Camera Lab", dimensions)).toBe(false);
	});

	it("does not block a physical camera that only supports 640 x 480", () => {
		expect(isLowResolutionVirtualCamera("Built-in Camera", { width: 640, height: 480 })).toBe(
			false,
		);
	});
});
