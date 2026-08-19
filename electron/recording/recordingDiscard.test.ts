import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDiscardDeletionTargets } from "./recordingDiscard";

const recordingsDir = "/home/user/.config/openscreen/recordings";

describe("getDiscardDeletionTargets", () => {
	it("returns screen video, cursor sidecar, and session manifest for a plain recording", () => {
		const screenPath = path.join(recordingsDir, "recording-1700000000000.webm");

		const targets = getDiscardDeletionTargets({ screenVideoPath: screenPath }, recordingsDir);

		expect(targets).toEqual([
			screenPath,
			`${screenPath}.cursor.json`,
			path.join(recordingsDir, "recording-1700000000000.session.json"),
		]);
	});

	it("includes the webcam sidecar when present", () => {
		const screenPath = path.join(recordingsDir, "recording-1700000000000.webm");
		const webcamPath = path.join(recordingsDir, "recording-1700000000000-webcam.webm");

		const targets = getDiscardDeletionTargets(
			{ screenVideoPath: screenPath, webcamVideoPath: webcamPath },
			recordingsDir,
		);

		expect(targets).toContain(webcamPath);
		expect(targets).not.toContain(`${webcamPath}.cursor.json`);
	});

	it("never deletes media that lives outside the recordings directory", () => {
		const screenPath = "/home/user/Videos/imported.mp4";

		const targets = getDiscardDeletionTargets({ screenVideoPath: screenPath }, recordingsDir);

		expect(targets).toEqual([]);
	});

	it("guards against a webcam path pointing outside the recordings directory", () => {
		const screenPath = path.join(recordingsDir, "recording-1700000000000.webm");
		const webcamPath = "/tmp/recording-1700000000000-webcam.webm";

		const targets = getDiscardDeletionTargets(
			{ screenVideoPath: screenPath, webcamVideoPath: webcamPath },
			recordingsDir,
		);

		expect(targets).not.toContain(webcamPath);
		expect(targets).toContain(screenPath);
	});
});
