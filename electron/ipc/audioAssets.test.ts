// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
			handlers.set(channel, handler),
	},
}));

import { registerAudioAssetHandlers, validateAudioPath } from "./audioAssets";

let directory: string | undefined;
afterEach(async () => {
	if (directory) await fs.rm(directory, { recursive: true, force: true });
});

describe("audio import boundary", () => {
	it("rejects remote paths, directories, wrong extensions and missing files", async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "videtio-audio-path-"));
		const wrongFile = path.join(directory, "wrong.txt");
		await fs.writeFile(wrongFile, "data");
		for (const value of [
			"https://example.com/music.mp3",
			"relative.wav",
			directory,
			wrongFile,
			path.join(directory, "missing.wav"),
			"/tmp/bad\0.wav",
		]) {
			await expect(validateAudioPath(value)).rejects.toThrow();
		}
	});
	it("registers the preload channel and returns a visible error for bad input", async () => {
		registerAudioAssetHandlers(() => "/usr/bin/ffmpeg");
		const result = await handlers.get("inspect-audio-file")!({}, "not-absolute.wav");
		expect(result).toMatchObject({ success: false, error: expect.stringContaining("absolute") });
	});
});
