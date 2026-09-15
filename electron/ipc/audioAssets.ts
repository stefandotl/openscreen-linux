import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ipcMain } from "electron";

const execute = promisify(execFile);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"]);

export async function validateAudioPath(candidate: unknown): Promise<string> {
	if (typeof candidate !== "string" || candidate.includes("\0") || !path.isAbsolute(candidate)) {
		throw new Error("Audio must be a local absolute file path");
	}
	const normalized = await fs.realpath(path.normalize(candidate));
	if (
		!AUDIO_EXTENSIONS.has(path.extname(normalized).toLowerCase()) ||
		!(await fs.stat(normalized)).isFile()
	) {
		throw new Error("Unsupported audio file. Use MP3, WAV, M4A, AAC, OGG, Opus or FLAC.");
	}
	await fs.access(normalized, fs.constants.R_OK);
	return normalized;
}

export function registerAudioAssetHandlers(getFfmpegBinary: () => string) {
	ipcMain.handle("inspect-audio-file", async (_event, candidate: unknown) => {
		try {
			const sourcePath = await validateAudioPath(candidate);
			const { stderr } = await execute(
				getFfmpegBinary(),
				[
					"-hide_banner",
					"-nostdin",
					"-i",
					sourcePath,
					"-map",
					"0:a:0",
					"-t",
					"0.05",
					"-f",
					"null",
					"-",
				],
				{ timeout: 30_000, maxBuffer: 1024 * 1024 },
			);
			const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
			const durationMs = duration
				? (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000
				: 0;
			if (durationMs <= 0) throw new Error("Audio file has no usable duration");
			return { success: true as const, path: sourcePath, durationMs };
		} catch (error) {
			console.error("[audio-import]", error);
			return {
				success: false as const,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});
}
