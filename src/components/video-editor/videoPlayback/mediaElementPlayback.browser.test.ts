import { afterEach, describe, expect, it } from "vitest";
import sampleVideoUrl from "../../../../tests/fixtures/sample.webm?url";
import { seekMediaElement } from "./mediaElementPlayback";

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
