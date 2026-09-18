import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const PREVIEW_CACHE_VERSION = 1;
const DEFAULT_MAX_PREVIEW_CACHE_BYTES = 4 * 1024 * 1024 * 1024;

export interface ProcessResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export type ProcessRunner = (command: string, args: string[]) => Promise<ProcessResult>;

export interface PrepareSeekablePreviewOptions {
	sourcePath: string;
	cacheDir: string;
	ffmpegBinary: string;
	runProcess: ProcessRunner;
	maxCacheBytes?: number;
}

export interface PreparedSeekablePreview {
	path: string;
	cached: boolean;
}

export function shouldPrepareSeekablePreview(sourcePath: string): boolean {
	return path.extname(sourcePath).toLowerCase() === ".webm";
}

export function getSeekablePreviewCachePath(
	sourcePath: string,
	cacheDir: string,
	sourceSize: number,
	sourceMtimeMs: number,
): string {
	const sourceId = createHash("sha256").update(path.resolve(sourcePath)).digest("hex").slice(0, 20);
	const fingerprint = createHash("sha256")
		.update(`${PREVIEW_CACHE_VERSION}:${sourceSize}:${Math.round(sourceMtimeMs)}`)
		.digest("hex")
		.slice(0, 16);
	return path.join(cacheDir, `${sourceId}-${fingerprint}.webm`);
}

async function prunePreviewCache(cacheDir: string, keepPath: string, maxBytes: number) {
	if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;

	const entries = await fs.readdir(cacheDir, { withFileTypes: true });
	const files = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".webm"))
			.map(async (entry) => {
				const filePath = path.join(cacheDir, entry.name);
				const stat = await fs.stat(filePath);
				return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
			}),
	);
	let totalBytes = files.reduce((total, file) => total + file.size, 0);
	for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
		if (totalBytes <= maxBytes) break;
		if (path.resolve(file.path) === path.resolve(keepPath)) continue;
		try {
			await fs.unlink(file.path);
			totalBytes -= file.size;
		} catch {
			// A preview currently open on Windows cannot be removed; keep it until a later prune.
		}
	}
}

/**
 * Repackages a MediaRecorder WebM into an indexed Matroska file for interactive preview.
 * Video and audio packets are copied unchanged; the original remains the export source.
 */
export async function prepareSeekablePreview({
	sourcePath,
	cacheDir,
	ffmpegBinary,
	runProcess,
	maxCacheBytes = DEFAULT_MAX_PREVIEW_CACHE_BYTES,
}: PrepareSeekablePreviewOptions): Promise<PreparedSeekablePreview> {
	if (!shouldPrepareSeekablePreview(sourcePath)) {
		return { path: sourcePath, cached: true };
	}

	const sourceStat = await fs.stat(sourcePath);
	if (!sourceStat.isFile()) {
		throw new Error("Preview source is not a file");
	}

	await fs.mkdir(cacheDir, { recursive: true });
	const outputPath = getSeekablePreviewCachePath(
		sourcePath,
		cacheDir,
		sourceStat.size,
		sourceStat.mtimeMs,
	);
	try {
		const outputStat = await fs.stat(outputPath);
		if (outputStat.isFile() && outputStat.size > 0) {
			const now = new Date();
			await fs.utimes(outputPath, now, now).catch(() => undefined);
			await prunePreviewCache(cacheDir, outputPath, maxCacheBytes).catch(() => undefined);
			return { path: outputPath, cached: true };
		}
	} catch {
		// Build the missing cache entry below.
	}

	const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		const result = await runProcess(ffmpegBinary, [
			"-nostdin",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			sourcePath,
			"-map",
			"0:v?",
			"-map",
			"0:a?",
			"-c",
			"copy",
			"-map_metadata",
			"0",
			"-f",
			"matroska",
			temporaryPath,
		]);
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
			throw new Error(`FFmpeg could not index the preview media: ${detail}`);
		}

		const temporaryStat = await fs.stat(temporaryPath);
		if (!temporaryStat.isFile() || temporaryStat.size === 0) {
			throw new Error("FFmpeg produced an empty preview media file");
		}

		await fs.rename(temporaryPath, outputPath);
		await prunePreviewCache(cacheDir, outputPath, maxCacheBytes).catch(() => undefined);
		return { path: outputPath, cached: false };
	} catch (error) {
		await fs.unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}
