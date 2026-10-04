// @vitest-environment node
import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTION_TRANSCRIPTION_CHANNELS } from "../../src/lib/captioning/captionTranscriptionProtocol";
import type { OpenRouterSettingsStore } from "../openRouter/settings";

const { handle, transcribe } = vi.hoisted(() => ({ handle: vi.fn(), transcribe: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle }, app: {}, safeStorage: {} }));
vi.mock("../captioning/openRouterTranscription", () => ({ transcribeOpenRouterVideo: transcribe }));

import { registerOpenRouterCaptionHandlers } from "./openRouterCaptions";

beforeEach(() => vi.clearAllMocks());
function setup() {
	const sender = Object.assign(new EventEmitter(), {
		id: 1,
		mainFrame: {},
		isDestroyed: () => false,
		send: vi.fn(),
	});
	const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
	const apiKey = vi.fn().mockResolvedValue("key");
	const resolve = vi.fn((path: string) =>
		path === "file:///approved.mp4" ? "/approved.mp4" : null,
	);
	const run = registerOpenRouterCaptionHandlers({
		getEditor: () => window,
		settings: { apiKey } as unknown as OpenRouterSettingsStore,
		getFfmpegBinary: () => "/ffmpeg",
		resolveApprovedVideoPath: resolve,
	});
	const cancel = handle.mock.calls.find(
		([channel]) => channel === CAPTION_TRANSCRIPTION_CHANNELS.cancel,
	)![1];
	return {
		sender,
		apiKey,
		run,
		cancel,
		event: { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent,
		request: {
			requestId: "first",
			videoPath: "file:///approved.mp4",
			model: "fish-audio/transcribe-1",
			trimRegions: [],
		},
	};
}
describe("OpenRouter captions IPC", () => {
	it("requires the editor main frame, an approved source and a supported timestamp model before accessing keys", async () => {
		const { run, event, request, apiKey } = setup();
		await expect(run({ ...event, senderFrame: {} } as IpcMainInvokeEvent, request)).rejects.toThrow(
			"active editor",
		);
		await expect(run(event, { ...request, videoPath: "/private.txt" })).rejects.toThrow(
			"not approved",
		);
		await expect(run(event, { ...request, model: "openai/gpt-transcribe" })).rejects.toThrow(
			"Invalid",
		);
		await expect(
			run(event, { ...request, trimRegions: [{ id: "bad", startMs: 3, endMs: 2 }] }),
		).rejects.toThrow("Invalid");
		expect(apiKey).not.toHaveBeenCalled();
		expect(transcribe).not.toHaveBeenCalled();
	});
	it.each([
		"cancel",
		"destroyed",
		"render-process-gone",
		"did-start-navigation",
	])("aborts on %s and releases the in-flight request", async (reason) => {
		const { run, cancel, event, request, sender } = setup();
		transcribe.mockImplementation(
			({ signal }: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new Error("aborted"))),
				),
		);
		const pending = run(event, request);
		await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
		await expect(run(event, { ...request, requestId: "second" })).rejects.toThrow(
			"already running",
		);
		if (reason === "cancel") {
			cancel(event, "other");
			expect(transcribe.mock.calls[0][0].signal.aborted).toBe(false);
			cancel(event, request.requestId);
		} else sender.emit(reason);
		await expect(pending).rejects.toThrow("aborted");
		for (const name of ["destroyed", "render-process-gone", "did-start-navigation"])
			expect(sender.listenerCount(name)).toBe(0);
		transcribe.mockResolvedValue({ segments: [], granularity: "word", truncated: false });
		await expect(run(event, { ...request, requestId: "second" })).resolves.toMatchObject({
			segments: [],
		});
	});
});
