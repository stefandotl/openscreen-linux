import { type BrowserWindow, ipcMain } from "electron";

export function registerEditorWindowActions(getEditorWindow: () => BrowserWindow | null) {
	ipcMain.handle("editor-window-action", (event, action: unknown) => {
		const window = getEditorWindow();
		if (
			!window ||
			window.isDestroyed() ||
			event.sender !== window.webContents ||
			event.senderFrame !== event.sender.mainFrame
		) {
			throw new Error("Editor window action requires the active editor");
		}
		const contents = window.webContents;
		switch (action) {
			case "undo":
				contents.undo();
				break;
			case "redo":
				contents.redo();
				break;
			case "cut":
				contents.cut();
				break;
			case "copy":
				contents.copy();
				break;
			case "paste":
				contents.paste();
				break;
			case "selectAll":
				contents.selectAll();
				break;
			case "zoomIn":
				contents.setZoomLevel(Math.min(3, contents.getZoomLevel() + 0.5));
				break;
			case "zoomOut":
				contents.setZoomLevel(Math.max(-3, contents.getZoomLevel() - 0.5));
				break;
			case "resetZoom":
				contents.setZoomLevel(0);
				break;
			case "toggleFullScreen":
				window.setFullScreen(!window.isFullScreen());
				break;
			default:
				throw new Error(`Unsupported editor window action: ${String(action)}`);
		}
	});
}
