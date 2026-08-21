import { describe, expect, it } from "vitest";
import { normalizeProjectMedia, normalizeRecordingSession } from "./recordingSession";

describe("webcam offset normalization", () => {
	it("preserves and clamps a project media webcam offset", () => {
		expect(
			normalizeProjectMedia({
				screenVideoPath: "/recordings/screen.webm",
				webcamVideoPath: "/recordings/webcam.webm",
				webcamVideoOffsetMs: 4_000,
			}),
		).toEqual({
			screenVideoPath: "/recordings/screen.webm",
			webcamVideoPath: "/recordings/webcam.webm",
			webcamVideoOffsetMs: 1_000,
		});
	});

	it("normalizes an invalid recording-session offset to zero", () => {
		expect(
			normalizeRecordingSession({
				screenVideoPath: "/recordings/screen.webm",
				webcamVideoPath: "/recordings/webcam.webm",
				webcamVideoOffsetMs: Number.NaN,
				createdAt: 123,
			}),
		).toEqual({
			screenVideoPath: "/recordings/screen.webm",
			webcamVideoPath: "/recordings/webcam.webm",
			webcamVideoOffsetMs: 0,
			createdAt: 123,
		});
	});

	it("keeps legacy media without an offset backward-compatible", () => {
		expect(normalizeProjectMedia({ screenVideoPath: "/recordings/screen.webm" })).toEqual({
			screenVideoPath: "/recordings/screen.webm",
		});
	});
});
