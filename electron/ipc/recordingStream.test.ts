import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IpcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareRecordingFolder, recordingOutputPath } from "../projectStorage";
import { RecordingStreamRegistry, registerRecordingStreamHandlers } from "./recordingStream";

describe("RecordingStreamRegistry", () => {
	let dir: string;
	const pathFor = (name: string) => path.join(dir, name);

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "videtio-stream-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("streams chunks to disk in order and reports streamed on finalize", async () => {
		const registry = new RecordingStreamRegistry();
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("hello "));
		await registry.append("rec.webm", Buffer.from("world"));

		const streamed = await registry.finalize("rec.webm");

		expect(streamed).toBe(true);
		expect(await readFile(pathFor("rec.webm"), "utf8")).toBe("hello world");
		// A second finalize has nothing to close.
		expect(await registry.finalize("rec.webm")).toBe(false);
	});

	it("reports not-streamed when no stream was opened", async () => {
		const registry = new RecordingStreamRegistry();
		expect(await registry.finalize("missing.webm")).toBe(false);
		expect(registry.has("missing.webm")).toBe(false);
	});

	it("rejects open when the target path is not writable (open is awaited, not assumed)", async () => {
		const registry = new RecordingStreamRegistry();
		// Parent directory does not exist, so createWriteStream emits 'error' on open.
		await expect(
			registry.open("rec.webm", path.join(dir, "does-not-exist", "rec.webm")),
		).rejects.toThrow();
		// A failed open must not register a stream the renderer would treat as live.
		expect(registry.has("rec.webm")).toBe(false);
	});

	it("rejects append when no stream is open", async () => {
		const registry = new RecordingStreamRegistry();
		await expect(registry.append("rec.webm", Buffer.from("x"))).rejects.toThrow(
			/No active recording stream/,
		);
	});

	it("discard closes the stream and removes the partial file", async () => {
		const registry = new RecordingStreamRegistry();
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("partial"));

		await registry.discard("rec.webm", pathFor("rec.webm"));

		expect(registry.has("rec.webm")).toBe(false);
		await expect(stat(pathFor("rec.webm"))).rejects.toThrow();
		// Nothing left to finalize after a discard.
		expect(await registry.finalize("rec.webm")).toBe(false);
	});

	it("discard tolerates a missing file", async () => {
		const registry = new RecordingStreamRegistry();
		await expect(registry.discard("never.webm", pathFor("never.webm"))).resolves.toBeUndefined();
	});

	it("close-recording-stream removes the discarded recording folder", async () => {
		const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
		const ipcMain = {
			handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
				handlers.set(channel, handler);
			},
		} as unknown as IpcMain;
		const fileName = "recording-123.webm";
		const filePath = recordingOutputPath(dir, fileName);
		await prepareRecordingFolder(filePath);
		const registry = new RecordingStreamRegistry();
		registerRecordingStreamHandlers(ipcMain, registry, (name) => recordingOutputPath(dir, name));
		await registry.open(fileName, filePath);
		await registry.append(fileName, Buffer.from("partial"));

		expect(await handlers.get("close-recording-stream")?.({}, fileName)).toEqual({
			success: true,
		});
		await expect(stat(path.dirname(filePath))).rejects.toThrow();
	});

	it("opening the same file twice replaces the prior stream", async () => {
		const registry = new RecordingStreamRegistry();
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("first"));
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("second"));
		await registry.finalize("rec.webm");

		expect(await readFile(pathFor("rec.webm"), "utf8")).toBe("second");
	});
});
