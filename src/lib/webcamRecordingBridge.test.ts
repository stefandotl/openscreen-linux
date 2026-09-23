import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MAX_WEBCAM_SOURCE_LAG_MS,
	MAX_WEBCAM_SOURCE_STALL_MS,
	WEBCAM_LAG_CONFIRMATION_MS,
	WebcamRecordingBridge,
} from "./webcamRecordingBridge";

describe("WebcamRecordingBridge", () => {
	type SourceFrameCallback = Parameters<HTMLVideoElement["requestVideoFrameCallback"]>[0];

	const drawImage = vi.fn();
	const fillRect = vi.fn();
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
			fillRect,
			fillStyle: "",
		})),
		captureStream: vi.fn(() => outputStream),
	};
	const video = {
		autoplay: false,
		muted: false,
		playsInline: false,
		readyState: HTMLMediaElement.HAVE_CURRENT_DATA,
		videoWidth: 1280,
		videoHeight: 720,
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

	function presentNextSourceFrame(
		metadata: Partial<VideoFrameCallbackMetadata> = {},
		nowMs = performance.now(),
	) {
		const nextCallback = sourceFrameCallbacks.entries().next().value;
		if (!nextCallback) {
			throw new Error("No source video-frame callback is pending.");
		}
		const [callbackId, callback] = nextCallback;
		sourceFrameCallbacks.delete(callbackId);
		callback(nowMs, metadata as VideoFrameCallbackMetadata);
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
		video.videoWidth = 1280;
		video.videoHeight = 720;
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

	it("uses the playable image dimensions when track settings still describe landscape", async () => {
		video.videoWidth = 720;
		video.videoHeight = 1280;
		const bridge = await WebcamRecordingBridge.create(sourceStream, 30);
		try {
			presentNextSourceFrame();
			expect(canvas.width).toBe(720);
			expect(canvas.height).toBe(1280);
			expect(drawImage).toHaveBeenLastCalledWith(video, 0, 0, 720, 1280);
		} finally {
			bridge.destroy();
		}
	});

	it.each([false, true])("adapts to an idle format change (reconnect: %s)", async (reconnect) => {
		const bridge = await WebcamRecordingBridge.create(sourceStream, 30);
		try {
			presentNextSourceFrame();
			video.videoWidth = 720;
			video.videoHeight = 1280;
			if (reconnect) {
				bridge.detachSource(sourceStream);
				await bridge.attachSource(recoveredSourceStream);
			}
			presentNextSourceFrame();
			expect(canvas.width).toBe(720);
			expect(canvas.height).toBe(1280);
			expect(drawImage).toHaveBeenLastCalledWith(video, 0, 0, 720, 1280);
			expect(bridge.stream).toBe(outputStream);
			video.videoWidth = 640;
			video.videoHeight = 360;
			presentNextSourceFrame();
			expect(canvas.width).toBe(640);
			expect(canvas.height).toBe(360);
			expect(drawImage).toHaveBeenLastCalledWith(video, 0, 0, 640, 360);
		} finally {
			bridge.destroy();
		}
	});

	it("stops drawing and reports a format change while recording dimensions are locked", async () => {
		const onLockedFormatChange = vi.fn();
		const bridge = await WebcamRecordingBridge.create(sourceStream, 30, {
			onLockedFormatChange,
		});
		try {
			expect(bridge.prepareForRecording()).toEqual({ width: 1280, height: 720 });
			presentNextSourceFrame();
			expect(drawImage).toHaveBeenCalledOnce();

			video.videoWidth = 720;
			video.videoHeight = 1280;
			presentNextSourceFrame();
			presentNextSourceFrame();

			expect(canvas.width).toBe(1280);
			expect(canvas.height).toBe(720);
			expect(drawImage).toHaveBeenCalledOnce();
			expect(onLockedFormatChange).toHaveBeenCalledOnce();
			expect(onLockedFormatChange).toHaveBeenCalledWith({
				previous: { width: 1280, height: 720 },
				current: { width: 720, height: 1280 },
			});

			bridge.finishRecording();
			presentNextSourceFrame();
			expect(canvas.width).toBe(720);
			expect(canvas.height).toBe(1280);
			expect(drawImage).toHaveBeenCalledTimes(2);
		} finally {
			bridge.destroy();
		}
	});

	it("reports a source that falls behind the recording timeline", async () => {
		const onSourceLag = vi.fn();
		const bridge = await WebcamRecordingBridge.create(sourceStream, 30, { onSourceLag });
		try {
			bridge.prepareForRecording();
			// A constant device latency cancels out of the measurement.
			presentNextSourceFrame({ mediaTime: 5 }, 10_000);
			presentNextSourceFrame({ mediaTime: 6 }, 11_000);
			expect(onSourceLag).not.toHaveBeenCalled();

			// Jitter below the tolerance must stay silent.
			presentNextSourceFrame({ mediaTime: 6.1 }, 11_200);
			expect(onSourceLag).not.toHaveBeenCalled();

			// Half a second of content never reached the recorder from here on.
			presentNextSourceFrame({ mediaTime: 6.5 }, 12_000);
			expect(onSourceLag).not.toHaveBeenCalled();
			presentNextSourceFrame({ mediaTime: 9.5 }, 12_000 + WEBCAM_LAG_CONFIRMATION_MS);

			expect(onSourceLag).toHaveBeenCalledOnce();
			const [reportedLagMs] = onSourceLag.mock.calls[0] as [number];
			expect(reportedLagMs).toBe(500);
			expect(reportedLagMs).toBeGreaterThan(MAX_WEBCAM_SOURCE_LAG_MS);

			// The recorder must not be flooded while the source keeps stalling.
			presentNextSourceFrame({ mediaTime: 6.5 }, 14_000);
			expect(onSourceLag).toHaveBeenCalledOnce();
		} finally {
			bridge.destroy();
		}
	});

	it("allows delayed callbacks and a short source freeze to recover", async () => {
		const onSourceLag = vi.fn();
		const bridge = await WebcamRecordingBridge.create(sourceStream, 30, { onSourceLag });
		try {
			bridge.prepareForRecording();
			presentNextSourceFrame({ mediaTime: 0 }, 0);
			await vi.advanceTimersByTimeAsync(1500);
			expect(onSourceLag).not.toHaveBeenCalled();
			presentNextSourceFrame({ mediaTime: 0.5 }, 1500);
			presentNextSourceFrame({ mediaTime: 1.55 }, 1600);
			presentNextSourceFrame({ mediaTime: 4.55 }, 4600);
			expect(onSourceLag).not.toHaveBeenCalled();
		} finally {
			bridge.destroy();
		}
	});

	it("reports a frozen source even when no further frame callback arrives", async () => {
		const onSourceLag = vi.fn();
		const bridge = await WebcamRecordingBridge.create(sourceStream, 30, { onSourceLag });
		try {
			bridge.prepareForRecording();
			presentNextSourceFrame({ mediaTime: 0 });
			await vi.advanceTimersByTimeAsync(500);
			expect(onSourceLag).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(MAX_WEBCAM_SOURCE_STALL_MS);
			expect(onSourceLag).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(MAX_WEBCAM_SOURCE_STALL_MS);
			expect(onSourceLag).toHaveBeenCalledOnce();
		} finally {
			bridge.destroy();
		}
	});

	it("does not report recording lag while the camera is idle or after finishing", async () => {
		const onSourceLag = vi.fn();
		const bridge = await WebcamRecordingBridge.create(sourceStream, 30, { onSourceLag });
		try {
			presentNextSourceFrame({ mediaTime: 0 }, 0);
			presentNextSourceFrame({ mediaTime: 0 }, 5000);
			await vi.advanceTimersByTimeAsync(2000);
			bridge.prepareForRecording();
			bridge.finishRecording();
			presentNextSourceFrame({ mediaTime: 0 }, 10000);
			await vi.advanceTimersByTimeAsync(2000);
			expect(onSourceLag).not.toHaveBeenCalled();
		} finally {
			bridge.destroy();
		}
	});

	it("tracks source lag from the start of each recording", async () => {
		const onSourceLag = vi.fn();
		const bridge = await WebcamRecordingBridge.create(sourceStream, 30, { onSourceLag });
		try {
			bridge.prepareForRecording();
			presentNextSourceFrame({ mediaTime: 0 }, 1_000);
			presentNextSourceFrame({ mediaTime: 0.5 }, 2_000);
			presentNextSourceFrame({ mediaTime: 3.5 }, 5_000);
			expect(onSourceLag).toHaveBeenCalledWith(500);

			// A new take that starts from a stalled camera reports the lag again.
			bridge.finishRecording();
			bridge.prepareForRecording();
			presentNextSourceFrame({ mediaTime: 0.5 }, 6_000);
			presentNextSourceFrame({ mediaTime: 0.5 }, 7_000);
			presentNextSourceFrame({ mediaTime: 3.5 }, 10_000);
			expect(onSourceLag).toHaveBeenCalledTimes(2);
			expect(onSourceLag).toHaveBeenLastCalledWith(1000);
		} finally {
			bridge.destroy();
		}
	});

	it("rejects an initial source without playable dimensions and releases the output", async () => {
		video.videoWidth = 0;
		video.videoHeight = 0;
		await expect(WebcamRecordingBridge.create(sourceStream, 30)).rejects.toThrow(
			"Webcam source did not provide valid video dimensions",
		);
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
