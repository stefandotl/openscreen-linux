import path from "node:path";
import { app, type BrowserWindow, type IpcMainInvokeEvent, ipcMain, safeStorage } from "electron";
import type { AiCutRequest, AiCutSettingsUpdate } from "../../src/lib/aiCut";
import { listAiCutModels, requestAiCut } from "../aiCut/openRouter";
import { AiCutSettingsStore } from "../aiCut/settings";

export function registerAiCutHandlers(getEditor: () => BrowserWindow | null) {
	const settings = new AiCutSettingsStore(
		path.join(app.getPath("userData"), "openrouter.json"),
		safeStorage,
	);
	const active = new Map<number, { id: string; controller: AbortController }>();
	function authorize(event: IpcMainInvokeEvent) {
		const editor = getEditor();
		if (
			!editor ||
			editor.isDestroyed() ||
			event.sender !== editor.webContents ||
			event.senderFrame !== event.sender.mainFrame
		)
			throw new Error("AI Cut requires the active editor.");
	}
	ipcMain.handle("ai-cut-settings", (event) => {
		authorize(event);
		return settings.getSettings();
	});
	ipcMain.handle("ai-cut-update-settings", (event, update: AiCutSettingsUpdate) => {
		authorize(event);
		return settings.update(update);
	});
	ipcMain.handle("ai-cut-models", (event) => {
		authorize(event);
		return listAiCutModels();
	});
	ipcMain.handle("ai-cut-cancel", (event, id: string) => {
		authorize(event);
		const current = active.get(event.sender.id);
		if (current?.id === id) current.controller.abort();
	});
	ipcMain.handle("ai-cut-analyze", async (event, request: AiCutRequest) => {
		authorize(event);
		if (!request || typeof request.requestId !== "string")
			throw new Error("Invalid AI cut request.");
		const senderId = event.sender.id;
		if (active.has(senderId)) throw new Error("An OpenRouter analysis is already running.");
		const controller = new AbortController();
		active.set(senderId, { id: request.requestId, controller });
		const abort = () => controller.abort();
		event.sender.once("destroyed", abort);
		event.sender.once("render-process-gone", abort);
		const timeout = setTimeout(abort, 180_000);
		try {
			return await requestAiCut(request, await settings.credentials(), controller.signal);
		} finally {
			clearTimeout(timeout);
			event.sender.removeListener("destroyed", abort);
			event.sender.removeListener("render-process-gone", abort);
			active.delete(senderId);
		}
	});
}
