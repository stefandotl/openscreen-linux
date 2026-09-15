import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

// Opt in on the required NVIDIA desktop: VIDETIO_E2E_NATIVE_SYNC=1 npm run test:e2e -- tests/e2e/native-trim-sync.spec.ts
// Uses the real silence detector, native export plan, CUDA helper and FFmpeg audio mux.
test("keeps light and tone pulses synchronized after silence detection and nested scene trims", async () => {
	test.skip(process.env.VIDETIO_E2E_NATIVE_SYNC !== "1", "Requires a working NVIDIA desktop");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-native-trim-sync-"));
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
		const sourcePath = path.join(recordings, "sync-pulses.mp4");
		const outputPath = path.join(directory, "trimmed.mp4");
		const ffmpeg = process.env.VIDETIO_FFMPEG_PATH ?? "/usr/bin/ffmpeg";
		// Integer frame numbers avoid floating-point ambiguity at the flash boundaries.
		execFileSync(ffmpeg, [
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=black:s=320x180:r=30:d=12",
			"-f",
			"lavfi",
			"-i",
			"aevalsrc=if(between(mod(t\\,1)\\,0.1\\,0.3)\\,0.8*sin(2*PI*1000*t)\\,0):s=48000:d=12",
			"-vf",
			"drawbox=color=white:t=fill:enable='between(mod(n,30),3,8)'",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			sourcePath,
		]);
		const bundle = await build({
			stdin: {
				resolveDir: process.cwd(),
				loader: "ts",
				contents: `
				import { createNativeGpuExportPlan, createNativeGpuExportAssets } from "./src/lib/exporter/nativeGpuExportPlan";
				import { mergeConnectedTrimRegions } from "./src/components/video-editor/trimRegions";
				export async function run(sourcePath, outputPath) {
					const detected = await window.electronAPI.detectSilence(sourcePath, { noiseThresholdDb: -38, minimumSilenceMs: 300, paddingMs: 80 }, 12000);
					if (!detected.success) throw new Error(JSON.stringify(detected));
					const trimRegions = mergeConnectedTrimRegions([
						{ id: "scene-start", source: "scene-split", startMs: 0, endMs: 4000 },
						{ id: "scene-end", source: "scene-split", startMs: 10000, endMs: 12000 },
						...detected.regions.map((r, i) => ({ ...r, id: "silence-" + i })),
					]);
					const config = {
						videoUrl: sourcePath, width: 320, height: 180, frameRate: 30, bitrate: 4000000,
						wallpaper: "#000000", zoomRegions: [], trimRegions, speedRegions: [], annotationRegions: [],
						showShadow: false, shadowIntensity: 0, showBlur: false, motionBlurAmount: 0,
						borderRadius: 0, padding: 0, cropRegion: { x: 0, y: 0, width: 1, height: 1 },
					};
					const plan = createNativeGpuExportPlan(config, { width: 320, height: 180, duration: 12 });
					const assets = await createNativeGpuExportAssets(config);
					const started = await window.electronAPI.startNativeGpuExport({ plan, outputPath, audioPath: sourcePath, sourceDurationSec: 12, trimRegions, speedRegions: [], wallpaperPng: assets.wallpaperPng, overlayPngs: assets.overlayPngs });
					if (!started.success) throw new Error(JSON.stringify(started));
					const finished = await window.electronAPI.finishNativeGpuExport(started.sessionId);
					if (!finished.success) throw new Error(JSON.stringify(finished));
					return { cuts: detected.regions.length, frames: plan.frames.length };
				}`,
			},
			bundle: true,
			write: false,
			format: "iife",
			globalName: "nativeTrimSyncTest",
			platform: "browser",
		});
		const page = await app.firstWindow();
		await page.waitForLoadState("domcontentloaded");
		const result = await page.evaluate(
			`(async () => { ${bundle.outputFiles[0].text}; return nativeTrimSyncTest.run(${JSON.stringify(sourcePath)}, ${JSON.stringify(outputPath)}); })()`,
		);
		expect(result.cuts).toBeGreaterThan(10);
		const pixels = execFileSync(ffmpeg, [
			"-v",
			"error",
			"-i",
			outputPath,
			"-vf",
			"crop=2:2:160:90,scale=1:1",
			"-pix_fmt",
			"gray",
			"-f",
			"rawvideo",
			"pipe:1",
		]);
		const pcm = execFileSync(ffmpeg, [
			"-v",
			"error",
			"-i",
			outputPath,
			"-vn",
			"-ac",
			"1",
			"-ar",
			"48000",
			"-f",
			"f32le",
			"pipe:1",
		]);
		const videoOnsets: number[] = [];
		for (let i = 0; i < pixels.length; i++) {
			if (pixels[i] > 128 && (i === 0 || pixels[i - 1] <= 128)) videoOnsets.push(i / 30);
		}
		const audioOnsets: number[] = [];
		let wasActive = false;
		for (let offset = 0; offset + 480 * 4 <= pcm.length; offset += 480 * 4) {
			let sum = 0;
			for (let i = 0; i < 480; i++) sum += pcm.readFloatLE(offset + i * 4) ** 2;
			const active = Math.sqrt(sum / 480) > 0.2;
			if (active && !wasActive) audioOnsets.push(offset / 4 / 48000);
			wasActive = active;
		}
		expect(pixels.length).toBe(result.frames);
		expect(videoOnsets).toHaveLength(6);
		expect(audioOnsets).toHaveLength(6);
		const offsets = videoOnsets.map((time, i) => time - audioOnsets[i]);
		console.log(
			"Native trim sync:",
			JSON.stringify({ ...result, videoOnsets, audioOnsets, offsets }),
		);
		for (const offset of offsets) expect(Math.abs(offset)).toBeLessThan(1 / 30 + 0.01);
	} finally {
		await app.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
