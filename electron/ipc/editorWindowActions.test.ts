// @vitest-environment node
import type { BrowserWindow } from "electron";
import { beforeEach, expect, it, vi } from "vitest";

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle } }));

import { registerEditorWindowActions } from "./editorWindowActions";

beforeEach(() => handle.mockClear());

it("allows only the editor's main frame and known window actions", () => {
	const frame = {};
	const contents = {
		mainFrame: frame,
		copy: vi.fn(),
		setZoomLevel: vi.fn(),
		getZoomLevel: () => 0,
	};
	const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
	registerEditorWindowActions(() => window);
	const action = handle.mock.calls[0][1];
	const event = { sender: contents, senderFrame: frame };
	expect(() => action({ ...event, sender: {} }, "copy")).toThrow("active editor");
	expect(() => action({ ...event, senderFrame: {} }, "copy")).toThrow("active editor");
	expect(() => action(event, "executeJavaScript")).toThrow("Unsupported");
	expect(contents.copy).not.toHaveBeenCalled();
	action(event, "copy");
	expect(contents.copy).toHaveBeenCalledOnce();
	action(event, "zoomIn");
	expect(contents.setZoomLevel).toHaveBeenCalledWith(0.5);
});

it("rejects actions after the editor is closed", () => {
	registerEditorWindowActions(() => null);
	expect(() => handle.mock.calls[0][1]({}, "paste")).toThrow("active editor");
});
