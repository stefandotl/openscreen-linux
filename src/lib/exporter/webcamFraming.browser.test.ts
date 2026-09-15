import { describe, expect, it } from "vitest";
import { FrameRenderer } from "./frameRenderer";

describe("webcam framing in the GIF frame renderer", () => {
	it.each([
		0, 90, 180, 270,
	] as const)("crops the displayed top-right quadrant with %i degree rotation", async (rotation) => {
		const source = document.createElement("canvas");
		source.width = 200;
		source.height = 200;
		const ctx = source.getContext("2d")!;
		const colors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00"];
		colors.forEach((color, index) => {
			ctx.fillStyle = color;
			ctx.fillRect((index % 2) * 100, Math.floor(index / 2) * 100, 100, 100);
		});
		const screen = new VideoFrame(source, { timestamp: 0 });
		const webcam = new VideoFrame(source, { timestamp: 0 });
		const renderer = new FrameRenderer({
			width: 200,
			height: 200,
			videoWidth: 200,
			videoHeight: 200,
			wallpaper: "#000000",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			webcamSize: { width: 200, height: 200 },
			webcamLayoutPreset: "only-webcam",
			webcamFraming: { zoom: 2, x: 1, y: 0 },
			webcamRotation: rotation,
			webcamMirrored: true,
			platform: "linux",
		});
		try {
			await renderer.initialize();
			await renderer.renderFrame(screen, 0, webcam);
			const output = renderer.getCanvas().getContext("2d")!;
			// Mirroring happens before clockwise rotation: red, green, yellow, blue.
			const expected = [
				[255, 0, 0],
				[0, 255, 0],
				[255, 255, 0],
				[0, 0, 255],
			][rotation / 90];
			for (const [x, y] of [
				[40, 40],
				[160, 40],
				[40, 160],
				[160, 160],
			]) {
				const pixel = output.getImageData(x, y, 1, 1).data;
				expected.forEach((channel, index) => {
					expect(Math.abs(pixel[index] - channel)).toBeLessThan(5);
				});
			}
		} finally {
			renderer.destroy();
			screen.close();
			webcam.close();
		}
	});
});
