import { describe, expect, it } from "vitest";
import { resolveFfmpegBinary } from "./ffmpegBinary";

describe("resolveFfmpegBinary", () => {
	it("uses an explicitly configured binary without rewriting it", () => {
		expect(
			resolveFfmpegBinary({
				explicitPath: "custom-ffmpeg",
				platform: "darwin",
				resourcesPath: "/resources",
				isExecutable: () => false,
			}),
		).toBe("custom-ffmpeg");
	});

	it("prefers a bundled binary when one is available", () => {
		expect(
			resolveFfmpegBinary({
				platform: "darwin",
				resourcesPath: "/resources",
				isExecutable: (candidate) => candidate === "/resources/ffmpeg/ffmpeg",
			}),
		).toBe("/resources/ffmpeg/ffmpeg");
	});

	it("finds the standard Apple Silicon Homebrew installation for Finder launches", () => {
		expect(
			resolveFfmpegBinary({
				platform: "darwin",
				isExecutable: (candidate) => candidate === "/opt/homebrew/bin/ffmpeg",
			}),
		).toBe("/opt/homebrew/bin/ffmpeg");
	});

	it("falls back to PATH lookup when no known absolute path exists", () => {
		expect(
			resolveFfmpegBinary({
				platform: "linux",
				isExecutable: () => false,
			}),
		).toBe("ffmpeg");
	});
});
