import path from "node:path";
import { app, type BrowserWindow, type IpcMainInvokeEvent, ipcMain, safeStorage } from "electron";
import type { OpenRouterSettingsUpdate } from "../../src/lib/openRouter";
import { listAiCutModels } from "../aiCut/openRouter";
import { OpenRouterSettingsStore } from "../openRouter/settings";

export function authorizeEditor(event: IpcMainInvokeEvent, getEditor: () => BrowserWindow | null) {
	const editor = getEditor();
	if (
		!editor ||
		editor.isDestroyed() ||
		event.sender !== editor.webContents ||
		event.senderFrame !== event.sender.mainFrame
	)
		throw new Error("OpenRouter requires the active editor.");
}

export function registerOpenRouterHandlers(getEditor: () => BrowserWindow | null) {
	const settings = new OpenRouterSettingsStore(
		path.join(app.getPath("userData"), "openrouter.json"),
		safeStorage,
	);
	ipcMain.handle("openrouter-settings", (event) => {
		authorizeEditor(event, getEditor);
		return settings.getSettings();
	});
	ipcMain.handle("openrouter-update-settings", (event, update: OpenRouterSettingsUpdate) => {
		authorizeEditor(event, getEditor);
		return settings.update(update);
	});
	ipcMain.handle("openrouter-ai-cut-models", (event) => {
		authorizeEditor(event, getEditor);
		return listAiCutModels();
	});
	return settings;
}
