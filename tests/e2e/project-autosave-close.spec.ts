import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("offers to save a named project before closing and updates its existing file", async () => {
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
		const projectDirectory = path.dirname(saved.path!);
		fs.writeFileSync(
			path.join(projectDirectory, ".videtio-folder.json"),
			JSON.stringify({ kind: "videtio-project", version: 1, projectFile: "Course" }),
		);
		const nestedDirectory = path.join(projectDirectory, "Course");
		fs.mkdirSync(nestedDirectory);
		fs.writeFileSync(path.join(nestedDirectory, "keep.txt"), "untouched");
		await app.evaluate(({ dialog }) => {
			dialog.showSaveDialog = async () => {
				throw new Error("Saving an existing project must not open Save As");
			};
		});
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
		await expect(editor.getByRole("dialog", { name: "Unsaved Changes" })).toBeVisible();
		await expect(editor.getByTestId("project-title")).toHaveText("Course.videtio");
		await editor.getByRole("button", { name: "Save & Close" }).click();
		await closed;
		const stored = JSON.parse(fs.readFileSync(saved.path!, "utf8"));
		expect(stored.scenes).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "Saved on close" })]),
		);
		expect(
			JSON.parse(fs.readFileSync(path.join(projectDirectory, ".videtio-folder.json"), "utf8"))
				.projectFile,
		).toBe("Course.videtio");
		expect(fs.readFileSync(path.join(nestedDirectory, "keep.txt"), "utf8")).toBe("untouched");
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

test("lets a named project close without saving the latest edits", async () => {
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
		const requested = path.join(recordings, "Already saved.videtio");
		await app.evaluate(({ dialog }, filePath) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath });
		}, requested);
		await editor.getByRole("button", { name: "Save Project", exact: true }).click();
		await expect(editor.getByTestId("project-title")).toHaveText("Already saved.videtio");
		await expect(editor.getByRole("img", { name: "Unsaved Changes" })).toHaveCount(0);
		const savedPath = path.join(recordings, "Already saved", "Already saved.videtio");
		const savedData = fs.readFileSync(savedPath, "utf8");
		await editor.getByRole("button", { name: "Rename scene: Scene 1" }).click();
		const sceneName = editor.getByRole("textbox", { name: "Rename scene: Scene 1" });
		await sceneName.fill("Discard this edit");
		await sceneName.press("Enter");
		await expect(editor.getByRole("img", { name: "Unsaved Changes" })).toBeVisible();
		const closedAfterDiscard = once(child, "close");
		await app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((item) =>
				item.webContents.getURL().includes("windowType=editor"),
			);
			if (!window) throw new Error("Editor window is missing");
			window.close();
		});
		await expect(editor.getByRole("dialog", { name: "Unsaved Changes" })).toBeVisible();
		await editor.getByRole("button", { name: "Discard & Close" }).click();
		await closedAfterDiscard;
		expect(fs.readFileSync(savedPath, "utf8")).toBe(savedData);
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

test("closes a saved project without another prompt or save", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-clean-close-"));
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
		const requested = path.join(recordings, "Ready.videtio");
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
		await expect(editor.getByTestId("project-title")).toHaveText("Ready.videtio");
		await expect(editor.getByRole("img", { name: "Unsaved Changes" })).toHaveCount(0);
		const closed = once(child, "close");
		await app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((item) =>
				item.webContents.getURL().includes("windowType=editor"),
			);
			if (!window) throw new Error("Editor window is missing");
			window.close();
		});
		await closed;
		expect(fs.existsSync(saved.path!)).toBe(true);
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
