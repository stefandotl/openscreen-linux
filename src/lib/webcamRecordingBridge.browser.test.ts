import { describe, expect, it } from "vitest";
import { MAX_WEBCAM_SOURCE_STALL_MS, WebcamRecordingBridge } from "./webcamRecordingBridge";

function wait(milliseconds: number) {
	return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function waitForPresentedFrame(video: HTMLVideoElement, timeoutMs: number) {
	return new Promise<void>((resolve, reject) => {
		const callbackId = video.requestVideoFrameCallback(() => {
			window.clearTimeout(timeoutId);
			resolve();
		});
		const timeoutId = window.setTimeout(() => {
			video.cancelVideoFrameCallback(callbackId);
			reject(new Error(`No video frame was presented within ${timeoutMs} ms.`));
		}, timeoutMs);
	});
}

describe("WebcamRecordingBridge (real browser)", () => {
	it("publishes the current dimensions when an idle source reconnects in portrait", async () => {
		const sources = [
			{ width: 320, height: 180 },
			{ width: 180, height: 320 },
		].map(({ width, height }) => {
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext("2d")!;
			const paint = () => {
				context.fillStyle = "#f00";
				context.fillRect(0, 0, width, height);
				context.fillStyle = "#fff";
				context.fillRect((width - 80) / 2, (height - 80) / 2, 80, 80);
			};
			paint();
			return { stream: canvas.captureStream(20), timer: window.setInterval(paint, 20) };
		});
		const bridge = await WebcamRecordingBridge.create(sources[0].stream, 20);
		const video = document.createElement("video");
		video.muted = true;
		video.srcObject = bridge.stream;
		try {
			await Promise.all([video.play(), waitForPresentedFrame(video, 1500)]);
			bridge.detachSource(sources[0].stream);
			await bridge.attachSource(sources[1].stream);
			await expect
				.poll(async () => {
					await waitForPresentedFrame(video, 1500);
					return [video.videoWidth, video.videoHeight];
				})
				.toEqual([180, 320]);
		} finally {
			video.pause();
			video.srcObject = null;
			bridge.destroy();
			for (const source of sources) {
				window.clearInterval(source.timer);
				source.stream.getTracks().forEach((track) => track.stop());
			}
		}
	});

	it("publishes a source frame without waiting for the watchdog cadence", async () => {
		const sourceCanvas = document.createElement("canvas");
		sourceCanvas.width = 320;
		sourceCanvas.height = 180;
		const sourceContext = sourceCanvas.getContext("2d");
		expect(sourceContext).not.toBeNull();
		const sourceStream = sourceCanvas.captureStream(20);
		const sourcePaintInterval = window.setInterval(() => {
			sourceContext!.fillStyle = `hsl(${Date.now() % 360} 80% 50%)`;
			sourceContext!.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
		}, 20);
		const bridge = await WebcamRecordingBridge.create(sourceStream, 0.2);
		const outputVideo = document.createElement("video");
		outputVideo.autoplay = true;
		outputVideo.muted = true;
		outputVideo.playsInline = true;
		outputVideo.srcObject = bridge.stream;

		try {
			const startedAt = performance.now();
			await Promise.all([outputVideo.play(), waitForPresentedFrame(outputVideo, 1500)]);

			expect(performance.now() - startedAt).toBeLessThan(1500);
		} finally {
			window.clearInterval(sourcePaintInterval);
			outputVideo.pause();
			outputVideo.srcObject = null;
			sourceStream.getTracks().forEach((track) => track.stop());
			bridge.destroy();
		}
	});

	it("reports a source freeze while the stable output track remains alive", async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 160;
		canvas.height = 90;
		const context = canvas.getContext("2d")!;
		const source = canvas.captureStream(30);
		const timer = window.setInterval(() => {
			context.fillStyle = `hsl(${Date.now() % 360} 80% 50%)`;
			context.fillRect(0, 0, canvas.width, canvas.height);
		}, 33);
		let lagMs = 0;
		const bridge = await WebcamRecordingBridge.create(source, 30, {
			onSourceLag: (lag) => {
				lagMs = lag;
			},
		});
		try {
			bridge.prepareForRecording();
			await wait(150);
			window.clearInterval(timer);
			await wait(1500);
			expect(lagMs).toBe(0);
			await expect
				.poll(() => lagMs, { timeout: MAX_WEBCAM_SOURCE_STALL_MS + 2000 })
				.toBeGreaterThan(MAX_WEBCAM_SOURCE_STALL_MS);
			expect(bridge.stream.getVideoTracks()[0].readyState).toBe("live");
		} finally {
			window.clearInterval(timer);
			source.getTracks().forEach((track) => track.stop());
			bridge.destroy();
		}
	});

	it("keeps MediaRecorder alive while the physical source is replaced", async () => {
		const sourceCanvas = document.createElement("canvas");
		sourceCanvas.width = 320;
		sourceCanvas.height = 180;
		const sourceContext = sourceCanvas.getContext("2d");
		expect(sourceContext).not.toBeNull();
		sourceContext!.fillStyle = "#d946ef";
		sourceContext!.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);

		const sourceStream = sourceCanvas.captureStream(20);
		const sourcePaintInterval = window.setInterval(() => {
			sourceContext!.fillStyle = `hsl(${Date.now() % 360} 80% 50%)`;
			sourceContext!.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
		}, 20);
		const recoveredCanvas = document.createElement("canvas");
		recoveredCanvas.width = 320;
		recoveredCanvas.height = 180;
		const recoveredContext = recoveredCanvas.getContext("2d");
		expect(recoveredContext).not.toBeNull();
		recoveredContext!.fillStyle = "#22c55e";
		recoveredContext!.fillRect(0, 0, recoveredCanvas.width, recoveredCanvas.height);
		const recoveredStream = recoveredCanvas.captureStream(20);
		const recoveredPaintInterval = window.setInterval(() => {
			recoveredContext!.fillStyle = `hsl(${(Date.now() + 120) % 360} 80% 50%)`;
			recoveredContext!.fillRect(0, 0, recoveredCanvas.width, recoveredCanvas.height);
		}, 20);
		const bridge = await WebcamRecordingBridge.create(sourceStream, 20);
		const chunks: Blob[] = [];
		const recorder = new MediaRecorder(bridge.stream, {
			mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
				? "video/webm;codecs=vp8"
				: "video/webm",
		});
		recorder.addEventListener("dataavailable", (event) => {
			if (event.data.size > 0) {
				chunks.push(event.data);
			}
		});

		try {
			bridge.prepareForRecording();
			recorder.start(50);
			await wait(200);

			sourceStream.getTracks().forEach((track) => track.stop());
			bridge.detachSource(sourceStream);
			await wait(1300);
			await bridge.attachSource(recoveredStream);
			await wait(125);

			expect(recorder.state).toBe("recording");
			const stopped = new Promise<void>((resolve) => {
				recorder.addEventListener("stop", () => resolve(), { once: true });
			});
			recorder.stop();
			await stopped;

			expect(new Blob(chunks).size).toBeGreaterThan(0);
		} finally {
			window.clearInterval(sourcePaintInterval);
			window.clearInterval(recoveredPaintInterval);
			if (recorder.state !== "inactive") {
				recorder.stop();
			}
			sourceStream.getTracks().forEach((track) => track.stop());
			recoveredStream.getTracks().forEach((track) => track.stop());
			bridge.destroy();
		}
	});
});
