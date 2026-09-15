import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("project folders round trip through Electron and trash only after confirmation", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-project-e2e-"));
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
	const clipboardSnapshot = await app.evaluate(({ clipboard }) => ({
		text: clipboard.readText(),
		html: clipboard.readHTML(),
		rtf: clipboard.readRTF(),
		image: clipboard.readImage().toDataURL(),
	}));
	try {
		const userData = await app.evaluate(({ app }) => app.getPath("userData"));
		expect(userData.startsWith(directory)).toBe(true);
		const recordings = path.join(userData, "recordings");
		fs.mkdirSync(recordings, { recursive: true });
		const source = path.join(recordings, "legacy.webm");
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
		fs.writeFileSync(`${source}.cursor.json`, JSON.stringify({ version: 2, samples: [] }));
		const requested = path.join(recordings, "Demo.videtio");
		await app.evaluate(({ dialog }, filePath) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath });
		}, requested);
		const page = await app.firstWindow();
		await page.waitForLoadState("domcontentloaded");
		const saved = await page.evaluate(
			async (screenVideoPath) =>
				window.electronAPI.saveProjectFile({ version: 2, media: { screenVideoPath }, editor: {} }),
			source,
		);
		expect(saved.success, JSON.stringify(saved)).toBe(true);
		expect(saved.path).toBe(path.join(recordings, "Demo", "Demo.videtio"));
		expect(fs.existsSync(source)).toBe(true);
		const originalProject = JSON.parse(fs.readFileSync(saved.path!, "utf8"));
		expect(originalProject.media.screenVideoPath.startsWith("./assets/")).toBe(true);
		const moved = path.join(directory, "Moved project");
		fs.renameSync(path.dirname(saved.path!), moved);
		const movedProjectPath = path.join(moved, "Demo.videtio");
		const loaded = await page.evaluate(
			async (file) => window.electronAPI.loadProjectFileFromPath(file),
			movedProjectPath,
		);
		expect(loaded.success, JSON.stringify(loaded)).toBe(true);
		const project = loaded.project as { media: { screenVideoPath: string } };
		expect(project.media.screenVideoPath.startsWith(moved)).toBe(true);
		const resaved = await page.evaluate(
			async ({ data, file }) => window.electronAPI.saveProjectFile(data, undefined, file),
			{ data: loaded.project, file: movedProjectPath },
		);
		expect(resaved.success, JSON.stringify(resaved)).toBe(true);
		// Verify cancellation and failure do not clear the active project or delete files.
		await app.evaluate(({ dialog }) => {
			dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
		});
		const canceled = await page.evaluate(() => window.electronAPI.trashCurrentProject());
		expect(canceled.canceled).toBe(true);
		expect(fs.existsSync(movedProjectPath)).toBe(true);
		await app.evaluate(({ dialog, shell }) => {
			dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
			shell.trashItem = async () => {
				throw new Error("Test trash unavailable");
			};
		});
		const failed = await page.evaluate(() => window.electronAPI.trashCurrentProject());
		expect(failed.success).toBe(false);
		expect(fs.existsSync(movedProjectPath)).toBe(true);
		// Use a temporary test trash destination; never touch the user's actual trash.
		const testTrash = path.join(directory, "test-trash");
		await app.evaluate(async ({ shell }, target) => {
			const fs = process.getBuiltinModule("fs").promises;
			shell.trashItem = async (source) => {
				await fs.rename(source, target);
			};
		}, testTrash);
		const trashed = await page.evaluate(() => window.electronAPI.trashCurrentProject());
		expect(trashed.success, JSON.stringify(trashed)).toBe(true);
		expect(fs.existsSync(movedProjectPath)).toBe(false);
		expect(fs.existsSync(path.join(testTrash, "Demo.videtio"))).toBe(true);
		expect(fs.existsSync(source)).toBe(true);
		expect((await page.evaluate(() => window.electronAPI.loadCurrentProjectFile())).success).toBe(
			false,
		);

		const recordingName = `recording-${Date.now()}.webm`;
		const stored = await page.evaluate(
			async ({ bytes, name }) => {
				return window.electronAPI.storeRecordedSession({
					screen: { fileName: name, videoData: new Uint8Array(bytes).buffer },
					cursorCaptureMode: "system",
				});
			},
			{ bytes: Array.from(fs.readFileSync(source)), name: recordingName },
		);
		expect(stored.success, JSON.stringify(stored)).toBe(true);
		const recordingPath = stored.path!;
		expect(path.dirname(recordingPath)).toBe(path.join(recordings, path.parse(recordingName).name));
		const sessionFile = path.join(
			path.dirname(recordingPath),
			`${path.parse(recordingName).name}.session.json`,
		);
		expect(JSON.parse(fs.readFileSync(sessionFile, "utf8")).screenVideoPath).toBe(recordingName);
		await app.evaluate(
			({ dialog }, filePath) => {
				dialog.showSaveDialog = async () => ({ canceled: false, filePath });
			},
			path.join(path.dirname(recordingPath), "Tutorial.videtio"),
		);
		const adopted = await page.evaluate(
			async (screenVideoPath) =>
				window.electronAPI.saveProjectFile({ version: 2, media: { screenVideoPath }, editor: {} }),
			recordingPath,
		);
		expect(adopted.success, JSON.stringify(adopted)).toBe(true);
		expect(adopted.path).toBe(path.join(recordings, "Tutorial", "Tutorial.videtio"));
		expect(fs.existsSync(path.join(recordings, "Tutorial", recordingName))).toBe(true);
		expect(fs.existsSync(path.dirname(recordingPath))).toBe(false);
		const [editor] = await Promise.all([
			app.waitForEvent("window"),
			page
				.evaluate(() => window.electronAPI.switchToEditor())
				.catch((error) => {
					// Switching windows closes the HUD before its IPC response returns.
					if (!/closed|destroyed/i.test(String(error))) throw error;
				}),
		]);
		await editor.waitForLoadState("domcontentloaded");
		const languagePrompt = editor.getByRole("button", { name: /Keep current language/i });
		if (await languagePrompt.count()) await languagePrompt.click();
		await expect(editor.getByTestId("project-title")).toHaveText("Tutorial.videtio");
		const nativeMenu = await app.evaluate(({ BrowserWindow, Menu }) => {
			const window = BrowserWindow.getAllWindows().find((window) =>
				window.webContents.getURL().includes("windowType=editor"),
			);
			if (!window) throw new Error("Editor window is missing");
			return {
				visible: window.isMenuBarVisible(),
				accelerators: Menu.getApplicationMenu()?.items.flatMap(
					(item) => item.submenu?.items.map((child) => child.accelerator) ?? [],
				),
			};
		});
		if (process.platform !== "darwin") expect(nativeMenu.visible).toBe(false);
		expect(nativeMenu.accelerators).toEqual(
			expect.arrayContaining(["CmdOrCtrl+O", "CmdOrCtrl+S", "CmdOrCtrl+Shift+S"]),
		);
		await editor.getByRole("button", { name: "File", exact: true }).click();
		await expect(editor.getByRole("menuitem", { name: /Save Project As/ })).toBeVisible();
		await expect(editor.getByRole("menuitem", { name: "Move project to trash" })).toBeVisible();
		await editor.screenshot({ path: "/tmp/videtio-project-menu.png", animations: "disabled" });
		await editor.keyboard.press("Escape");
		await expect(editor.getByTestId("editor-titlebar").getByRole("button")).toHaveCount(5);
		await app.evaluate(async ({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((window) =>
				window.webContents.getURL().includes("windowType=editor"),
			);
			if (!window) throw new Error("Editor window is missing");
			if (window.isMaximized()) {
				await new Promise<void>((resolve) => {
					window.once("unmaximize", () => resolve());
					window.unmaximize();
				});
			}
			window.setSize(800, 720);
		});
		await expect.poll(() => editor.evaluate(() => window.innerWidth)).toBe(800);
		await expect
			.poll(async () => (await editor.getByTestId("editor-titlebar").boundingBox())?.width)
			.toBe(800);
		await editor.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);
		const titlebar = editor.getByTestId("editor-titlebar");
		const saveBounds = await titlebar
			.getByRole("button", { name: "Save Project", exact: true })
			.boundingBox();
		expect(saveBounds!.x + saveBounds!.width).toBeLessThanOrEqual(800);
		await editor.screenshot({ path: "/tmp/videtio-titlebar-compact.png", animations: "disabled" });
		await editor.getByRole("button", { name: "Settings", exact: true }).click();
		await editor.getByRole("menuitem", { name: "Language", exact: true }).hover();
		await expect(
			editor.getByRole("menuitemradio", { name: "English", exact: true }),
		).toHaveAttribute("aria-checked", "true");
		await editor.mouse.move(400, 22);
		await editor.keyboard.press("Escape");
		await expect(editor.getByRole("menuitemradio", { name: "English", exact: true })).toHaveCount(
			0,
		);
		await editor.keyboard.press("Escape");
		await expect(editor.getByRole("menuitem", { name: "Language", exact: true })).toHaveCount(0);
		await editor.getByRole("button", { name: "Rename scene: Scene 1", exact: true }).click();
		const sceneName = editor.getByRole("textbox", { name: "Rename scene: Scene 1", exact: true });
		await sceneName.fill("Alpha Beta");
		await sceneName.evaluate((element) => (element as HTMLInputElement).setSelectionRange(0, 5));
		await editor.getByRole("button", { name: "Edit", exact: true }).click();
		await editor.getByRole("menuitem", { name: /^Copy/ }).click();
		await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("Alpha");
		await editor.getByRole("button", { name: "Edit", exact: true }).click();
		await editor.getByRole("menuitem", { name: /^Cut/ }).click();
		await expect(sceneName).toHaveValue(" Beta");
		await editor.getByRole("button", { name: "Edit", exact: true }).click();
		await editor.getByRole("menuitem", { name: /^Paste/ }).click();
		await expect(sceneName).toHaveValue("Alpha Beta");
		await editor.getByRole("button", { name: "Edit", exact: true }).click();
		await editor.getByRole("menuitem", { name: /^Undo/ }).click();
		await expect(sceneName).toHaveValue(" Beta");
		await editor.getByRole("button", { name: "Edit", exact: true }).click();
		await editor.getByRole("menuitem", { name: /^Redo/ }).click();
		await expect(sceneName).toHaveValue("Alpha Beta");
		await editor.getByRole("button", { name: "Edit", exact: true }).click();
		await editor.getByRole("menuitem", { name: /^Select All/ }).click();
		await expect
			.poll(() =>
				sceneName.evaluate((element) => {
					const input = element as HTMLInputElement;
					return [input.selectionStart, input.selectionEnd];
				}),
			)
			.toEqual([0, 10]);
		await sceneName.press("Escape");
		const getZoom = () =>
			app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()
					.find((window) => window.webContents.getURL().includes("windowType=editor"))!
					.webContents.getZoomLevel(),
			);
		await editor.getByRole("button", { name: "View", exact: true }).click();
		await editor.getByRole("menuitem", { name: "Zoom In", exact: true }).click();
		await expect.poll(getZoom).toBe(0.5);
		await editor.getByRole("button", { name: "View", exact: true }).click();
		await editor.getByRole("menuitem", { name: "Zoom Out", exact: true }).click();
		await expect.poll(getZoom).toBe(0);
		await editor.getByRole("button", { name: "View", exact: true }).click();
		await editor.getByRole("menuitem", { name: "Zoom In", exact: true }).click();
		await expect.poll(getZoom).toBe(0.5);
		await editor.getByRole("button", { name: "View", exact: true }).click();
		await editor.getByRole("menuitem", { name: "Actual Size", exact: true }).click();
		await expect.poll(getZoom).toBe(0);
		await editor.getByRole("button", { name: "View", exact: true }).click();
		await editor.getByRole("menuitem", { name: "Toggle Full Screen", exact: true }).click();
		await expect
			.poll(() =>
				app.evaluate(({ BrowserWindow }) =>
					BrowserWindow.getAllWindows()
						.find((window) => window.webContents.getURL().includes("windowType=editor"))!
						.isFullScreen(),
				),
			)
			.toBe(true);
	} finally {
		await app.evaluate(
			({ clipboard, nativeImage }, snapshot) =>
				clipboard.write({
					text: snapshot.text,
					html: snapshot.html,
					rtf: snapshot.rtf,
					image: nativeImage.createFromDataURL(snapshot.image),
				}),
			clipboardSnapshot,
		);
		const child = app.process();
		const closed =
			child.exitCode === null && child.signalCode === null
				? once(child, "close")
				: Promise.resolve();
		await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
		await closed;
		fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
	}
});

