import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getSeekablePreviewCachePath,
	prepareSeekablePreview,
	shouldPrepareSeekablePreview,
} from "./previewVideo";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "videtio-preview-video-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
	);
});

describe("seekable preview media", () => {
	it("only prepares MediaRecorder WebM sources", () => {
		expect(shouldPrepareSeekablePreview("recording.webm")).toBe(true);
		expect(shouldPrepareSeekablePreview("recording.WEBM")).toBe(true);
		expect(shouldPrepareSeekablePreview("recording.mp4")).toBe(false);
	});

	it("changes the cache key when the source fingerprint changes", () => {
		const first = getSeekablePreviewCachePath("/recordings/input.webm", "/cache", 100, 10);
		const second = getSeekablePreviewCachePath("/recordings/input.webm", "/cache", 101, 10);
		expect(first).not.toBe(second);
		expect(first).toMatch(/\.webm$/);
	});

	it("copies packets into an atomic indexed preview and reuses it", async () => {
		const directory = await createTemporaryDirectory();
		const sourcePath = path.join(directory, "source.webm");
		const cacheDir = path.join(directory, "cache");
		await fs.writeFile(sourcePath, "source-media");

		const runProcess = vi.fn(async (_command: string, args: string[]) => {
			const outputPath = args.at(-1);
			if (!outputPath) throw new Error("Missing output path");
			await fs.writeFile(outputPath, "indexed-media");
			return { code: 0, stdout: "", stderr: "" };
		});

		const first = await prepareSeekablePreview({
			sourcePath,
			cacheDir,
			ffmpegBinary: "/usr/bin/ffmpeg",
			runProcess,
		});
		expect(first.cached).toBe(false);
		expect(await fs.readFile(first.path, "utf8")).toBe("indexed-media");
		expect(runProcess).toHaveBeenCalledOnce();
		expect(runProcess.mock.calls[0]?.[1]).toContain("copy");
		expect(runProcess.mock.calls[0]?.[1]).toContain("matroska");

		const second = await prepareSeekablePreview({
			sourcePath,
			cacheDir,
			ffmpegBinary: "/usr/bin/ffmpeg",
			runProcess,
		});
		expect(second).toEqual({ path: first.path, cached: true });
		expect(runProcess).toHaveBeenCalledOnce();
	});

	it("removes a partial cache file when FFmpeg fails", async () => {
		const directory = await createTemporaryDirectory();
		const sourcePath = path.join(directory, "source.webm");
		const cacheDir = path.join(directory, "cache");
		await fs.writeFile(sourcePath, "source-media");

		await expect(
			prepareSeekablePreview({
				sourcePath,
				cacheDir,
				ffmpegBinary: "/usr/bin/ffmpeg",
				runProcess: async (_command, args) => {
					await fs.writeFile(args.at(-1)!, "partial");
					return { code: 1, stdout: "", stderr: "broken input" };
				},
			}),
		).rejects.toThrow("broken input");
		expect(await fs.readdir(cacheDir)).toEqual([]);
	});

	it("prunes older previews while retaining the current cache entry", async () => {
		const directory = await createTemporaryDirectory();
		const cacheDir = path.join(directory, "cache");
		const firstSource = path.join(directory, "first.webm");
		const secondSource = path.join(directory, "second.webm");
		await fs.writeFile(firstSource, "first-source");
		await fs.writeFile(secondSource, "second-source");
		const runProcess = async (_command: string, args: string[]) => {
			await fs.writeFile(args.at(-1)!, "indexed-media");
			return { code: 0, stdout: "", stderr: "" };
		};

		const first = await prepareSeekablePreview({
			sourcePath: firstSource,
			cacheDir,
			ffmpegBinary: "ffmpeg",
			runProcess,
			maxCacheBytes: 20,
		});
		const second = await prepareSeekablePreview({
			sourcePath: secondSource,
			cacheDir,
			ffmpegBinary: "ffmpeg",
			runProcess,
			maxCacheBytes: 20,
		});

		await expect(fs.stat(first.path)).rejects.toThrow();
		expect(await fs.readFile(second.path, "utf8")).toBe("indexed-media");
	});
});
