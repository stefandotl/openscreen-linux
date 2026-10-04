import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
import {
	CAPTION_TRANSCRIPTION_CHANNELS,
	type CaptionTranscriptionRequest,
} from "../../src/lib/captioning/captionTranscriptionProtocol";
import { isOpenRouterCaptionModel } from "../../src/lib/openRouter";
import { transcribeOpenRouterVideo } from "../captioning/openRouterTranscription";
import type { OpenRouterSettingsStore } from "../openRouter/settings";
import { authorizeEditor } from "./openRouter";

export function registerOpenRouterCaptionHandlers(options: {
	getEditor(): BrowserWindow | null;
	getFfmpegBinary(): string;
	resolveApprovedVideoPath(path: string): string | null;
	settings: OpenRouterSettingsStore;
}) {
	const active = new Map<number, { id: string; controller: AbortController }>();
	ipcMain.handle(CAPTION_TRANSCRIPTION_CHANNELS.cancel, (event, id: string) => {
		authorizeEditor(event, options.getEditor);
		const current = active.get(event.sender.id);
		if (current?.id === id) current.controller.abort();
	});
	return async (event: IpcMainInvokeEvent, request: CaptionTranscriptionRequest) => {
		authorizeEditor(event, options.getEditor);
		if (
			!request ||
			typeof request.requestId !== "string" ||
			!/^[\w-]{1,100}$/.test(request.requestId) ||
			!isOpenRouterCaptionModel(request.model) ||
			typeof request.videoPath !== "string" ||
			!Array.isArray(request.trimRegions) ||
			request.trimRegions.some(
				(r) =>
					!r ||
					!Number.isFinite(r.startMs) ||
					!Number.isFinite(r.endMs) ||
					r.startMs < 0 ||
					r.endMs <= r.startMs,
			) ||
			(request.sourceDurationSec !== undefined &&
				(!Number.isFinite(request.sourceDurationSec) || request.sourceDurationSec <= 0))
		)
			throw new Error("Invalid OpenRouter caption request.");
		const videoPath = options.resolveApprovedVideoPath(request.videoPath);
		if (!videoPath)
			throw new Error("Caption source path is not approved or is not a supported video file.");
		const senderId = event.sender.id;
		if (active.has(senderId))
			throw new Error("An OpenRouter caption transcription is already running.");
		const controller = new AbortController();
		active.set(senderId, { id: request.requestId, controller });
		const abort = () => controller.abort();
		event.sender.once("destroyed", abort);
		event.sender.once("render-process-gone", abort);
		event.sender.once("did-start-navigation", abort);
		try {
			const apiKey = await options.settings.apiKey();
			controller.signal.throwIfAborted();
			const sendProgress = (percent?: number) => {
				if (!event.sender.isDestroyed())
					event.sender.send(CAPTION_TRANSCRIPTION_CHANNELS.status, {
						requestId: request.requestId,
						phase: "transcribe",
						percent,
					});
			};
			sendProgress();
			return await transcribeOpenRouterVideo({
				...request,
				model: request.model!,
				videoPath,
				apiKey,
				ffmpegBinary: options.getFfmpegBinary(),
				signal: controller.signal,
				onProgress: sendProgress,
			});
		} finally {
			event.sender.removeListener("destroyed", abort);
			event.sender.removeListener("render-process-gone", abort);
			event.sender.removeListener("did-start-navigation", abort);
			active.delete(senderId);
		}
	};
}
