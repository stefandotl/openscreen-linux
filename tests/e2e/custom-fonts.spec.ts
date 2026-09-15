import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

// Uses isolated Linux profiles, the real preload bridge, and a locally served
// font fixture so Google Fonts availability cannot hide storage/loading errors.
test("shares migrated fonts between file and Dev origins and restores project fonts", async () => {
	test.skip(process.platform !== "linux", "Linux profile regression");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-font-sharing-"));
	const apps: ElectronApplication[] = [];
	const fixture = path.resolve(
		"node_modules/playwright-core/lib/vite/traceViewer/codicon.DCmgc-ay.ttf",
	);
	const bundle = await build({
		stdin: {
			contents: `export * from "./src/lib/customFonts";
				export { createNativeGpuExportPlan, createNativeGpuExportAssets, getNativeGpuExportBlockers } from "./src/lib/exporter/nativeGpuExportPlan";
				export { renderAnnotations } from "./src/lib/exporter/annotationRenderer";`,
			resolveDir: process.cwd(),
			loader: "ts",
		},
		bundle: true,
		write: false,
		format: "iife",
		globalName: "fontTest",
		platform: "browser",
	});
	const font = {
		id: "fixture",
		name: "Fixture",
		fontFamily: "VidetioFixture",
		importUrl: "https://fonts.googleapis.com/css2?family=VidetioFixture",
	};
	try {
		const open = async (name: string, dev: boolean) => {
			const env = { ...process.env, HEADLESS: "true", XDG_CONFIG_HOME: directory };
			delete env.ELECTRON_RUN_AS_NODE;
			const app = await electron.launch({
				args: [
					path.resolve("dist-electron/main.js"),
					"--no-sandbox",
					`--user-data-dir=${path.join(directory, name)}`,
				],
				env,
			});
			apps.push(app);
			const page = await app.firstWindow();
			await page.route("https://fonts.googleapis.com/**", (route) =>
				route.fulfill({
					contentType: "text/css",
					body: '@font-face { font-family: "VidetioFixture"; src: url("https://fonts.gstatic.com/fixture.ttf"); }',
				}),
			);
			await page.route("https://fonts.gstatic.com/**", (route) =>
				route.fulfill({
					contentType: "font/ttf",
					headers: { "Access-Control-Allow-Origin": "*" },
					body: fs.readFileSync(fixture),
				}),
			);
			if (dev) {
				await page.route("http://127.0.0.1:5189/**", (route) =>
					route.fulfill({
						contentType: "text/html",
						body: "<html><head></head><body>Dev origin</body></html>",
					}),
				);
				await app.evaluate(async ({ BrowserWindow }) => {
					await BrowserWindow.getAllWindows()[0].loadURL("http://127.0.0.1:5189/");
				});
			}
			await page.evaluate(`${bundle.outputFiles[0].text}; window.fontTest = fontTest;`);
			return page;
		};
		const installed = await open("installed-profile", false);
		await installed.evaluate(
			(font) => localStorage.setItem("videtio_custom_fonts", JSON.stringify([font])),
			font,
		);
		await installed.evaluate("window.fontTest.loadAllCustomFonts()");
		expect(await installed.evaluate(() => localStorage.getItem("videtio_custom_fonts"))).toBeNull();
		const dev = await open("dev-profile", true);
		expect(await dev.evaluate(() => localStorage.getItem("videtio_custom_fonts"))).toBeNull();
		await dev.evaluate("window.fontTest.loadAllCustomFonts()");
		expect(await dev.evaluate("window.fontTest.getCustomFonts()")).toEqual([font]);
		expect(
			await dev.evaluate(async () => (await document.fonts.load('16px "VidetioFixture"')).length),
		).toBeGreaterThan(0);
		await expect(
			dev.evaluate(
				(font) =>
					window.electronAPI.mergeCustomFonts([{ ...font, importUrl: "file:///etc/passwd" }]),
				font,
			),
		).rejects.toThrow("Invalid custom font definitions");
		// Project definitions are imported and become visible to the other instance.
		await dev.evaluate(
			`window.fontTest.restoreProjectFonts(${JSON.stringify([{ ...font, name: "From project" }])})`,
		);
		await installed.evaluate("window.fontTest.loadAllCustomFonts()");
		expect(await installed.evaluate("window.fontTest.getCustomFonts()[0].name")).toBe(
			"From project",
		);
		expect(fs.readdirSync(path.join(directory, "videtio-shared", "fonts"))).toHaveLength(1);
		if (process.env.VIDETIO_E2E_NATIVE_SYNC === "1") {
			const ffmpeg = process.env.VIDETIO_FFMPEG_PATH ?? "/usr/bin/ffmpeg";
			const source = path.join(directory, "dev-profile", "recordings", "font-source.mp4");
			fs.mkdirSync(path.dirname(source), { recursive: true });
			execFileSync(ffmpeg, [
				"-v",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=black:s=320x180:r=30:d=0.6",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				source,
			]);
			const output = path.join(directory, "font-export.mp4");
			const references: string[] = await dev.evaluate(`(async () => {
				const api = window.fontTest;
				const annotation = (id, startMs, endMs, color, y, zIndex) => ({
					id, startMs, endMs, type: "text", content: "\\uea60 \\uea60", position: { x: 10, y }, size: { width: 80, height: 25 }, zIndex,
					style: { fontFamily: "VidetioFixture", fontSize: 32, fontWeight: "normal", fontStyle: "normal", textDecoration: "none", textAlign: "center", color, backgroundColor: "transparent", textAnimation: "none" }
				});
				const annotations = [annotation("one",0,200,"#ffffff",70,1), annotation("two",200,400,"#ffff00",70,1), annotation("three",400,600,"#ffffff",70,1), annotation("top",100,500,"#00ffff",30,5), annotation("bottom",100,500,"#ff0000",30,3)];
				annotations[0].content = Array(5).fill(String.fromCodePoint(0xea60)).join("\\n");
				annotations[0].style.wordHighlight = true;
				annotations[0].style.wordHighlightMode = "text";
				annotations[0].style.wordHighlightColor = "#ff0066";
				const config = { videoUrl: ${JSON.stringify(source)}, width: 320, height: 180, frameRate: 30, bitrate: 4000000, wallpaper: "#000000", zoomRegions: [], trimRegions: [], speedRegions: [], annotationRegions: annotations, showShadow: false, shadowIntensity: 0, showBlur: false, motionBlurAmount: 0, padding: 0, borderRadius: 0, cropRegion: { x: 0, y: 0, width: 1, height: 1 } };
				const info = { width: 320, height: 180, duration: 0.6 };
				if (api.getNativeGpuExportBlockers(config, info).length) throw new Error("Native export rejected custom font annotations");
				const plan = api.createNativeGpuExportPlan(config, info);
				const assets = await api.createNativeGpuExportAssets(config);
				plan.overlays = assets.overlays;
				if (plan.overlays.length !== 6) throw new Error("Expected five base annotations and one visible word highlight");
				const started = await window.electronAPI.startNativeGpuExport({ plan, outputPath: ${JSON.stringify(output)}, sourceDurationSec: 0.6, trimRegions: [], speedRegions: [], wallpaperPng: assets.wallpaperPng, overlayPngs: assets.overlayPngs });
				if (!started.success) throw new Error(JSON.stringify(started));
				const finished = await window.electronAPI.finishNativeGpuExport(started.sessionId);
				if (!finished.success) throw new Error(JSON.stringify(finished));
				const references = [];
				for (const time of [0, 2000/30, 100, 5000/30, 300, 500]) {
					const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
					const ctx = canvas.getContext("2d"); ctx.fillStyle = "black"; ctx.fillRect(0,0,320,180);
					await api.renderAnnotations(ctx, annotations, 320,180,time);
					references.push(canvas.toDataURL("image/png").split(",")[1]);
				}
				return references;
			})()`);
			const exported = execFileSync(
				ffmpeg,
				["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
				{ maxBuffer: 10 * 1024 * 1024 },
			);
			for (const [index, frame] of [0, 2, 3, 5, 9, 15].entries()) {
				const expected = execFileSync(
					ffmpeg,
					["-v", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
					{ input: Buffer.from(references[index], "base64") },
				);
				const actual = exported.subarray(frame * expected.length, (frame + 1) * expected.length);
				expect(actual.length).toBe(expected.length);
				let error = 0;
				let lit = 0;
				for (let i = 0; i < expected.length; i++) {
					error += Math.abs(actual[i] - expected[i]);
					if (expected[i] > 100) lit++;
				}
				expect(lit).toBeGreaterThan(100);
				expect(error / expected.length).toBeLessThan(6);
			}
		}
	} finally {
		for (const app of apps.reverse()) await app.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
