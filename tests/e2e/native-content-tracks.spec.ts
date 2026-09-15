import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

// VIDETIO_E2E_CONTENT_TRACKS=1 npm run test:e2e -- tests/e2e/native-content-tracks.spec.ts
test("exports auto-caption output, overlapping text, an image and imported audio through native GPU", async () => {
	test.skip(process.env.VIDETIO_E2E_CONTENT_TRACKS !== "1", "Requires a working NVIDIA desktop");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-content-tracks-"));
	const launchEnv = { ...process.env, ELECTRON_USER_DATA_DIR: directory, HEADLESS: "true" };
	delete launchEnv.ELECTRON_RUN_AS_NODE;
	const app = await electron.launch({
		args: [path.resolve("dist-electron/main.js"), "--no-sandbox", `--user-data-dir=${directory}`],
		env: launchEnv,
	});
	try {
		const userData = await app.evaluate(({ app }) => app.getPath("userData"));
		const recordings = path.join(userData, "recordings");
		fs.mkdirSync(recordings, { recursive: true });
		const sourcePath = path.join(recordings, "source.mp4");
		const audioPath = path.join(directory, "music.wav");
		const outputPath = path.join(directory, "output.mp4");
		const ffmpeg = process.env.VIDETIO_FFMPEG_PATH ?? "/usr/bin/ffmpeg";
		const run = (args: string[]) =>
			execFileSync(ffmpeg, ["-v", "error", "-y", ...args], { maxBuffer: 32 * 1024 * 1024 });
		run([
			"-f",
			"lavfi",
			"-i",
			"color=black:s=320x180:r=30:d=3",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			sourcePath,
		]);
		run(["-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=2", audioPath]);
		const bundle = await build({
			stdin: {
				resolveDir: process.cwd(),
				loader: "ts",
				contents: `
			import { createNativeGpuExportPlan, createNativeGpuExportAssets, getNativeGpuExportBlockers } from "./src/lib/exporter/nativeGpuExportPlan";
			import { captionSegmentsToAnnotationRegions } from "./src/lib/captioning/annotationsFromCaptions";
			import { renderAnnotations } from "./src/lib/exporter/annotationRenderer";
			export async function run(sourcePath, audioPath, outputPath) {
				const imported = await window.electronAPI.inspectAudioFile(audioPath);
				if (!imported.success) throw new Error(JSON.stringify(imported));
				const captions = captionSegmentsToAnnotationRegions([
					{ text: "First", startSec: 0, endSec: 0.9 }, { text: "Second", startSec: 1, endSec: 1.9 }, { text: "Third", startSec: 2, endSec: 2.9 }
				], 1, 5, { timestampGranularity: "phrase", minWordsPerCaption: 1, maxWordsPerCaption: 2,
					style: { fontFamily: "sans-serif", fontSize: 14, wordHighlight: false } }).regions;
				if (captions.length !== 3) throw new Error("Expected three auto captions");
				const text = (id, color, zIndex, startMs, endMs) => ({ ...captions[0], annotationSource: undefined,
					id, startMs, endMs, content: id, position: { x: 10, y: 30 }, size: { width: 80, height: 20 }, zIndex,
					style: { ...captions[0].style, backgroundColor: color } });
				const image = document.createElement("canvas"); image.width = 32; image.height = 32;
				image.getContext("2d").fillStyle = "#00ff00"; image.getContext("2d").fillRect(0, 0, 32, 32);
				const annotationRegions = [...captions, text("Lower", "#ff0000", 10, 200, 1800), text("Upper", "#0000ff", 20, 1200, 2800),
					{ ...text("Image", "transparent", 30, 0, 1000), type: "image", content: image.toDataURL(), position: { x: 60, y: 10 }, size: { width: 20, height: 20 } }];
				const config = { videoUrl: sourcePath, width: 320, height: 180, frameRate: 30, bitrate: 4000000, wallpaper: "#000000",
					zoomRegions: [], trimRegions: [], speedRegions: [], annotationRegions, showShadow: false, shadowIntensity: 0, showBlur: false,
					motionBlurAmount: 0, borderRadius: 0, padding: 0, cropRegion: { x: 0, y: 0, width: 1, height: 1 } };
				const blockers = getNativeGpuExportBlockers(config, { width: 320, height: 180, duration: 3 });
				if (blockers.length) throw new Error(blockers.join("; "));
				const plan = createNativeGpuExportPlan(config, { width: 320, height: 180, duration: 3 });
				const assets = await createNativeGpuExportAssets(config);
				plan.overlays = assets.overlays;
				const audioRegions = [{ id: "music", name: "music.wav", sourcePath: imported.path, startMs: 1000, endMs: 2000,
					sourceStartMs: 0, sourceDurationMs: imported.durationMs, volume: 0.5, fadeInMs: 100, fadeOutMs: 100 }];
				const started = await window.electronAPI.startNativeGpuExport({ plan, outputPath, audioRegions, sourceDurationSec: 3,
					wallpaperPng: assets.wallpaperPng, overlayPngs: assets.overlayPngs });
				if (!started.success) throw new Error(JSON.stringify(started));
				const finished = await window.electronAPI.finishNativeGpuExport(started.sessionId);
				if (!finished.success) throw new Error(JSON.stringify(finished));
				const expected = [];
				for (const time of [400, 1400, 2400]) {
					const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
					const context = canvas.getContext("2d"); context.fillStyle = "#000000"; context.fillRect(0, 0, 320, 180);
					await renderAnnotations(context, annotationRegions, 320, 180, time);
					expected.push(Array.from(context.getImageData(0, 0, 320, 180).data));
				}
				return { expected, frames: plan.frames.length, overlays: plan.overlays.length };
			}`,
			},
			bundle: true,
			write: false,
			format: "iife",
			globalName: "contentTracksTest",
			platform: "browser",
		});
		const page = await app.firstWindow();
		await page.waitForLoadState("domcontentloaded");
		const result = await page.evaluate(
			`(async () => { ${bundle.outputFiles[0].text}; return contentTracksTest.run(${JSON.stringify(sourcePath)}, ${JSON.stringify(audioPath)}, ${JSON.stringify(outputPath)}); })()`,
		);
		expect(result.frames).toBe(90);
		expect(result.overlays).toBe(6);
		const frames = run([
			"-i",
			outputPath,
			"-vf",
			"select=eq(n\\,12)+eq(n\\,42)+eq(n\\,72)",
			"-fps_mode",
			"vfr",
			"-pix_fmt",
			"rgba",
			"-f",
			"rawvideo",
			"pipe:1",
		]);
		const frameBytes = 320 * 180 * 4;
		expect(frames.length).toBe(frameBytes * 3);
		const differences: number[] = [];
		for (let frame = 0; frame < 3; frame++) {
			let difference = 0;
			for (let pixel = 0; pixel < frameBytes; pixel++)
				difference += Math.abs(frames[frame * frameBytes + pixel] - result.expected[frame][pixel]);
			differences.push(difference / frameBytes);
			expect(differences[frame]).toBeLessThan(4);
		}
		const pcm = run(["-i", outputPath, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
		const rms = (start: number) => {
			let energy = 0;
			for (let sample = start * 48000; sample < (start + 0.1) * 48000; sample++)
				energy += pcm.readFloatLE(Math.round(sample) * 4) ** 2;
			return Math.sqrt(energy / 4800);
		};
		expect(rms(0.4)).toBeLessThan(0.001);
		expect(rms(1.4)).toBeGreaterThan(0.025);
		expect(rms(2.4)).toBeLessThan(0.001);
		console.log(
			"Native content tracks:",
			JSON.stringify({
				frames: result.frames,
				overlays: result.overlays,
				averagePixelDifferences: differences,
			}),
		);
	} finally {
		await app.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
