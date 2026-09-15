import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

// VIDETIO_E2E_NATIVE_SYNC=1 npm run test:e2e -- tests/e2e/native-webcam-framing.spec.ts
// Compare the actual CSS preview, Canvas composition and CUDA/NVENC output.
test("exports fixed webcam framing consistently with preview, rotation and masks", async () => {
	test.skip(process.env.VIDETIO_E2E_NATIVE_SYNC !== "1", "Requires a working NVIDIA desktop");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-webcam-framing-"));
	const launchEnv: NodeJS.ProcessEnv = {
		...process.env,
		ELECTRON_USER_DATA_DIR: directory,
		HEADLESS: "true",
	};
	delete launchEnv.ELECTRON_RUN_AS_NODE;
	const app = await electron.launch({
		args: [path.resolve("dist-electron/main.js"), "--no-sandbox", `--user-data-dir=${directory}`],
		env: launchEnv,
	});
	try {
		const userData = await app.evaluate(({ app }) => app.getPath("userData"));
		const recordings = path.join(userData, "recordings");
		fs.mkdirSync(recordings, { recursive: true });
		const screenPath = path.join(recordings, "screen.mp4");
		const webcamPath = path.join(recordings, "webcam.mp4");
		const ffmpeg = process.env.VIDETIO_FFMPEG_PATH ?? "/usr/bin/ffmpeg";
		const sourcePixels = Buffer.alloc(320 * 180 * 3);
		const colors = [
			[190, 45, 45],
			[45, 190, 45],
			[45, 45, 190],
			[190, 190, 45],
		];
		for (let y = 0; y < 180; y++)
			for (let x = 0; x < 320; x++) {
				const color = colors[(y >= 90 ? 2 : 0) + (x >= 160 ? 1 : 0)];
				for (let c = 0; c < 3; c++) sourcePixels[(y * 320 + x) * 3 + c] = color[c];
			}
		for (const [file, pixels] of [
			[webcamPath, sourcePixels],
			[screenPath, Buffer.alloc(sourcePixels.length)],
		] as const) {
			execFileSync(
				ffmpeg,
				[
					"-v",
					"error",
					"-y",
					"-f",
					"rawvideo",
					"-pixel_format",
					"rgb24",
					"-video_size",
					"320x180",
					"-framerate",
					"30",
					"-i",
					"pipe:0",
					"-vf",
					"loop=loop=14:size=1:start=0,scale=out_color_matrix=bt709",
					"-frames:v",
					"15",
					"-c:v",
					"libx264",
					"-pix_fmt",
					"yuv420p",
					"-colorspace",
					"bt709",
					"-color_primaries",
					"bt709",
					"-color_trc",
					"bt709",
					file,
				],
				{ input: pixels },
			);
		}
		const bundle = await build({
			stdin: {
				resolveDir: process.cwd(),
				loader: "ts",
				contents: `
			import { createNativeGpuExportPlan, createNativeGpuExportAssets } from "./src/lib/exporter/nativeGpuExportPlan";
			import { getWebcamVideoStyle } from "./src/lib/webcamFraming";
			import { drawWebcamFrameImage } from "./src/lib/exporter/webcamFrameDrawing";
			export async function run(screenPath, webcamPath, outputPath, variant) {
				const config = {
					videoUrl: screenPath, webcamVideoUrl: webcamPath, width: 320, height: 180, frameRate: 30, bitrate: 4000000,
					wallpaper: "#000000", zoomRegions: [], trimRegions: [], speedRegions: [], annotationRegions: [],
					showShadow: false, shadowIntensity: 0, showBlur: false, motionBlurAmount: 0,
					borderRadius: 0, padding: 0, cropRegion: { x: 0, y: 0, width: 1, height: 1 },
					webcamPosition: { cx: 0.5, cy: 0.5 }, webcamSizePreset: 50, webcamReactiveZoom: false, ...variant,
				};
				const info = { width: 320, height: 180, duration: 0.5 };
				const plan = createNativeGpuExportPlan(config, info, info);
				const webcam = plan.webcam;
				const assets = await createNativeGpuExportAssets(config);
				const request = { plan, outputPath, sourceDurationSec: 0.5, trimRegions: [], speedRegions: [], wallpaperPng: assets.wallpaperPng, overlayPngs: assets.overlayPngs };
				const invalid = await window.electronAPI.startNativeGpuExport({ ...request, plan: { ...plan, webcam: { ...webcam, sourceCrop: { ...webcam.sourceCrop, x: -1 } } } });
				if (invalid.success || !invalid.error?.includes("webcam crop")) throw new Error("Invalid webcam crop was not rejected: " + JSON.stringify(invalid));
				const started = await window.electronAPI.startNativeGpuExport(request);
				if (!started.success) throw new Error(JSON.stringify(started));
				const finished = await window.electronAPI.finishNativeGpuExport(started.sessionId);
				if (!finished.success) throw new Error(JSON.stringify(finished));
				document.getElementById("framing-preview")?.remove();
				const preview = document.createElement("div");
				preview.id = "framing-preview";
				Object.assign(preview.style, { position: "fixed", left: "0px", top: "0px", width: "320px", height: "180px", background: "black", zIndex: "99999" });
				const frame = document.createElement("div");
				Object.assign(frame.style, { position: "absolute", left: webcam.rect.x + "px", top: webcam.rect.y + "px", width: webcam.rect.width + "px", height: webcam.rect.height + "px", overflow: "hidden", borderRadius: webcam.borderRadius + "px" });
				const video = document.createElement("video");
				const style = getWebcamVideoStyle(info, webcam.rect, config.webcamFraming, config.webcamRotation, config.webcamMirrored);
				Object.assign(video.style, { position: "absolute", ...style, width: style.width + "px", height: style.height + "px" });
				video.muted = true;
				const loaded = new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error("Could not load preview webcam")); });
				video.src = "file://" + webcamPath;
				frame.append(video); preview.append(frame); document.body.append(preview);
				await loaded;
				await video.play();
				await new Promise(resolve => video.requestVideoFrameCallback(resolve));
				video.pause();
				const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
				const ctx = canvas.getContext("2d"); ctx.fillStyle = "black"; ctx.fillRect(0, 0, 320, 180);
				ctx.beginPath(); ctx.roundRect(webcam.rect.x, webcam.rect.y, webcam.rect.width, webcam.rect.height, webcam.borderRadius); ctx.clip();
				drawWebcamFrameImage(ctx, video, webcam.sourceCrop, webcam.rect, config.webcamMirrored, config.webcamRotation);
				await new Promise(requestAnimationFrame);
				return { reference: canvas.toDataURL("image/png").split(",")[1], crop: webcam.sourceCrop };
			}`,
			},
			bundle: true,
			write: false,
			format: "iife",
			globalName: "webcamFramingTest",
			platform: "browser",
		});
		const page = await app.firstWindow();
		await page.waitForLoadState("domcontentloaded");
		const variants = [
			{
				webcamLayoutPreset: "only-webcam",
				webcamFraming: { zoom: 2, x: 0.2, y: 0.7 },
				webcamRotation: 0,
				webcamMirrored: false,
			},
			{
				webcamLayoutPreset: "only-webcam",
				webcamFraming: { zoom: 2.2, x: 0.8, y: 0.25 },
				webcamRotation: 90,
				webcamMirrored: true,
			},
			{
				webcamLayoutPreset: "picture-in-picture",
				webcamMaskShape: "circle",
				webcamFraming: { zoom: 1.5, x: 0.3, y: 0.6 },
				webcamRotation: 270,
				webcamMirrored: true,
			},
		];
		const rgbFromPng = (png: Buffer) =>
			execFileSync(
				ffmpeg,
				["-v", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
				{ input: png },
			);
		for (const [index, variant] of variants.entries()) {
			const outputPath = path.join(directory, `output-${index}.mp4`);
			const result = await page.evaluate(
				`(async () => { ${bundle.outputFiles[0].text}; return webcamFramingTest.run(${JSON.stringify(screenPath)}, ${JSON.stringify(webcamPath)}, ${JSON.stringify(outputPath)}, ${JSON.stringify(variant)}); })()`,
			);
			const reference = rgbFromPng(Buffer.from(result.reference, "base64"));
			const previewPng = await page
				.locator("#framing-preview")
				.screenshot({ path: test.info().outputPath(`preview-${index}.png`) });
			fs.writeFileSync(
				test.info().outputPath(`reference-${index}.png`),
				Buffer.from(result.reference, "base64"),
			);
			await test.info().attach(`preview-${index}`, { body: previewPng, contentType: "image/png" });
			const preview = rgbFromPng(previewPng);
			const exported = execFileSync(ffmpeg, [
				"-v",
				"error",
				"-i",
				outputPath,
				"-frames:v",
				"1",
				"-f",
				"rawvideo",
				"-pix_fmt",
				"rgb24",
				"pipe:1",
			]);
			for (const [label, actual] of [
				["preview", preview],
				["native", exported],
			] as const) {
				expect(actual.length).toBe(reference.length);
				let error = 0;
				let different = 0;
				for (let i = 0; i < reference.length; i++) {
					const delta = Math.abs(actual[i] - reference[i]);
					error += delta;
					if (delta > 32) different++;
				}
				const meanError = error / reference.length;
				const differentFraction = different / reference.length;
				console.log(
					"Webcam framing:",
					JSON.stringify({ index, label, crop: result.crop, meanError, differentFraction }),
				);
				expect(meanError).toBeLessThan(6);
				expect(differentFraction).toBeLessThan(0.03);
			}
		}
	} finally {
		await app.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
