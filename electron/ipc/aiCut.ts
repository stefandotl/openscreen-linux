import { type BrowserWindow, ipcMain } from "electron";
import type { AiCutRequest } from "../../src/lib/aiCut";
import { requestAiCut } from "../aiCut/openRouter";
import type { OpenRouterSettingsStore } from "../openRouter/settings";
import { authorizeEditor } from "./openRouter";

export function registerAiCutHandlers(
	getEditor: () => BrowserWindow | null,
	settings: OpenRouterSettingsStore,
) {
	const active = new Map<number, { id: string; controller: AbortController }>();
	ipcMain.handle("ai-cut-cancel", (event, id: string) => {
		authorizeEditor(event, getEditor);
		const current = active.get(event.sender.id);
		if (current?.id === id) current.controller.abort();
	});
	ipcMain.handle("ai-cut-analyze", async (event, request: AiCutRequest) => {
		authorizeEditor(event, getEditor);
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
