import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");
const TEST_VIDEO =
	process.env["OPENSCREEN_E2E_VIDEO"] ?? path.join(__dirname, "../fixtures/sample.webm");
const MIDDLE_TRIM_START_SECONDS = Number(process.env["OPENSCREEN_E2E_TRIM_START_SECONDS"] ?? "0.5");
const USE_TERMINAL_TRIM = !process.env["OPENSCREEN_E2E_VIDEO"];

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;

async function launchApp() {
	const testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-trim-e2e-"));
	const app = await electron.launch({
		args: [
			MAIN_JS,
			"--no-sandbox",
			"--enable-unsafe-swiftshader",
			"--lang=en-US",
			`--user-data-dir=${testUserDataDir}`,
		],
		env: {
			...process.env,
			ELECTRON_USER_DATA_DIR: testUserDataDir,
			HEADLESS: process.env["HEADLESS"] ?? "true",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			LANGUAGE: "en_US",
		},
	});
	(
		app as ElectronApplication & {
			__testUserDataDir?: string;
			__childProcess?: ReturnType<ElectronApplication["process"]>;
		}
	).__testUserDataDir = testUserDataDir;
	(
		app as ElectronApplication & {
			__testUserDataDir?: string;
			__childProcess?: ReturnType<ElectronApplication["process"]>;
		}
	).__childProcess = app.process();
	return app;
}