test("keeps screen and webcam preview usable when saving and reopening a renamed project", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-live-rename-"));
	const env = { ...process.env, XDG_CONFIG_HOME: directory };
	delete env.ELECTRON_RUN_AS_NODE;
	const launch = () =>
		electron.launch({
			args: [
				path.resolve("dist-electron/main.js"),
				"--no-sandbox",
				`--user-data-dir=${directory}/profile`,
			],
			env,
		});
	let app = await launch();
	try {
		const fixture = path.join(directory, "fixture.webm");
		execFileSync("/usr/bin/ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=s=320x180:r=15:d=3",
			"-c:v",
			"libvpx",
			"-y",
			fixture,
		]);
		const hud = await app.firstWindow();
		await hud.waitForLoadState("domcontentloaded");
		const recordingName = `recording-${Date.now()}`;
		const stored = await hud.evaluate(
			async ({ bytes, name }) =>
				window.electronAPI.storeRecordedSession({
					screen: { fileName: `${name}.webm`, videoData: new Uint8Array(bytes).buffer },
					webcam: { fileName: `${name}-webcam.webm`, videoData: new Uint8Array(bytes).buffer },
					cursorCaptureMode: "system",
				}),
			{ bytes: Array.from(fs.readFileSync(fixture)), name: recordingName },
		);
		expect(stored.success, JSON.stringify(stored)).toBe(true);
		const recordingPath = stored.path!;
		const [editor] = await Promise.all([
			app.waitForEvent("window"),
			hud
				.evaluate(() => window.electronAPI.switchToEditor())
				.catch((error) => {
					if (!/closed|destroyed/i.test(String(error))) throw error;
				}),
		]);
		await editor.waitForLoadState("domcontentloaded");
		const prompt = editor.getByRole("button", { name: /Keep current language/i });
		if (await prompt.count()) await prompt.click();
		await expect
			.poll(() =>
				editor
					.locator("video")
					.evaluateAll(
						(elements) => elements.filter((e) => (e as HTMLVideoElement).readyState >= 2).length,
					),
			)
			.toBeGreaterThanOrEqual(2);
		await app.evaluate(
			({ dialog }, filePath) => {
				dialog.showSaveDialog = async () => ({ canceled: false, filePath });
			},
			path.join(path.dirname(recordingPath), "Named project.videtio"),
		);
		await expect(editor.getByTestId("editor-titlebar").getByRole("button")).toHaveCount(5);
		await editor.getByRole("button", { name: "File", exact: true }).click();
		await expect(
			editor.getByRole("menuitem", { name: "Discard recording", exact: true }),
		).toBeVisible();
		await expect(
			editor.getByRole("menuitem", { name: "Move project to trash", exact: true }),
		).toHaveCount(0);
		await expect(editor.getByRole("menuitem", { name: /Save Project As/ })).toHaveCount(0);
		await editor.keyboard.press("Escape");
		await editor.getByRole("button", { name: "Save Project", exact: true }).click();
		await expect(editor.getByTestId("project-title")).toHaveText("Named project.videtio");
		await expect(editor.getByRole("button", { name: "Save Project", exact: true })).toBeDisabled();
		await expect(editor.getByRole("img", { name: "Unsaved Changes", exact: true })).toHaveCount(0);
		await expect
			.poll(() =>
				editor
					.locator("video")
					.evaluateAll(
						(elements) => elements.filter((e) => (e as HTMLVideoElement).readyState >= 2).length,
					),
			)
			.toBeGreaterThanOrEqual(2);
		const projectPath = path.join(
			path.dirname(path.dirname(recordingPath)),
			"Named project",
			"Named project.videtio",
		);
		// A missing old path with unsaved edits must still allow opening another project.
		await editor.keyboard.press("z");
		await editor.getByRole("button", { name: "Edit", exact: true }).click();
		await editor.getByRole("menuitem", { name: /^Undo/ }).click();
		await expect(editor.getByRole("img", { name: "Unsaved Changes", exact: true })).toHaveCount(0);
		await editor.getByRole("button", { name: "Edit", exact: true }).click();
		await editor.getByRole("menuitem", { name: /^Redo/ }).click();
		await expect(editor.getByRole("button", { name: "Save Project", exact: true })).toBeEnabled();
		await expect(editor.getByRole("img", { name: "Unsaved Changes", exact: true })).toBeVisible();
		await editor.locator("video.hidden").evaluate((element) => {
			element.setAttribute("src", "file:///tmp/videtio-intentionally-missing-preview.webm");
			(element as HTMLVideoElement).load();
		});
		await expect(editor.getByText("Failed to load video", { exact: true })).toBeVisible();
		const movedFolder = path.join(directory, "Renamed folder");
		fs.renameSync(path.dirname(projectPath), movedFolder);
		const movedProject = path.join(movedFolder, "Renamed file.videtio");
		fs.renameSync(path.join(movedFolder, "Named project.videtio"), movedProject);
		await app.evaluate(({ dialog }, file) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
		}, movedProject);
		await editor.getByRole("button", { name: "Load Project", exact: true }).click();
		await expect(editor.getByRole("dialog")).toBeVisible();
		await editor.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(editor.getByText("Failed to load video", { exact: true })).toBeVisible();
		await editor.getByRole("button", { name: "Load Project", exact: true }).click();
		await editor.getByRole("button", { name: "Discard & Load Project", exact: true }).click();
		await expect(editor.getByTestId("project-title")).toHaveText("Renamed file.videtio");
		await expect
			.poll(() =>
				editor
					.locator("video")
					.evaluateAll(
						(elements) => elements.filter((e) => (e as HTMLVideoElement).readyState >= 2).length,
					),
			)
			.toBeGreaterThanOrEqual(2);
		expect(
			await editor
				.locator("video")
				.evaluateAll((elements) => elements.map((e) => (e as HTMLVideoElement).currentSrc)),
		).toEqual(expect.arrayContaining([expect.stringContaining("Renamed%20folder")]));
		await expect(editor.getByText("Failed to load video", { exact: true })).toHaveCount(0);
		await editor.keyboard.press("z");
		await expect(editor.getByRole("button", { name: "Save Project", exact: true })).toBeEnabled();
		await expect(editor.getByRole("img", { name: "Unsaved Changes", exact: true })).toBeVisible();
		await editor.locator("video.hidden").evaluate((element) => {
			element.setAttribute("src", "file:///tmp/videtio-intentionally-missing-preview.webm");
			(element as HTMLVideoElement).load();
		});
		await expect(editor.getByText("Failed to load video", { exact: true })).toBeVisible();
		await app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((window) =>
				window.webContents.getURL().includes("windowType=editor"),
			);
			if (!window) throw new Error("Editor window is missing");
			window.webContents.send("menu-new-project");
		});
		await editor.getByRole("button", { name: "Discard & New Project", exact: true }).click();
		await expect(editor.getByText("Failed to load video", { exact: true })).toHaveCount(0);
		await expect(editor.getByRole("button", { name: "Load Project…", exact: true })).toBeVisible();

		// Restart without making a new recording, then load from the empty editor.
		const firstProcess = app.process();
		const firstClosed = once(firstProcess, "close");
		await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
		await firstClosed;
		app = await launch();
		const freshHud = await app.firstWindow();
		await freshHud.waitForLoadState("domcontentloaded");
		const [freshEditor] = await Promise.all([
			app.waitForEvent("window"),
			freshHud
				.evaluate(() => window.electronAPI.switchToEditor())
				.catch((error) => {
					if (!/closed|destroyed/i.test(String(error))) throw error;
				}),
		]);
		await freshEditor.waitForLoadState("domcontentloaded");
		await expect(freshEditor.getByText("Failed to load video", { exact: true })).toHaveCount(0);
		await app.evaluate(({ dialog }, file) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
		}, movedProject);
		await expect(freshEditor.getByTestId("editor-titlebar").getByRole("button")).toHaveCount(4);
		await freshEditor.getByRole("button", { name: "File", exact: true }).click();
		await expect(freshEditor.getByRole("menuitem", { name: /^Save Project/ })).toBeDisabled();
		await expect(
			freshEditor.getByRole("menuitem", { name: /Discard recording|Move project to trash/ }),
		).toHaveCount(0);
		await freshEditor.getByRole("menuitem", { name: /^Load Project/ }).click();
		await expect(freshEditor.getByTestId("project-title")).toHaveText("Renamed file.videtio");
		await expect
			.poll(() =>
				freshEditor
					.locator("video")
					.evaluateAll(
						(elements) => elements.filter((e) => (e as HTMLVideoElement).readyState >= 2).length,
					),
			)
			.toBeGreaterThanOrEqual(2);
	} finally {
		const child = app.process();
		const closed =
			child.exitCode === null && child.signalCode === null
				? once(child, "close")
				: Promise.resolve();
		await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
		await closed;
		fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
	}
});
