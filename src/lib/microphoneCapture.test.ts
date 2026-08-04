import { describe, expect, it, vi } from "vitest";
import {
	acquireSelectedMicrophone,
	assertSelectedMicrophoneAvailable,
	isConcreteMicrophoneDeviceId,
} from "./microphoneCapture";

function audioDevice(deviceId: string, label = "Studio Microphone") {
	return { deviceId, groupId: "group-1", kind: "audioinput", label } as MediaDeviceInfo;
}

function mediaDevices(devices: MediaDeviceInfo[], stream?: MediaStream) {
	return {
		enumerateDevices: vi.fn().mockResolvedValue(devices),
		getUserMedia: vi.fn().mockResolvedValue(stream),
	} as unknown as MediaDevices;
}

describe("microphone capture", () => {
	it("requires a concrete device instead of a virtual default endpoint", async () => {
		expect(isConcreteMicrophoneDeviceId("mic-1")).toBe(true);
		expect(isConcreteMicrophoneDeviceId("default")).toBe(false);
		expect(isConcreteMicrophoneDeviceId("communications")).toBe(false);

		await expect(
			assertSelectedMicrophoneAvailable(mediaDevices([]), "default", "Default"),
		).rejects.toThrow("requires a specific input device");
	});

	it("fails when the selected microphone disappeared", async () => {
		await expect(
			assertSelectedMicrophoneAvailable(mediaDevices([audioDevice("mic-2")]), "mic-1", "Studio"),
		).rejects.toThrow('Selected microphone "Studio" is no longer available');
	});

	it("requests and verifies the exact selected microphone", async () => {
		const track = {
			getSettings: () => ({
				deviceId: "mic-1",
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false,
			}),
			stop: vi.fn(),
		} as unknown as MediaStreamTrack;
		const stream = {
			getAudioTracks: () => [track],
			getTracks: () => [track],
		} as unknown as MediaStream;
		const devices = mediaDevices([audioDevice("mic-1")], stream);

		await expect(acquireSelectedMicrophone(devices, "mic-1", "Studio")).resolves.toBe(stream);
		expect(devices.getUserMedia).toHaveBeenCalledWith({
			audio: {
				deviceId: { exact: "mic-1" },
				echoCancellation: { exact: false },
				noiseSuppression: { exact: false },
				autoGainControl: { exact: false },
			},
			video: false,
		});
	});

	it("stops the stream and fails when Chromium opens another microphone", async () => {
		const stop = vi.fn();
		const track = {
			getSettings: () => ({ deviceId: "webcam-mic" }),
			stop,
		} as unknown as MediaStreamTrack;
		const stream = {
			getAudioTracks: () => [track],
			getTracks: () => [track],
		} as unknown as MediaStream;

		await expect(
			acquireSelectedMicrophone(mediaDevices([audioDevice("mic-1")], stream), "mic-1", "Studio"),
		).rejects.toThrow("Microphone device mismatch");
		expect(stop).toHaveBeenCalledOnce();
	});

	it("stops the stream when Chromium keeps voice processing enabled", async () => {
		const stop = vi.fn();
		const track = {
			getSettings: () => ({
				deviceId: "mic-1",
				echoCancellation: false,
				noiseSuppression: true,
				autoGainControl: false,
			}),
			stop,
		} as unknown as MediaStreamTrack;
		const stream = {
			getAudioTracks: () => [track],
			getTracks: () => [track],
		} as unknown as MediaStream;

		await expect(
			acquireSelectedMicrophone(mediaDevices([audioDevice("mic-1")], stream), "mic-1", "Studio"),
		).rejects.toThrow("did not disable noise suppression");
		expect(stop).toHaveBeenCalledOnce();
	});
});
