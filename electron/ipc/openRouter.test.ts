// @vitest-environment node
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handle, getSettings, update } = vi.hoisted(() => ({
	handle: vi.fn(),
	getSettings: vi.fn(),
	update: vi.fn(),
}));
vi.mock("electron", () => ({
	ipcMain: { handle },
	app: { getPath: () => "/tmp" },
	safeStorage: {},
}));
vi.mock("../openRouter/settings", () => ({
	OpenRouterSettingsStore: class {
		getSettings = getSettings;
		update = update;
	},
}));
vi.mock("../aiCut/openRouter", () => ({ listAiCutModels: vi.fn() }));

import { registerOpenRouterHandlers } from "./openRouter";

beforeEach(() => vi.clearAllMocks());
describe("shared OpenRouter IPC", () => {
	it("authorizes every shared settings operation before touching stored credentials", () => {
		const sender = { mainFrame: {} };
		registerOpenRouterHandlers(
			() => ({ webContents: sender, isDestroyed: () => false }) as unknown as BrowserWindow,
		);
		for (const [name, handler] of handle.mock.calls) {
			expect(name).toMatch(/^openrouter-/);
			expect(() => handler({ sender, senderFrame: {} }, { apiKey: "private" })).toThrow(
				"active editor",
			);
			expect(() => handler({ sender: {}, senderFrame: sender.mainFrame }, {})).toThrow(
				"active editor",
			);
		}
		expect(getSettings).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});
});
