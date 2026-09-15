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

	it("keeps an unavailable saved camera instead of falling back", () => {
		expect(selectPreferredCameraDevice(cameras, "stale-id", "Disconnected Camera")).toBeUndefined();
	});

	it("returns undefined when no camera is available", () => {
		expect(selectPreferredCameraDevice([], "stale-id", "USB Camera")).toBeUndefined();
	});
});

it("selects a default only before a camera has been chosen", () => {
	expect(selectPreferredCameraDevice(cameras, undefined, undefined)).toEqual(cameras[0]);
});
it("recovers a virtual camera after an incomplete enumeration", () => {
	const virtual = { deviceId: "new-virtual-id", label: "OBS Virtual Camera" };
	expect(selectPreferredCameraDevice(cameras, "old-virtual-id", virtual.label)).toBeUndefined();
	expect(
		selectPreferredCameraDevice([...cameras, virtual], "old-virtual-id", virtual.label),
	).toEqual(virtual);
});
