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
		await editor.getByRole("button", { name: "Tutorial.videtio", exact: true }).click();
		await expect(editor.getByRole("menuitem", { name: "Collect project…" })).toBeVisible();
		await expect(editor.getByRole("menuitem", { name: "Move project to trash" })).toBeVisible();
		await editor.screenshot({ path: "/tmp/videtio-project-menu.png" });
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
