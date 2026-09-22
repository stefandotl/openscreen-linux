import { describe, expect, it, vi } from "vitest";
import { createVideoEventHandlers } from "./videoEventHandlers";

function createHandlers(
	allowPlayback: boolean,
	options: {
		currentTime?: number;
		duration?: number;
		isPlaying?: boolean;
		onTerminalTrim?: () => boolean | void;
		trimRegions?: Array<{ id: string; startMs: number; endMs: number }>;
		speedRegions?: Array<{ id: string; startMs: number; endMs: number; speed: number }>;
		previewSpeed?: number;
		onScrubChange?: (scrubbing: boolean) => void;
		onPlaybackError?: (message: string) => void;
	} = {},
) {
	const video = document.createElement("video");
	let paused = false;
	let playbackRate = 1;
	Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
	Object.defineProperty(video, "playbackRate", {
		configurable: true,
		get: () => playbackRate,
		set: (value: number) => {
			playbackRate = value;
		},
	});
	Object.defineProperty(video, "duration", {
		configurable: true,
		value: options.duration ?? 10,
	});
	video.currentTime = options.currentTime ?? 0;
	const pause = vi.spyOn(video, "pause").mockImplementation(() => {
		paused = true;
	});
	const play = vi.spyOn(video, "play").mockImplementation(() => {
		paused = false;
		return Promise.resolve();
	});
	const onTimeUpdate = vi.fn();
	const isScrubbingRef = { current: false };
	const scrubEndTimerRef = { current: null as number | null };
	const onPlayStateChange = vi.fn();
	const isPlayingRef = { current: options.isPlaying ?? false };
	const isSeekingRef = { current: false };
	const handlers = createVideoEventHandlers({
		video,
		isSeekingRef,
		isPlayingRef,
		allowPlaybackRef: { current: allowPlayback },
		currentTimeRef: { current: 0 },
		timeUpdateAnimationRef: { current: null },
		onTimeUpdate,
		onPlayStateChange,
		onTerminalTrim: options.onTerminalTrim,
		onPlaybackError: options.onPlaybackError,
		trimRegionsRef: { current: options.trimRegions ?? [] },
		speedRegionsRef: { current: options.speedRegions ?? [] },
		previewSpeedRef: { current: options.previewSpeed ?? 1 },
		isScrubbingRef,
		scrubEndTimerRef,
		onScrubChange: options.onScrubChange,
	});
	return {
		handlers,
		video,
		pause,
		play,
		onTimeUpdate,
		onPlayStateChange,
		isPlayingRef,
		isScrubbingRef,
		setPaused: (value: boolean) => {
			paused = value;
		},
		isSeekingRef,
	};
}

