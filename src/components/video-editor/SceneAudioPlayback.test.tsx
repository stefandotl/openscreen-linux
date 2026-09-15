import { act, cleanup, render } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioRegion } from "./audioRegions";
import { SceneAudioPlayback } from "./SceneAudioPlayback";
import type { VideoPlaybackRef } from "./VideoPlayback";

const clip: AudioRegion = {
	id: "music",
	name: "music.wav",
	sourcePath: "/tmp/music.wav",
	startMs: 1000,
	endMs: 4000,
	sourceStartMs: 500,
	sourceDurationMs: 5000,
	volume: 0.8,
	fadeInMs: 1000,
	fadeOutMs: 0,
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("scene audio playback", () => {
	it("syncs seek, rate, fades and pause, updates gain without reloading, and releases media", async () => {
		const players: FakeAudio[] = [];
		class FakeAudio {
			paused = true;
			readyState = 4;
			currentTime = 0;
			volume = 1;
			playbackRate = 1;
			preload = "";
			onerror: (() => void) | null = null;
			constructor(_src: string) {
				players.push(this);
			}
			play = vi.fn(async () => {
				this.paused = false;
			});
			pause = vi.fn(() => {
				this.paused = true;
			});
			removeAttribute = vi.fn();
			load = vi.fn();
		}
		let tick: FrameRequestCallback = () => undefined;
		vi.stubGlobal("Audio", FakeAudio);
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			tick = callback;
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
		const video = {
			currentTime: 1.5,
			playbackRate: 1,
			readyState: 4,
			paused: false,
			seeking: false,
		};
		const videoRef = {
			current: { video, pause: vi.fn() },
		} as unknown as RefObject<VideoPlaybackRef>;
		const onError = vi.fn();
		const { rerender, unmount } = render(
			<SceneAudioPlayback clips={[clip]} enabled videoRef={videoRef} onError={onError} />,
		);
		await act(async () => undefined);
		expect(players).toHaveLength(1);
		expect(players[0].currentTime).toBe(1);
		expect(players[0].volume).toBe(0.4);
		expect(players[0].paused).toBe(false);
		rerender(
			<SceneAudioPlayback
				clips={[{ ...clip, volume: 0.4 }]}
				enabled
				videoRef={videoRef}
				onError={onError}
			/>,
		);
		act(() => tick(16));
		expect(players).toHaveLength(1);
		expect(players[0].volume).toBe(0.2);
		video.currentTime = 3;
		video.playbackRate = 2;
		act(() => tick(32));
		expect(players[0].currentTime).toBe(2.5);
		expect(players[0].playbackRate).toBe(2);
		video.paused = true;
		act(() => tick(48));
		expect(players[0].paused).toBe(true);
		unmount();
		expect(players[0].removeAttribute).toHaveBeenCalledWith("src");
		expect(players[0].load).toHaveBeenCalledOnce();
		expect(onError).not.toHaveBeenCalled();
	});
});
