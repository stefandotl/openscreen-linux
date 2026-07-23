import { describe, expect, it } from "vitest";
import { selectPreferredCameraDevice } from "./cameraDeviceSelection";

const cameras = [
	{ deviceId: "current-built-in-id", label: "Built-in Camera" },
	{ deviceId: "current-usb-id", label: "USB Camera" },
];

describe("selectPreferredCameraDevice", () => {
	it("keeps a preferred device whose ID is valid for the current origin", () => {
		expect(selectPreferredCameraDevice(cameras, "current-usb-id", "Built-in Camera")).toEqual(
			cameras[1],
		);
	});

	it("recovers an origin-specific stale ID by matching the persisted device name", () => {
		expect(selectPreferredCameraDevice(cameras, "dev-origin-id", "USB Camera")).toEqual(cameras[1]);
	});

	it("uses the first available camera when no persisted identity is still available", () => {
		expect(selectPreferredCameraDevice(cameras, "stale-id", "Disconnected Camera")).toEqual(
			cameras[0],
		);
	});

	it("returns undefined when no camera is available", () => {
		expect(selectPreferredCameraDevice([], "stale-id", "USB Camera")).toBeUndefined();
	});
});