describe("video seeking playback intent", () => {
	it("ignores a queued pause event after the next source is already playing", () => {
		const { handlers, isPlayingRef, onPlayStateChange, video } = createHandlers(true, {
			isPlaying: true,
		});

		handlers.handlePause();

		expect(video.paused).toBe(false);
		expect(isPlayingRef.current).toBe(true);
		expect(onPlayStateChange).not.toHaveBeenCalled();
	});

	it("does not interrupt a play request that intentionally starts during a seek", () => {
		const { handlers, pause } = createHandlers(true);

		handlers.handleSeeking();

		expect(pause).not.toHaveBeenCalled();
	});

	it("preserves an intentional play request that starts after seeking begins", () => {
		const { handlers, pause } = createHandlers(true);

		handlers.handleSeeking();
		handlers.handlePlay();

		expect(pause).not.toHaveBeenCalled();
	});

	it("does not cancel a play request dispatched before the matching seeked listener", () => {
		const { handlers, pause } = createHandlers(true);

		handlers.handleSeeked();

		expect(pause).not.toHaveBeenCalled();
	});

	it("resumes after the browser pauses during an active user seek", () => {
		const { handlers, play, setPaused } = createHandlers(true, {
			currentTime: 4,
			isPlaying: true,
		});

		handlers.handleSeeking();
		setPaused(true);
		handlers.handlePause();
		handlers.handleSeeked();

		expect(play).toHaveBeenCalledOnce();
	});

	it("keeps an explicitly paused video paused after seeking", () => {
		const { handlers, play, setPaused, video } = createHandlers(false);

		setPaused(true);
		handlers.handleSeeking();
		handlers.handlePause();
		handlers.handleSeeked();

		expect(video.paused).toBe(true);
		expect(play).not.toHaveBeenCalled();
	});

	it("still stops an unsolicited browser play while paused", () => {
		const { handlers, pause } = createHandlers(false);

		handlers.handleSeeking();

		expect(pause).toHaveBeenCalledOnce();
	});

	it("announces a terminal trim before pausing the current scene", () => {
		const onTerminalTrim = vi.fn();
		const { handlers, pause } = createHandlers(true, {
			currentTime: 9,
			duration: 10,
			isPlaying: true,
			onTerminalTrim,
			trimRegions: [{ id: "terminal", startMs: 9000, endMs: 10_000 }],
		});

		handlers.handleSeeked();

		expect(onTerminalTrim).toHaveBeenCalledOnce();
		expect(pause).toHaveBeenCalledOnce();
		expect(onTerminalTrim.mock.invocationCallOrder[0]).toBeLessThan(
			pause.mock.invocationCallOrder[0],
		);
	});

	it("announces a terminal trim reached during normal playback", () => {
		let frameCallback: FrameRequestCallback | null = null;
		const requestFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				frameCallback = callback;
				return 1;
			});
		const onTerminalTrim = vi.fn();
		const { handlers, pause } = createHandlers(true, {
			currentTime: 9,
			duration: 10,
			onTerminalTrim,
			trimRegions: [{ id: "terminal", startMs: 9000, endMs: 10_000 }],
		});

		handlers.handlePlay();
		expect(frameCallback).not.toBeNull();
		(frameCallback as FrameRequestCallback)(0);

		expect(onTerminalTrim).toHaveBeenCalledOnce();
		expect(pause).toHaveBeenCalledOnce();
		expect(onTerminalTrim.mock.invocationCallOrder[0]).toBeLessThan(
			pause.mock.invocationCallOrder[0],
		);
		requestFrame.mockRestore();
	});

	it("keeps the media playing when a terminal trim hands off to a contiguous scene", () => {
		let frameCallback: FrameRequestCallback | null = null;
		const requestFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				frameCallback = callback;
				return 1;
			});
		const onTerminalTrim = vi.fn(() => true);
		const { handlers, pause } = createHandlers(true, {
			currentTime: 9,
			duration: 10,
			onTerminalTrim,
			trimRegions: [{ id: "scene-boundary", startMs: 9000, endMs: 10_000 }],
		});

		handlers.handlePlay();
		(frameCallback as FrameRequestCallback)(0);

		expect(onTerminalTrim).toHaveBeenCalledOnce();
		expect(pause).not.toHaveBeenCalled();
		expect(frameCallback).not.toBeNull();
		requestFrame.mockRestore();
	});

	it("resumes playback when the media pauses during a middle-trim seek", () => {
		let frameCallback: FrameRequestCallback | null = null;
		const requestFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				frameCallback = callback;
				return 1;
			});
		const { handlers, pause, play, setPaused } = createHandlers(true, {
			currentTime: 2,
			duration: 10,
			trimRegions: [{ id: "middle", startMs: 2000, endMs: 4000 }],
		});

		handlers.handlePlay();
		(frameCallback as FrameRequestCallback)(0);
		expect(pause).toHaveBeenCalledOnce();
		setPaused(true);
		handlers.handlePause();
		handlers.handleSeeked();

		expect(play).toHaveBeenCalledOnce();
		requestFrame.mockRestore();
	});

	it("ignores a trim resume interrupted by a scene handoff", async () => {
		let frameCallback: FrameRequestCallback | null = null;
		const requestFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				frameCallback = callback;
				return 1;
			});
		const onPlaybackError = vi.fn();
		const { handlers, play, setPaused } = createHandlers(true, {
			currentTime: 2,
			duration: 10,
			trimRegions: [{ id: "middle", startMs: 2000, endMs: 4000 }],
			onPlaybackError,
		});

		handlers.handlePlay();
		(frameCallback as FrameRequestCallback)(0);
		setPaused(true);
		handlers.handlePause();
		play.mockRejectedValueOnce(
			new DOMException("The play() request was interrupted by a call to pause().", "AbortError"),
		);
		handlers.handleSeeked();
		await Promise.resolve();

		expect(play).toHaveBeenCalledOnce();
		expect(onPlaybackError).not.toHaveBeenCalled();
		requestFrame.mockRestore();
	});

	it("clears playback state when a superseded AbortError leaves the element stopped", async () => {
		const onPlaybackError = vi.fn();
		const { handlers, play, setPaused, isPlayingRef, onPlayStateChange } = createHandlers(true, {
			currentTime: 4,
			isPlaying: true,
			onPlaybackError,
		});

		setPaused(true);
		play.mockRejectedValueOnce(
			new DOMException("The play() request was interrupted by a call to pause().", "AbortError"),
		);
		handlers.handleSeeked();
		await Promise.resolve();

		expect(play).toHaveBeenCalledOnce();
		expect(onPlaybackError).not.toHaveBeenCalled();
		expect(isPlayingRef.current).toBe(false);
		expect(onPlayStateChange).toHaveBeenCalledWith(false);
	});

	it("keeps play intent when a newer seek supersedes the aborted resume", async () => {
		const onPlaybackError = vi.fn();
		const { handlers, play, setPaused, isPlayingRef, onPlayStateChange, isSeekingRef } =
			createHandlers(true, {
				currentTime: 4,
				isPlaying: true,
				onPlaybackError,
			});

		setPaused(true);
		play.mockImplementationOnce(() => {
			// handleSeeked clears isSeekingRef synchronously; a newer seek that starts
			// while play() is still resolving must keep the play intent alive.
			isSeekingRef.current = true;
			return Promise.reject(
				new DOMException("The play() request was interrupted by a call to pause().", "AbortError"),
			);
		});
		handlers.handleSeeked();
		await Promise.resolve();

		expect(play).toHaveBeenCalledOnce();
		expect(onPlaybackError).not.toHaveBeenCalled();
		expect(isPlayingRef.current).toBe(true);
		expect(onPlayStateChange).not.toHaveBeenCalled();
	});

	it("still reports a real failure while resuming after a user seek", async () => {
		const onPlaybackError = vi.fn();
		const { handlers, play, setPaused, isPlayingRef } = createHandlers(true, {
			currentTime: 4,
			isPlaying: true,
			onPlaybackError,
		});

		setPaused(true);
		play.mockRejectedValueOnce(new DOMException("Decoder failed", "NotSupportedError"));
		handlers.handleSeeked();
		await Promise.resolve();

		expect(onPlaybackError).toHaveBeenCalledOnce();
		expect(onPlaybackError.mock.calls[0][0]).toContain("Video playback failed after seeking:");
		expect(isPlayingRef.current).toBe(false);
	});

	it("still reports a real failure while resuming after a trim", async () => {
		let frameCallback: FrameRequestCallback | null = null;
		const requestFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				frameCallback = callback;
				return 1;
			});
		const onPlaybackError = vi.fn();
		const { handlers, play, setPaused } = createHandlers(true, {
			currentTime: 2,
			duration: 10,
			trimRegions: [{ id: "middle", startMs: 2000, endMs: 4000 }],
			onPlaybackError,
		});

		handlers.handlePlay();
		(frameCallback as FrameRequestCallback)(0);
		setPaused(true);
		handlers.handlePause();
		play.mockRejectedValueOnce(new DOMException("Decoder failed", "NotSupportedError"));
		handlers.handleSeeked();
		await Promise.resolve();

		expect(onPlaybackError).toHaveBeenCalledOnce();
		expect(onPlaybackError.mock.calls[0][0]).toContain(
			"Video playback failed after skipping a trim:",
		);
		expect(onPlaybackError.mock.calls[0][0]).toContain("Decoder failed");
		requestFrame.mockRestore();
	});

	it("skips touching and overlapping trims with one media seek", () => {
		let frameCallback: FrameRequestCallback | null = null;
		const requestFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				frameCallback = callback;
				return 1;
			});
		const { handlers, play, setPaused, video } = createHandlers(true, {
			currentTime: 2,
			duration: 10,
			trimRegions: [
				{ id: "overlap", startMs: 4800, endMs: 6000 },
				{ id: "first", startMs: 2000, endMs: 4000 },
				{ id: "touching", startMs: 4000, endMs: 5000 },
			],
		});

		handlers.handlePlay();
		(frameCallback as FrameRequestCallback)(0);

		expect(frameCallback).not.toBeNull();
		expect(video.currentTime).toBe(6);

		setPaused(true);
		handlers.handlePause();
		handlers.handleSeeked();
		expect(play).toHaveBeenCalledOnce();
		requestFrame.mockRestore();
	});

	it("limits React-facing playback updates to 30 fps while keeping the media clock live", () => {
		let frameCallback: FrameRequestCallback | null = null;
		const requestFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				frameCallback = callback;
				return 1;
			});
		const { handlers, onTimeUpdate, video } = createHandlers(true);

		handlers.handlePlay();
		(frameCallback as FrameRequestCallback)(0);
		video.currentTime = 0.01;
		(frameCallback as FrameRequestCallback)(10);
		video.currentTime = 0.034;
		(frameCallback as FrameRequestCallback)(34);

		expect(onTimeUpdate).toHaveBeenCalledTimes(2);
		expect(onTimeUpdate).toHaveBeenLastCalledWith(0.034);
		requestFrame.mockRestore();
	});

	it("scales an active speed region by the preview speed multiplier", () => {
		let frameCallback: FrameRequestCallback | null = null;
		const requestFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				frameCallback = callback;
				return 1;
			});
		const { handlers, video } = createHandlers(true, {
			currentTime: 2,
			speedRegions: [{ id: "fast", startMs: 1000, endMs: 3000, speed: 2 }],
			previewSpeed: 1.5,
		});

		handlers.handlePlay();
		(frameCallback as FrameRequestCallback)(0);

		expect(video.playbackRate).toBe(3);
		requestFrame.mockRestore();
	});

	it("applies the preview speed outside any speed region", () => {
		let frameCallback: FrameRequestCallback | null = null;
		const requestFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				frameCallback = callback;
				return 1;
			});
		const { handlers, video } = createHandlers(true, {
			currentTime: 5,
			speedRegions: [{ id: "fast", startMs: 1000, endMs: 3000, speed: 2 }],
			previewSpeed: 4,
		});

		handlers.handlePlay();
		(frameCallback as FrameRequestCallback)(0);

		expect(video.playbackRate).toBe(4);
		requestFrame.mockRestore();
	});

	it("does not treat an automatic trim jump as user scrubbing", () => {
		let frameCallback: FrameRequestCallback | null = null;
		const requestFrame = vi
			.spyOn(window, "requestAnimationFrame")
			.mockImplementation((callback) => {
				frameCallback = callback;
				return 1;
			});
		const onScrubChange = vi.fn();
		const { handlers, isScrubbingRef } = createHandlers(true, {
			currentTime: 2,
			trimRegions: [{ id: "automatic", startMs: 2000, endMs: 4000 }],
			onScrubChange,
		});

		handlers.handlePlay();
		(frameCallback as FrameRequestCallback)(0);
		handlers.handleSeeking();
		handlers.handleSeeked();

		expect(isScrubbingRef.current).toBe(false);
		expect(onScrubChange).not.toHaveBeenCalled();
		requestFrame.mockRestore();
	});
});
