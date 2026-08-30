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
	} = {},
) {
	const video = document.createElement("video");
	let paused = false;
	Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
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
	const handlers = createVideoEventHandlers({
		video,
		isSeekingRef: { current: false },
		isPlayingRef: { current: options.isPlaying ?? false },
		allowPlaybackRef: { current: allowPlayback },
		currentTimeRef: { current: 0 },
		timeUpdateAnimationRef: { current: null },
		onPlayStateChange: vi.fn(),
		onTimeUpdate: vi.fn(),
		onTerminalTrim: options.onTerminalTrim,
		trimRegionsRef: { current: options.trimRegions ?? [] },
		speedRegionsRef: { current: [] },
	});
	return {
		handlers,
		video,
		pause,
		play,
		setPaused: (value: boolean) => {
			paused = value;
		},
	};
}

describe("video seeking playback intent", () => {
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
		const { handlers, play, setPaused } = createHandlers(true, {
			currentTime: 2,
			duration: 10,
			trimRegions: [{ id: "middle", startMs: 2000, endMs: 4000 }],
		});

		handlers.handlePlay();
		(frameCallback as FrameRequestCallback)(0);
		setPaused(true);
		handlers.handlePause();
		handlers.handleSeeked();

		expect(play).toHaveBeenCalledOnce();
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
});
