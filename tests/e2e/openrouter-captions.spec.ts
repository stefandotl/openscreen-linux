import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("reuses cloud captions for AI Cut after saving and reopening a project through real IPC", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-cloud-captions-e2e-"));
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
		const userData = await app.evaluate(({ app }) => app.getPath("userData"));
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
		await app.evaluate(({ ipcMain }, sourcePath) => {
			const counts = { audio: 0, cuts: 0 };
			Object.assign(globalThis, { videtioProviderCounts: counts });
			ipcMain.removeHandler("open-video-file-picker");
			ipcMain.handle("open-video-file-picker", () => ({ success: true, path: sourcePath }));
			// Only the external provider response is simulated. Audio extraction, timing parsing,
			// settings, editor authorization and the preload bridge remain real.
			globalThis.fetch = async (url, options) => {
				if (url === "https://openrouter.ai/api/v1/chat/completions") {
					counts.cuts++;
					const body = JSON.parse(String(options?.body));
					if (body.model !== "test/cut-model") throw new Error("Wrong cut model");
					const input = JSON.parse(body.messages[1].content);
					const word = input.units.find((unit: { text: string }) => unit.text === "Second");
					if (!input.units.some((unit: { text: string }) => unit.text === "First"))
						throw new Error("Existing caption transcript missing from cut request");
					return Response.json({
						choices: [
							{
								finish_reason: "stop",
								message: {
									content: JSON.stringify({
										cuts: word
											? [
													{
														firstUnitId: word.id,
														lastUnitId: word.id,
														reason: "Remove redundant word",
													},
												]
											: [],
									}),
								},
							},
						],
					});
				}
				counts.audio++;
				if (url !== "https://openrouter.ai/api/v1/audio/transcriptions")
					throw new Error("Unexpected external request");
				const body = JSON.parse(String(options?.body));
				if (
					body.model !== "fish-audio/transcribe-1-pro" ||
					body.response_format !== "verbose_json" ||
					body.timestamp_granularities?.[0] !== "word" ||
					body.input_audio.format !== "wav"
				)
					throw new Error("Invalid timed transcription request");
				if (Buffer.from(body.input_audio.data, "base64").subarray(0, 4).toString() !== "RIFF")
					throw new Error("No WAV audio uploaded");
				return Response.json({
					text: "First Second Third",
					words: [
						{ word: "First", start: 0.2, end: 0.7 },
						{ word: "Second", start: 1.3, end: 1.8 },
						{ word: "Third", start: 3.1, end: 3.6 },
					],
				});
			};
		}, source);
		const hud = await app.firstWindow();
		await hud.waitForLoadState("domcontentloaded");
		const [page] = await Promise.all([
			app.waitForEvent("window", { predicate: (page) => page.url().includes("windowType=editor") }),
			hud.getByTestId("launch-open-studio-button").click(),
		]);
		await page.waitForLoadState("domcontentloaded");
		await page.getByRole("button", { name: "Import Video File…", exact: true }).click();
		await page.getByRole("button", { name: "Auto captions", exact: true }).click();
		await page.locator("#caption-engine").click();
		await page.getByRole("option", { name: "OpenRouter", exact: true }).click();
		await page.locator("#caption-openrouter-model").click();
		await page.getByRole("option", { name: "Fish Audio · Transcribe 1 Pro", exact: true }).click();
		await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
		await page.getByRole("button", { name: "OpenRouter settings", exact: true }).click();
		await page.getByLabel("API key", { exact: true }).fill("test-only-not-a-real-key");
		await page.getByRole("button", { name: "Save key", exact: true }).click();
		await expect(page.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await page.getByRole("button", { name: "Auto captions", exact: true }).click();
		await expect(page.locator("#caption-openrouter-model")).toContainText(
			"Fish Audio · Transcribe 1 Pro",
		);
		await page.screenshot({ path: test.info().outputPath("openrouter-model-selection.png") });
		await page.getByRole("button", { name: "Generate", exact: true }).click();
		await expect(page.getByText("Added 3 captions.", { exact: true })).toBeVisible({
			timeout: 30000,
		});
		await page.screenshot({ path: test.info().outputPath("openrouter-captions.png") });
		const settings = await page.evaluate(() => window.electronAPI.openRouter.getSettings());
		expect(settings).toMatchObject({
			captionEngine: "openrouter",
			transcriptionModel: "fish-audio/transcribe-1-pro",
			hasApiKey: true,
		});
		expect(JSON.stringify(settings)).not.toContain("test-only-not-a-real-key");
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await page.getByRole("menuitem", { name: "OpenRouter settings", exact: true }).click();
		await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
		await page.getByRole("button", { name: "Close", exact: true }).first().click();
		await page.getByRole("button", { name: "AI Cut", exact: true }).click();
		await page.getByLabel("Model ID", { exact: true }).fill("test/cut-model");
		await expect(
			page.getByRole("radio", { name: "Use existing transcript · fish-audio/transcribe-1-pro" }),
		).toBeChecked();
		await page.screenshot({ path: test.info().outputPath("ai-cut-existing-transcript.png") });
		await page.getByRole("button", { name: "Analyze scene", exact: true }).click();
		await expect(page.getByText("1 selected cuts · 0.5 seconds removed (source time)")).toBeVisible(
			{ timeout: 30000 },
		);
		await page.getByRole("button", { name: "Apply selected cuts", exact: true }).click();
		const requestedSave = path.join(directory, "Saved.videtio");
		await app.evaluate(({ dialog }, filePath) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath });
		}, requestedSave);
		await page.getByRole("button", { name: "Save Project", exact: true }).click();
		const projectPath = path.join(directory, "Saved", "Saved.videtio");
		await expect.poll(() => fs.existsSync(projectPath)).toBe(true);
		await expect(page.getByText(`Project saved to ${projectPath}`, { exact: true })).toBeVisible();
		const savedProject = JSON.parse(fs.readFileSync(projectPath, "utf8"));
		expect(savedProject.editor.sourceTranscript).toMatchObject({
			model: "fish-audio/transcribe-1-pro",
			engine: "openrouter",
			truncated: false,
		});
		expect(
			savedProject.editor.sourceTranscript.segments.map(
				(segment: { text: string }) => segment.text,
			),
		).toEqual(["First", "Second", "Third"]);
		await app.evaluate(({ dialog }, filePath) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
		}, projectPath);
		await page.getByRole("button", { name: "File", exact: true }).click();
		await page.getByRole("menuitem", { name: /Load Project/ }).click();
		await expect(
			page.getByText(`Project loaded from ${projectPath}`, { exact: true }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: "AI Cut", exact: true })).toBeEnabled();
		await page.getByRole("button", { name: "AI Cut", exact: true }).click();
		await expect(
			page.getByRole("radio", { name: "Use existing transcript · fish-audio/transcribe-1-pro" }),
		).toBeChecked();
		await page.getByRole("button", { name: "Analyze scene", exact: true }).click();
		await expect(page.getByText("No cuts suggested. The scene has not been changed.")).toBeVisible({
			timeout: 30000,
		});
		expect(
			await app.evaluate(
				() =>
					(
						globalThis as typeof globalThis & {
							videtioProviderCounts: { audio: number; cuts: number };
						}
					).videtioProviderCounts,
			),
		).toEqual({ audio: 1, cuts: 2 });
	} catch (error) {
		for (const page of app.windows()) {
			if (page.url().includes("windowType=editor")) {
				console.log("Editor failure state:", await page.locator("body").innerText());
				console.log(
					"Video metadata:",
					await page
						.locator("video")
						.evaluateAll((videos) =>
							videos.map((video) => ({ duration: video.duration, src: video.getAttribute("src") })),
						),
				);
				await page.screenshot({ path: test.info().outputPath("failure.png") });
			}
		}
		throw error;
	} finally {
		await app.evaluate(({ BrowserWindow }) => {
			// This isolated test discards its temporary project when closing.
			for (const window of BrowserWindow.getAllWindows()) window.removeAllListeners("close");
		});
		await app.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
