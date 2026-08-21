import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebcamRecordingBridge } from "./webcamRecordingBridge";

describe("WebcamRecordingBridge", () => {
	type SourceFrameCallback = Parameters<HTMLVideoElement["requestVideoFrameCallback"]>[0];

	const drawImage = vi.fn();
	const requestFrame = vi.fn();
	const stopOutputTrack = vi.fn();
	const play = vi.fn(async () => undefined);
	const pause = vi.fn();
	const sourceFrameCallbacks = new Map<number, SourceFrameCallback>();
	let nextSourceFrameCallbackId = 1;
	const requestVideoFrameCallback = vi.fn((callback: SourceFrameCallback) => {
		const callbackId = nextSourceFrameCallbackId++;
		sourceFrameCallbacks.set(callbackId, callback);
		return callbackId;
	});
	const cancelVideoFrameCallback = vi.fn((callbackId: number) => {
		sourceFrameCallbacks.delete(callbackId);
	});
	const outputTrack = {
		requestFrame,
		stop: stopOutputTrack,
	};
	const outputStream = {
		getTracks: () => [outputTrack],
		getVideoTracks: () => [outputTrack],
	};
	const canvas = {
		width: 0,
		height: 0,
		getContext: vi.fn(() => ({
			drawImage,
			fillRect: vi.fn(),
			fillStyle: "",
		})),
		captureStream: vi.fn(() => outputStream),
	};
	const video = {
		autoplay: false,
		muted: false,
		playsInline: false,
		readyState: HTMLMediaElement.HAVE_CURRENT_DATA,
		srcObject: null as MediaStream | null,
		play,
		pause,
		requestVideoFrameCallback: requestVideoFrameCallback as
			| HTMLVideoElement["requestVideoFrameCallback"]
			| undefined,
		cancelVideoFrameCallback: cancelVideoFrameCallback as
			| HTMLVideoElement["cancelVideoFrameCallback"]
			| undefined,
	};
	const sourceTrack = {
		readyState: "live",
		getSettings: () => ({ width: 1280, height: 720 }),
	};
	const sourceStream = {
		getVideoTracks: () => [sourceTrack],
	} as unknown as MediaStream;
	const recoveredSourceStream = {
		getVideoTracks: () => [sourceTrack],
	} as unknown as MediaStream;

	function presentNextSourceFrame() {
		const nextCallback = sourceFrameCallbacks.entries().next().value;
		if (!nextCallback) {
			throw new Error("No source video-frame callback is pending.");
		}
		const [callbackId, callback] = nextCallback;
		sourceFrameCallbacks.delete(callbackId);
		callback(performance.now(), {} as VideoFrameCallbackMetadata);
	}

	beforeEach(() => {
		vi.useFakeTimers();
		nextSourceFrameCallbackId = 1;
		sourceFrameCallbacks.clear();
		video.requestVideoFrameCallback = requestVideoFrameCallback;
		video.cancelVideoFrameCallback = cancelVideoFrameCallback;
		vi.spyOn(document, "createElement").mockImplementation(
			(tagName) =>
				(tagName === "video" ? video : canvas) as unknown as ReturnType<
					typeof document.createElement
				>,
		);
		video.readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
		video.srcObject = null;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it("forwards real source frames immediately and only uses the timer as a watchdog", async () => {
		const bridge = await WebcamRecordingBridge.create(sourceStream, 30);

		expect(canvas.width).toBe(1280);
		expect(canvas.height).toBe(720);
		expect(bridge.stream).toBe(outputStream);
		expect(video.srcObject).toBe(sourceStream);
		expect(requestVideoFrameCallback).toHaveBeenCalledOnce();
		expect(drawImage).not.toHaveBeenCalled();
		expect(requestFrame).not.toHaveBeenCalled();

		presentNextSourceFrame();

		expect(drawImage).toHaveBeenCalledOnce();
		expect(requestFrame).toHaveBeenCalledOnce();
		expect(requestVideoFrameCallback).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(34);
		expect(drawImage).toHaveBeenCalledOnce();
		expect(requestFrame).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(34);
		expect(drawImage).toHaveBeenCalledOnce();
		expect(requestFrame).toHaveBeenCalledTimes(2);

		bridge.destroy();
		expect(cancelVideoFrameCallback).toHaveBeenCalledWith(2);
		expect(stopOutputTrack).toHaveBeenCalledOnce();
	});

	it("keeps the output alive while detached and resumes source-driven frames after recovery", async () => {
		const bridge = await WebcamRecordingBridge.create(sourceStream, 30);
		presentNextSourceFrame();

		bridge.detachSource(sourceStream);
		video.readyState = 0;
		await vi.advanceTimersByTimeAsync(34);

		expect(drawImage).toHaveBeenCalledOnce();
		expect(requestFrame).toHaveBeenCalledTimes(2);
		expect(video.srcObject).toBeNull();
		expect(cancelVideoFrameCallback).toHaveBeenCalledWith(2);

		video.readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
		await bridge.attachSource(recoveredSourceStream);
		expect(video.srcObject).toBe(recoveredSourceStream);
		presentNextSourceFrame();

		expect(drawImage).toHaveBeenCalledTimes(2);
		expect(requestFrame).toHaveBeenCalledTimes(3);

		bridge.destroy();
		expect(stopOutputTrack).toHaveBeenCalledOnce();
	});

	it("falls back to timer-driven drawing when video-frame callbacks are unavailable", async () => {
		video.requestVideoFrameCallback = undefined;
		video.cancelVideoFrameCallback = undefined;
		const bridge = await WebcamRecordingBridge.create(sourceStream, 30);

		await vi.advanceTimersByTimeAsync(34);
		expect(drawImage).toHaveBeenCalledOnce();
		expect(requestFrame).toHaveBeenCalledOnce();

		bridge.detachSource(sourceStream);
		video.readyState = 0;
		await vi.advanceTimersByTimeAsync(34);

		expect(drawImage).toHaveBeenCalledOnce();
		expect(requestFrame).toHaveBeenCalledTimes(2);

		bridge.destroy();
		expect(stopOutputTrack).toHaveBeenCalledOnce();
	});
});
