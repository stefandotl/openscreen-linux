import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

test("prepares and reuses an indexed preview without replacing the source", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-preview-video-e2e-"));
	const env = { ...process.env, XDG_CONFIG_HOME: directory };
	delete env.ELECTRON_RUN_AS_NODE;
	const app = await electron.launch({
		args: [
			path.resolve("dist-electron/main.js"),
			"--no-sandbox",
			`--user-data-dir=${directory}/profile`,
		],
		env,
	});

	try {
		const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
		const recordings = path.join(userData, "recordings");
		fs.mkdirSync(recordings, { recursive: true });
		const sourcePath = path.join(recordings, "preview-source.webm");
		const sourceBytes = fs.readFileSync(path.resolve("tests/fixtures/sample.webm"));
		fs.writeFileSync(sourcePath, sourceBytes);

		const page = await app.firstWindow();
		await page.waitForLoadState("domcontentloaded");
		const first = await page.evaluate(
			(source) => window.electronAPI.preparePreviewVideo(source),
			sourcePath,
		);
		expect(first.success, JSON.stringify(first)).toBe(true);
		expect(first.cached).toBe(false);
		const previewPath = fileURLToPath(first.path!);
		expect(path.dirname(previewPath)).toBe(path.join(userData, "preview-video"));
		expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);

		const second = await page.evaluate(
			(source) => window.electronAPI.preparePreviewVideo(source),
			sourcePath,
		);
		expect(second).toEqual({ success: true, path: first.path, cached: true });

		const media = await page.evaluate(async (source) => {
			const video = document.createElement("video");
			video.muted = true;
			video.preload = "auto";
			video.src = source;
			document.body.append(video);
			const waitFor = (eventName: "loadedmetadata" | "seeked") =>
				new Promise<void>((resolve, reject) => {
					const timeout = window.setTimeout(
						() => reject(new Error(`${eventName} timed out`)),
						10_000,
					);
					video.addEventListener(
						eventName,
						() => {
							window.clearTimeout(timeout);
							resolve();
						},
						{ once: true },
					);
					video.addEventListener(
						"error",
						() => reject(new Error(video.error?.message || "media error")),
						{ once: true },
					);
				});

			await waitFor("loadedmetadata");
			video.currentTime = 1.5;
			await waitFor("seeked");
			return {
				duration: video.duration,
				currentTime: video.currentTime,
				width: video.videoWidth,
				height: video.videoHeight,
				readyState: video.readyState,
			};
		}, first.path!);
		expect(media.duration).toBeCloseTo(2, 1);
		expect(media.currentTime).toBeCloseTo(1.5, 1);
		expect(media).toMatchObject({ width: 640, height: 480, readyState: 4 });
	} finally {
		await app.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
