import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebcamRecordingBridge } from "./webcamRecordingBridge";

describe("WebcamRecordingBridge", () => {
	const drawImage = vi.fn();
	const requestFrame = vi.fn();
	const stopOutputTrack = vi.fn();
	const play = vi.fn(async () => undefined);
	const pause = vi.fn();
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
	};
	const sourceTrack = {
		readyState: "live",
		getSettings: () => ({ width: 1280, height: 720 }),
	};
	const sourceStream = {
		getVideoTracks: () => [sourceTrack],
	} as unknown as MediaStream;

	beforeEach(() => {
		vi.useFakeTimers();
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

	it("keeps requesting output frames after the physical source is detached", async () => {
		const bridge = await WebcamRecordingBridge.create(sourceStream, 30);

		expect(canvas.width).toBe(1280);
		expect(canvas.height).toBe(720);
		expect(bridge.stream).toBe(outputStream);
		expect(video.srcObject).toBe(sourceStream);

		await vi.advanceTimersByTimeAsync(34);
		expect(drawImage).toHaveBeenCalledOnce();
		expect(requestFrame).toHaveBeenCalledOnce();

		bridge.detachSource(sourceStream);
		video.readyState = 0;
		await vi.advanceTimersByTimeAsync(34);

		expect(drawImage).toHaveBeenCalledOnce();
		expect(requestFrame).toHaveBeenCalledTimes(2);
		expect(video.srcObject).toBeNull();

		bridge.destroy();
		expect(stopOutputTrack).toHaveBeenCalledOnce();
	});
});
