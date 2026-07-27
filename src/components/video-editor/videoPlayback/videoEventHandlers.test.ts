import { describe, expect, it, vi } from "vitest";
import { createVideoEventHandlers } from "./videoEventHandlers";

function createHandlers(
	allowPlayback: boolean,
	options: {
		currentTime?: number;
		duration?: number;
		isPlaying?: boolean;
		onTerminalTrim?: () => void;
		trimRegions?: Array<{ id: string; startMs: number; endMs: number }>;
	} = {},
) {
	const video = document.createElement("video");
	Object.defineProperty(video, "paused", { configurable: true, value: false });
	Object.defineProperty(video, "duration", {
		configurable: true,
		value: options.duration ?? 10,
	});
	video.currentTime = options.currentTime ?? 0;
	const pause = vi.spyOn(video, "pause").mockImplementation(() => undefined);
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
	return { handlers, pause };
}

describe("video seeking playback intent", () => {
	it("does not interrupt a play request that intentionally starts during a seek", () => {
		const { handlers, pause } = createHandlers(true);

		handlers.handleSeeking();

		expect(pause).not.toHaveBeenCalled();
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
});
