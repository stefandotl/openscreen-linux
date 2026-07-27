import { describe, expect, it, vi } from "vitest";
import { seekMediaElement } from "./mediaElementPlayback";

function createVideo(currentTime = 0) {
	const video = document.createElement("video");
	Object.defineProperty(video, "duration", { configurable: true, value: 10 });
	video.currentTime = currentTime;
	return video;
}

describe("seekMediaElement", () => {
	it("resolves immediately when the media is already at the target", async () => {
		const video = createVideo(2);

		await expect(seekMediaElement(video, 2)).resolves.toBeUndefined();
	});

	it("waits for seeked before resolving an asynchronous browser seek", async () => {
		const video = createVideo(1);
		let seeking = false;
		Object.defineProperty(video, "seeking", {
			configurable: true,
			get: () => seeking,
		});
		seeking = true;

		let resolved = false;
		const result = seekMediaElement(video, 4).then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);

		seeking = false;
		video.dispatchEvent(new Event("seeked"));
		await result;
		expect(video.currentTime).toBe(4);
	});

	it("rejects a stalled seek with a precise timeout", async () => {
		vi.useFakeTimers();
		const video = createVideo(1);
		Object.defineProperty(video, "seeking", { configurable: true, value: true });

		const result = seekMediaElement(video, 5);
		const rejection = expect(result).rejects.toThrow("Timed out while seeking video to 5.000s");
		await vi.advanceTimersByTimeAsync(10_000);
		await rejection;
		vi.useRealTimers();
	});
});
