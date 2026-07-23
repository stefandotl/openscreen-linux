import { describe, expect, it } from "vitest";
import { WebcamRecordingBridge } from "./webcamRecordingBridge";

function wait(milliseconds: number) {
	return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

describe("WebcamRecordingBridge (real browser)", () => {
	it("keeps MediaRecorder alive after the physical source track ends", async () => {
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
			recorder.start(50);
			await wait(200);

			sourceStream.getTracks().forEach((track) => track.stop());
			bridge.detachSource(sourceStream);
			await wait(250);

			expect(recorder.state).toBe("recording");
			const stopped = new Promise<void>((resolve) => {
				recorder.addEventListener("stop", () => resolve(), { once: true });
			});
			recorder.stop();
			await stopped;

			expect(new Blob(chunks).size).toBeGreaterThan(0);
		} finally {
			window.clearInterval(sourcePaintInterval);
			if (recorder.state !== "inactive") {
				recorder.stop();
			}
			sourceStream.getTracks().forEach((track) => track.stop());
			bridge.destroy();
		}
	});
});
