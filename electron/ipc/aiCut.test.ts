// @vitest-environment node
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handle, getSettings, credentials, requestAiCut } = vi.hoisted(() => ({
	handle: vi.fn(),
	getSettings: vi.fn(),
	credentials: vi.fn(),
	requestAiCut: vi.fn(),
}));
vi.mock("electron", () => ({
	ipcMain: { handle },
	app: { getPath: () => "/tmp" },
	safeStorage: {},
}));
vi.mock("../aiCut/settings", () => ({
	AiCutSettingsStore: class {
		getSettings = getSettings;
		credentials = credentials;
	},
}));
vi.mock("../aiCut/openRouter", () => ({ requestAiCut, listAiCutModels: vi.fn() }));

import { registerAiCutHandlers } from "./aiCut";

beforeEach(() => {
	vi.clearAllMocks();
	credentials.mockResolvedValue({ apiKey: "key", model: "a/b" });
});
function setup() {
	const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {} });
	const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
	registerAiCutHandlers(() => window);
	const handler = (name: string) => handle.mock.calls.find((call) => call[0] === name)?.[1];
	return { sender, handler, event: { sender, senderFrame: sender.mainFrame } };
}
describe("AI Cut IPC", () => {
	it("restricts settings, requests and cancellation to the editor's main frame", () => {
		const { handler, event } = setup();
		for (const channel of [
			"ai-cut-settings",
			"ai-cut-update-settings",
			"ai-cut-models",
			"ai-cut-cancel",
		]) {
			expect(() => handler(channel)({ ...event, senderFrame: {} })).toThrow("active editor");
			expect(() => handler(channel)({ ...event, sender: {} })).toThrow("active editor");
		}
		expect(getSettings).not.toHaveBeenCalled();
	});
	it("aborts only the matching request and cleans up listeners and in-flight state", async () => {
		const { handler, event, sender } = setup();
		let signal: AbortSignal;
		requestAiCut.mockImplementation((_request, _credentials, received: AbortSignal) => {
			signal = received;
			return new Promise((_resolve, reject) =>
				received.addEventListener("abort", () => reject(new Error("aborted"))),
			);
		});
		const pending = handler("ai-cut-analyze")(event, { requestId: "first" });
		await vi.waitFor(() => expect(requestAiCut).toHaveBeenCalledOnce());
		await expect(handler("ai-cut-analyze")(event, { requestId: "second" })).rejects.toThrow(
			"already running",
		);
		handler("ai-cut-cancel")(event, "other");
		expect(signal!.aborted).toBe(false);
		handler("ai-cut-cancel")(event, "first");
		await expect(pending).rejects.toThrow("aborted");
		expect(sender.listenerCount("destroyed")).toBe(0);
		expect(sender.listenerCount("render-process-gone")).toBe(0);
		requestAiCut.mockResolvedValue([]);
		await expect(handler("ai-cut-analyze")(event, { requestId: "second" })).resolves.toEqual([]);
	});
});
