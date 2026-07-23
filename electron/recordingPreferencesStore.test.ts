import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecordingPreferencesStore } from "./recordingPreferencesStore";

const temporaryDirectories: string[] = [];

async function createStore() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-recording-prefs-"));
	temporaryDirectories.push(directory);
	const filePath = path.join(directory, "recording-preferences.json");
	return { filePath, store: new RecordingPreferencesStore(filePath) };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("RecordingPreferencesStore", () => {
	it("migrates the renderer fallback once and reloads it from disk", async () => {
		const { filePath, store } = await createStore();
		const fallback = {
			microphoneEnabled: true,
			microphoneDeviceId: "default",
			microphoneDeviceName: "Default",
			systemAudioEnabled: false,
			webcamEnabled: false,
			webcamDeviceId: null,
			webcamDeviceName: null,
			cursorCaptureMode: "editable-overlay",
			captureSource: {
				id: "screen:355:0",
				name: "Bildschirm 2",
				displayId: "3",
				kind: "screen",
			},
		};

		const initialized = await store.initialize(fallback);
		const reloaded = await new RecordingPreferencesStore(filePath).initialize({});

		expect(initialized.exists).toBe(true);
		expect(reloaded.preferences).toEqual(fallback);
	});

	it("serializes partial updates without dropping the selected source", async () => {
		const { store } = await createStore();
		await store.initialize({
			captureSource: {
				id: "screen:1:0",
				name: "Display 1",
				displayId: "1",
				kind: "screen",
			},
		});

		const updated = await store.update({
			microphoneEnabled: true,
			microphoneDeviceId: "mic-1",
		});

		expect(updated.microphoneEnabled).toBe(true);
		expect(updated.microphoneDeviceId).toBe("mic-1");
		expect(updated.captureSource?.id).toBe("screen:1:0");
	});

	it("keeps the first initialized preferences when initialization races", async () => {
		const { store } = await createStore();
		const [first, second] = await Promise.all([
			store.initialize({ microphoneEnabled: true }),
			store.initialize({ microphoneEnabled: false }),
		]);

		expect(first.preferences.microphoneEnabled).toBe(true);
		expect(second.preferences.microphoneEnabled).toBe(true);
	});
});
