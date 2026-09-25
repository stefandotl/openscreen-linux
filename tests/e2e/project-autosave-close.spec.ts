import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("saves a named project when its editor window closes", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-close-save-"));
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
	const child = app.process();
	try {
		const userData = await app.evaluate(({ app }) => app.getPath("userData"));
		const recordings = path.join(userData, "recordings");
		fs.mkdirSync(recordings, { recursive: true });
		const source = path.join(recordings, "source.webm");
		execFileSync("/usr/bin/ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=160x90:d=1",
			"-c:v",
			"libvpx",
			"-y",
			source,
		]);
		const requested = path.join(recordings, "Course");
		await app.evaluate(({ dialog }, filePath) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath });
		}, requested);
		const hud = await app.firstWindow();
		await hud.waitForLoadState("domcontentloaded");
		const saved = await hud.evaluate(
			async (screenVideoPath) =>
				window.electronAPI.saveProjectFile({ version: 2, media: { screenVideoPath }, editor: {} }),
			source,
		);
		expect(saved.success, JSON.stringify(saved)).toBe(true);
		expect(saved.path).toBe(path.join(recordings, "Course", "Course.videtio"));
		const [editor] = await Promise.all([
			app.waitForEvent("window"),
			hud
				.evaluate(() => window.electronAPI.switchToEditor())
				.catch((error) => {
					if (!/closed|destroyed/i.test(String(error))) throw error;
				}),
		]);
		await editor.waitForLoadState("domcontentloaded");
		const languagePrompt = editor.getByRole("button", { name: /Keep current language/i });
		if (await languagePrompt.count()) await languagePrompt.click();
		await expect(editor.getByTestId("project-title")).toHaveText("Course.videtio");
		await editor.getByRole("button", { name: "Rename scene: Scene 1" }).click();
		const sceneName = editor.getByRole("textbox", { name: "Rename scene: Scene 1" });
		await sceneName.fill("Saved on close");
		await sceneName.press("Enter");
		await expect(editor.getByRole("img", { name: "Unsaved Changes" })).toBeVisible();
		const closed = once(child, "close");
		await app
			.evaluate(({ BrowserWindow }) => {
				const window = BrowserWindow.getAllWindows().find((item) =>
					item.webContents.getURL().includes("windowType=editor"),
				);
				if (!window) throw new Error("Editor window is missing");
				window.close();
				window.close();
			})
			.catch((error) => {
				if (!/closed|destroyed|disconnect/i.test(String(error))) throw error;
			});
		await closed;
		const stored = JSON.parse(fs.readFileSync(saved.path!, "utf8"));
		expect(stored.scenes).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "Saved on close" })]),
		);
	} finally {
		const closed =
			child.exitCode === null && child.signalCode === null
				? once(child, "close")
				: Promise.resolve();
		await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
		await closed;
		fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
	}
});

test("keeps an unnamed recording open until its close dialog is answered", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-unnamed-close-"));
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
	const child = app.process();
	try {
		const userData = await app.evaluate(({ app }) => app.getPath("userData"));
		const recordings = path.join(userData, "recordings");
		fs.mkdirSync(recordings, { recursive: true });
		const source = path.join(recordings, "unnamed.webm");
		execFileSync("/usr/bin/ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=160x90:d=1",
			"-c:v",
			"libvpx",
			"-y",
			source,
		]);
		const hud = await app.firstWindow();
		await hud.waitForLoadState("domcontentloaded");
		const opened = await hud.evaluate(
			(file) => window.electronAPI.setCurrentVideoPath(file),
			source,
		);
		expect(opened.success).toBe(true);
		const [editor] = await Promise.all([
			app.waitForEvent("window"),
			hud
				.evaluate(() => window.electronAPI.switchToEditor())
				.catch((error) => {
					if (!/closed|destroyed/i.test(String(error))) throw error;
				}),
		]);
		await editor.waitForLoadState("domcontentloaded");
		const languagePrompt = editor.getByRole("button", { name: /Keep current language/i });
		if (await languagePrompt.count()) await languagePrompt.click();
		await expect(editor.getByRole("button", { name: "Save Project", exact: true })).toBeVisible();
		await app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((item) =>
				item.webContents.getURL().includes("windowType=editor"),
			);
			if (!window) throw new Error("Editor window is missing");
			window.close();
			window.close();
		});
		await expect(editor.getByRole("dialog")).toBeVisible();
		await editor.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(editor.getByRole("dialog")).toHaveCount(0);
		await expect(editor.getByRole("button", { name: "Save Project", exact: true })).toBeVisible();
	} finally {
		const closed =
			child.exitCode === null && child.signalCode === null
				? once(child, "close")
				: Promise.resolve();
		await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
		await closed;
		fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
	}
});
