import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("reviews OpenRouter cuts through the real preload and applies them with undo", async () => {
	const testInfo = test.info();
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-ai-cut-e2e-"));
	const env = {
		...process.env,
		XDG_CONFIG_HOME: directory,
		HEADLESS: "true",
		LANG: "en_US.UTF-8",
		LANGUAGE: "en_US",
	};
	delete env.ELECTRON_RUN_AS_NODE;
	const app = await electron.launch({
		args: [
			path.resolve("dist-electron/main.js"),
			"--no-sandbox",
			"--enable-unsafe-swiftshader",
			`--user-data-dir=${directory}/profile`,
		],
		env,
	});
	try {
		app.on("window", (page) => {
			page.on("pageerror", (error) => console.log("Page error:", error.message));
			page.on("console", (message) => {
				if (message.type() === "error") console.log("Console error:", message.text());
			});
			page.on("requestfailed", (request) =>
				console.log("Failed resource:", request.url(), request.failure()?.errorText),
			);
		});
		const userData = await app.evaluate(({ app }) => app.getPath("userData"));
		expect(userData.startsWith(directory)).toBe(true);
		const recordings = path.join(userData, "recordings");
		fs.mkdirSync(recordings, { recursive: true });
		const source = path.join(recordings, "source.mp4");
		execFileSync("/usr/bin/ffmpeg", [
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=640x360:r=30:d=5",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=48000:duration=5",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			source,
		]);
		// Synthetic transcript and provider response: no paid request, key or model download.
		// The settings store, IPC authorization, schema validation and editor remain real.
		await app.evaluate(({ ipcMain }, sourcePath) => {
			ipcMain.removeHandler("open-video-file-picker");
			ipcMain.handle("open-video-file-picker", () => ({ success: true, path: sourcePath }));
			ipcMain.removeHandler("caption-transcription:transcribe");
			ipcMain.handle("caption-transcription:transcribe", () => ({
				granularity: "word",
				truncated: false,
				segments: [
					{ text: "Hello", startSec: 0.2, endSec: 0.8 },
					{ text: "um", startSec: 1, endSec: 1.4 },
					{ text: "world", startSec: 2, endSec: 2.5 },
				],
			}));
			globalThis.fetch = async (url, options) => {
				if (url !== "https://openrouter.ai/api/v1/chat/completions")
					throw new Error("Unexpected external request in AI cut test");
				const body = JSON.parse(String(options?.body));
				if (body.model !== "test/model" || body.provider.require_parameters !== true)
					throw new Error("Invalid OpenRouter request");
				return Response.json({
					choices: [
						{
							finish_reason: "stop",
							message: {
								content: JSON.stringify({
									cuts: [{ firstUnitId: 1, lastUnitId: 1, reason: "Filler word" }],
								}),
							},
						},
					],
				});
			};
		}, source);
		const hud = await app.firstWindow();
		await hud.waitForLoadState("domcontentloaded");
		const [page] = await Promise.all([
			app.waitForEvent("window", {
				predicate: (window) => window.url().includes("windowType=editor"),
			}),
			hud.getByTestId("launch-open-studio-button").click(),
		]);
		await page.waitForLoadState("domcontentloaded");
		await page.getByRole("button", { name: "Import Video File…", exact: true }).click();
		await expect(page.getByRole("button", { name: "AI Cut", exact: true })).toBeEnabled({
			timeout: 30000,
		});
		await page.getByRole("button", { name: "AI Cut", exact: true }).click();
		await page.getByLabel("API key", { exact: true }).fill("test-only-not-a-real-key");
		await page.getByLabel("Model ID", { exact: true }).fill("test/model");
		await page.getByRole("button", { name: "Analyze scene", exact: true }).click();
		await expect(page.getByText("1 selected cuts · 0.4 seconds removed (source time)")).toBeVisible(
			{ timeout: 30000 },
		);
		await page.getByRole("button", { name: "Preview cut", exact: true }).click();
		await page.screenshot({ path: testInfo.outputPath("ai-cut-review.png") });
		await page.getByRole("button", { name: "Apply selected cuts", exact: true }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(
			page.getByTestId("editor-scene-timeline").getByText("Trim", { exact: true }),
		).toHaveCount(1);
		await page.keyboard.press("Control+z");
		await expect(
			page.getByTestId("editor-scene-timeline").getByText("Trim", { exact: true }),
		).toHaveCount(0);
		const stored = await page.evaluate(() => window.electronAPI.aiCut.getSettings());
		expect(stored).toMatchObject({ model: "test/model", hasApiKey: true });
		expect(JSON.stringify(stored)).not.toContain("test-only-not-a-real-key");
		expect(fs.readFileSync(path.join(userData, "openrouter.json"), "utf8")).not.toContain(
			"test-only-not-a-real-key",
		);
	} catch (error) {
		for (const page of app.windows()) {
			if (page.url().includes("windowType=editor")) {
				console.log("Editor failure state:", await page.locator("body").innerText());
				await page.screenshot({ path: testInfo.outputPath("failure.png") });
			}
		}
		throw error;
	} finally {
		await app.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