async function closeApp(app: ElectronApplication) {
	const childProcess = (
		app as ElectronApplication & {
			__childProcess?: ReturnType<ElectronApplication["process"]>;
		}
	).__childProcess;
	await Promise.race([app.close(), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
	if (childProcess && childProcess.exitCode === null && childProcess.signalCode === null) {
		if (!childProcess.killed) childProcess.kill();
		await Promise.race([
			once(childProcess, "close"),
			new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
		]);
	}
	const testUserDataDir = (app as ElectronApplication & { __testUserDataDir?: string })
		.__testUserDataDir;
	if (testUserDataDir && fs.existsSync(testUserDataDir)) {
		fs.rmSync(testUserDataDir, { recursive: true, force: true });
	}
}

async function dismissLanguagePrompt(page: Page) {
	const keepCurrentLanguage = page
		.getByRole("button")
		.filter({ hasText: /Keep current language|Conserver la langue actuelle/ });
	if ((await keepCurrentLanguage.count()) > 0) await keepCurrentLanguage.click();
}

async function copyFixtureToRecordings(app: ElectronApplication) {
	const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
	const recordingsDir = path.join(userDataDir, "recordings");
	const targetPath = path.join(recordingsDir, "trim-playback-sample.webm");
	fs.mkdirSync(recordingsDir, { recursive: true });
	fs.copyFileSync(TEST_VIDEO, targetPath);
	return targetPath;
}

test("scene and project playback continue after a trim in the middle of a scene", async () => {
	const app = await launchApp();
	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");
		await dismissLanguagePrompt(hudWindow);
		const testVideoPath = await copyFixtureToRecordings(app);

		await app.evaluate(({ ipcMain }, videoPath) => {
			ipcMain.removeHandler("open-video-file-picker");
			ipcMain.handle("open-video-file-picker", () => ({
				success: true,
				path: videoPath,
			}));
		}, testVideoPath);

		const [editorWindow] = await Promise.all([
			app.waitForEvent("window", {
				predicate: (window) => window.url().includes("windowType=editor"),
				timeout: 15_000,
			}),
			hudWindow.getByTestId("launch-open-studio-button").click(),
		]);
		await editorWindow.waitForLoadState("domcontentloaded");
		const playbackConsoleErrors: string[] = [];
		editorWindow.on("console", (message) => {
			const text = message.text();
			if (
				text.includes("Project playback failed") ||
				text.includes("BlurFilter.blur is deprecated")
			) {
				playbackConsoleErrors.push(text);
			}
		});
		await editorWindow.getByRole("button", { name: "Import Video" }).click();
		await expect(editorWindow.getByText("Loading video...")).not.toBeVisible({ timeout: 20_000 });

		const playbackRange = editorWindow.locator('input[type="range"]').first();
		const sourceDurationSeconds = Number(await playbackRange.getAttribute("max"));
		expect(sourceDurationSeconds).toBeGreaterThan(MIDDLE_TRIM_START_SECONDS + 1);
		await playbackRange.evaluate((input, value) => {
			const range = input as HTMLInputElement;
			range.value = String(value);
			range.dispatchEvent(new Event("input", { bubbles: true }));
			range.dispatchEvent(new Event("change", { bubbles: true }));
		}, MIDDLE_TRIM_START_SECONDS);
		await editorWindow.getByTitle("Add Trim (T)").click();

		await playbackRange.evaluate(
			(input, value) => {
				const range = input as HTMLInputElement;
				range.value = String(value);
				range.dispatchEvent(new Event("input", { bubbles: true }));
				range.dispatchEvent(new Event("change", { bubbles: true }));
			},
			Math.max(0, MIDDLE_TRIM_START_SECONDS - 0.2),
		);
		await editorWindow.getByRole("button", { name: "Play", exact: true }).click();

		await expect
			.poll(async () => Number(await playbackRange.inputValue()), { timeout: 10_000 })
			.toBeGreaterThan(MIDDLE_TRIM_START_SECONDS + 1.05);
		const scenePauseButton = editorWindow.getByRole("button", { name: "Pause", exact: true });
		if ((await scenePauseButton.count()) > 0) await scenePauseButton.click();

		if (USE_TERMINAL_TRIM) {
			await playbackRange.evaluate((input, value) => {
				const range = input as HTMLInputElement;
				range.value = String(value);
				range.dispatchEvent(new Event("input", { bubbles: true }));
				range.dispatchEvent(new Event("change", { bubbles: true }));
			}, MIDDLE_TRIM_START_SECONDS + 1);
			await editorWindow.getByTitle("Add Trim (T)").click();
		}

		await editorWindow.getByText("Add scene", { exact: true }).click();
		await editorWindow
			.getByRole("button", { name: /^Import Video File/ })
			.last()
			.click();
		await expect(editorWindow.getByRole("button", { name: "Project", exact: true })).toBeVisible({
			timeout: 20_000,
		});
		await editorWindow.getByRole("button", { name: "Project", exact: true }).click();
		await playbackRange.evaluate(
			(input, value) => {
				const range = input as HTMLInputElement;
				range.value = String(value);
				range.dispatchEvent(new Event("input", { bubbles: true }));
				range.dispatchEvent(new Event("change", { bubbles: true }));
			},
			Math.max(0, MIDDLE_TRIM_START_SECONDS - 0.2),
		);
		await editorWindow.getByRole("button", { name: "Play", exact: true }).click();

		await expect
			.poll(async () => Number(await playbackRange.inputValue()), { timeout: 10_000 })
			.toBeGreaterThan(MIDDLE_TRIM_START_SECONDS + 0.15);

		await editorWindow.getByRole("button", { name: "Pause", exact: true }).click();
		const firstSceneProjectDuration = USE_TERMINAL_TRIM
			? MIDDLE_TRIM_START_SECONDS
			: sourceDurationSeconds - 1;
		await playbackRange.evaluate((input, value) => {
			const range = input as HTMLInputElement;
			range.value = String(value);
			range.dispatchEvent(new Event("input", { bubbles: true }));
			range.dispatchEvent(new Event("change", { bubbles: true }));
		}, firstSceneProjectDuration + 0.25);
		const secondSceneButton = editorWindow.getByRole("button", { name: /^Scene 2:/ });
		await expect(secondSceneButton).toHaveAttribute("aria-current", "true");

		const sceneTimeline = editorWindow.getByTestId("editor-scene-timeline");
		const timelineBounds = await sceneTimeline.boundingBox();
		expect(timelineBounds).not.toBeNull();
		await sceneTimeline.click({
			position: {
				x: Math.round((timelineBounds?.width ?? 1) * 0.35),
				y: Math.round((timelineBounds?.height ?? 1) * 0.5),
			},
		});
		await expect(secondSceneButton).toHaveAttribute("aria-current", "true");
		expect(playbackConsoleErrors).toEqual([]);
	} finally {
		await closeApp(app);
	}
});

test("splits the active scene at the playhead without changing project duration", async () => {
	const app = await launchApp();
	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");
		await dismissLanguagePrompt(hudWindow);
		const testVideoPath = await copyFixtureToRecordings(app);

		await app.evaluate(({ ipcMain }, videoPath) => {
			ipcMain.removeHandler("open-video-file-picker");
			ipcMain.handle("open-video-file-picker", () => ({ success: true, path: videoPath }));
		}, testVideoPath);

		const [editorWindow] = await Promise.all([
			app.waitForEvent("window", {
				predicate: (window) => window.url().includes("windowType=editor"),
				timeout: 15_000,
			}),
			hudWindow.getByTestId("launch-open-studio-button").click(),
		]);
		await editorWindow.waitForLoadState("domcontentloaded");
		await editorWindow.getByRole("button", { name: "Import Video" }).click();
		await expect(editorWindow.getByText("Loading video...")).not.toBeVisible({ timeout: 20_000 });

		const playbackRange = editorWindow.locator('input[type="range"][aria-label$="timeline"]');
		await expect
			.poll(async () => Number(await playbackRange.getAttribute("max")), { timeout: 20_000 })
			.not.toBe(100);
		const sourceDurationSeconds = Number(await playbackRange.getAttribute("max"));
		expect(sourceDurationSeconds).toBeGreaterThan(0.25);
		const splitTimeSeconds = sourceDurationSeconds * 0.4;
		const sceneTimeline = editorWindow.getByTestId("editor-scene-timeline");
		const timelineBounds = await sceneTimeline.boundingBox();
		expect(timelineBounds).not.toBeNull();
		await sceneTimeline.click({
			position: {
				x: Math.round((timelineBounds?.width ?? 1) * 0.4),
				y: Math.round((timelineBounds?.height ?? 1) * 0.5),
			},
		});
		await expect
			.poll(async () => Number(await playbackRange.inputValue()), { timeout: 10_000 })
			.toBeCloseTo(splitTimeSeconds, 2);

		const splitButton = editorWindow.getByRole("button", {
			name: "Split scene at playhead (Ctrl+B)",
		});
		await expect(splitButton).toBeEnabled();
		await splitButton.click();

		const firstSceneButton = editorWindow.getByRole("button", { name: /^Scene 1:/ });
		const secondSceneButton = editorWindow.getByRole("button", { name: /^Scene 2:/ });
		await expect(firstSceneButton).toBeVisible();
		await expect(secondSceneButton).toHaveAttribute("aria-current", "true");
		await expect(editorWindow.getByText("Outside scene", { exact: true })).toBeVisible();
		await expect
			.poll(async () => Number(await playbackRange.inputValue()), { timeout: 10_000 })
			.toBeCloseTo(splitTimeSeconds, 1);

		await editorWindow.getByRole("button", { name: "Project", exact: true }).click();
		await expect
			.poll(async () => Number(await playbackRange.getAttribute("max")), { timeout: 10_000 })
			.toBeCloseTo(sourceDurationSeconds, 2);

		await editorWindow
			.getByRole("button", { name: "Remove cut: Scene 1 + Scene 2", exact: true })
			.click();
		await expect(editorWindow.getByText("Remove this cut?", { exact: true })).toBeVisible();
		await editorWindow.getByRole("button", { name: "Merge scenes", exact: true }).click();

		await expect(secondSceneButton).not.toBeVisible();
		await expect(editorWindow.getByTestId("scene-cut")).toHaveCount(0);
		await expect(editorWindow.getByText("Outside scene", { exact: true })).not.toBeVisible();
		await expect
			.poll(async () => Number(await playbackRange.getAttribute("max")), { timeout: 10_000 })
			.toBeCloseTo(sourceDurationSeconds, 2);
	} finally {
		await closeApp(app);
	}
});
