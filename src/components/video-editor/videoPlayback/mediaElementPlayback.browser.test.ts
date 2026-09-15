import { afterEach, describe, expect, it } from "vitest";
import sampleVideoUrl from "../../../../tests/fixtures/sample.webm?url";
import { seekMediaElement } from "./mediaElementPlayback";
import { synchronizeMediaFollowerPlayback } from "./mediaElementSync";
import { createVideoEventHandlers } from "./videoEventHandlers";

const mountedVideos: HTMLVideoElement[] = [];

async function loadSampleVideo() {
	const video = document.createElement("video");
	video.src = sampleVideoUrl;
	video.preload = "auto";
	video.muted = true;
	video.playsInline = true;
	document.body.append(video);
	mountedVideos.push(video);
	await new Promise<void>((resolve, reject) => {
		video.addEventListener("loadeddata", () => resolve(), { once: true });
		video.addEventListener("error", () => reject(new Error("Sample video failed to load")), {
			once: true,
		});
		video.load();
	});
	return video;
}

afterEach(() => {
	for (const video of mountedVideos.splice(0)) {
		video.pause();
		video.remove();
	}
});

describe("project playback media handoff", () => {
	it("finishes the scene seek before starting playback", async () => {
		const video = await loadSampleVideo();
		const targetTime = Math.min(video.duration / 2, 0.1);

		await seekMediaElement(video, targetTime);
		expect(video.seeking).toBe(false);
		expect(video.currentTime).toBeCloseTo(targetTime, 2);

		await expect(video.play()).resolves.toBeUndefined();
		expect(video.paused).toBe(false);
	});
});

describe("trimmed playback", () => {
	it("realigns webcam playback after repeated primary trim seeks", async () => {
		const primary = await loadSampleVideo();
		const webcam = await loadSampleVideo();
		const sync = () =>
			synchronizeMediaFollowerPlayback(primary, webcam, 0, { playing: true, scrubbing: false });
		let frame: number | null = null;
		let seekingEvents = 0;
		const syncSeeking = () => {
			seekingEvents++;
			sync();
			expect(webcam.paused).toBe(true);
		};
		const tick = () => {
			sync();
			frame = requestAnimationFrame(tick);
		};
		primary.addEventListener("seeking", syncSeeking);
		primary.addEventListener("seeked", sync);
		webcam.addEventListener("seeked", sync);
		try {
			await primary.play();
			tick();
			for (const fraction of [0.2, 0.4, 0.6]) {
				await seekMediaElement(primary, primary.duration * fraction);
				await expect
					.poll(
						() =>
							!webcam.paused &&
							!webcam.seeking &&
							Math.abs(webcam.currentTime - primary.currentTime) < 0.075,
						{ timeout: 3000 },
					)
					.toBe(true);
			}
			expect(seekingEvents).toBe(3);
		} finally {
			primary.removeEventListener("seeking", syncSeeking);
			primary.removeEventListener("seeked", sync);
			webcam.removeEventListener("seeked", sync);
			if (frame !== null) cancelAnimationFrame(frame);
		}
	});

	it("continues playing after skipping a trim in the middle of the video", async () => {
		const video = await loadSampleVideo();
		const trimStartSeconds = video.duration * 0.2;
		const trimEndSeconds = video.duration * 0.4;
		let animationFrame: number | null = null;
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: { current: false },
			isPlayingRef: { current: false },
			allowPlaybackRef: { current: true },
			currentTimeRef: { current: 0 },
			timeUpdateAnimationRef: {
				get current() {
					return animationFrame;
				},
				set current(value) {
					animationFrame = value;
				},
			},
			onPlayStateChange: () => undefined,
			onTimeUpdate: () => undefined,
			trimRegionsRef: {
				current: [
					{
						id: "middle-trim",
						startMs: trimStartSeconds * 1000,
						endMs: trimEndSeconds * 1000,
					},
				],
			},
			speedRegionsRef: { current: [] },
		});

		video.addEventListener("play", handlers.handlePlay);
		video.addEventListener("pause", handlers.handlePause);
		video.addEventListener("seeked", handlers.handleSeeked);
		video.addEventListener("seeking", handlers.handleSeeking);
		await video.play();

		await new Promise<void>((resolve, reject) => {
			const timeout = window.setTimeout(
				() => reject(new Error("Playback did not continue beyond the middle trim")),
				5000,
			);
			const checkPlayback = () => {
				if (video.currentTime > trimEndSeconds + 0.05) {
					window.clearTimeout(timeout);
					resolve();
					return;
				}
				if (video.paused) {
					window.clearTimeout(timeout);
					reject(new Error(`Playback paused at ${video.currentTime.toFixed(3)}s`));
					return;
				}
				requestAnimationFrame(checkPlayback);
			};
			requestAnimationFrame(checkPlayback);
		});

		expect(video.paused).toBe(false);
		expect(video.currentTime).toBeGreaterThan(trimEndSeconds);

		video.removeEventListener("play", handlers.handlePlay);
		video.removeEventListener("pause", handlers.handlePause);
		video.removeEventListener("seeked", handlers.handleSeeked);
		video.removeEventListener("seeking", handlers.handleSeeking);
		if (animationFrame !== null) cancelAnimationFrame(animationFrame);
	});
});
