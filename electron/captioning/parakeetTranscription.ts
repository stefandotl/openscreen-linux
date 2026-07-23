import { fork, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { TrimRegion } from "../../src/components/video-editor/types";
import { MAX_CAPTION_AUDIO_SEC } from "../../src/lib/captioning/captionConstants";
import type { CaptionTranscriptionResult } from "../../src/lib/captioning/captionTranscriptionProtocol";
import type { CaptionSegment } from "../../src/lib/captioning/transcribe";
import type { ParakeetModelFiles } from "./parakeetModelManager";

const require = createRequire(import.meta.url);

const MAX_WORKER_DIAGNOSTIC_LENGTH = 8_000;

interface SherpaRecognitionResult {
	text?: string;
	tokens?: string[];
	timestamps?: number[];
	durations?: number[];
}

interface ParakeetWorkerResponse {
	ok: boolean;
	result?: SherpaRecognitionResult;
	error?: string;
}

function isParakeetWorkerResponse(message: unknown): message is ParakeetWorkerResponse {
	if (!message || typeof message !== "object") return false;
	const candidate = message as Partial<ParakeetWorkerResponse>;
	return typeof candidate.ok === "boolean";
}

function appendWorkerDiagnostic(current: string, chunk: unknown): string {
	const combined = `${current}${String(chunk)}`;
	return combined.slice(-MAX_WORKER_DIAGNOSTIC_LENGTH);
}

function workerExitError(
	code: number | null,
	signal: NodeJS.Signals | null,
	stderr: string,
): Error {
	const exitReason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
	const diagnostic = stderr.trim();
	return new Error(
		`Parakeet transcription process stopped with ${exitReason}${diagnostic ? `: ${diagnostic}` : ""}`,
	);
}

async function recognizeInWorker(options: {
	workerPath: string;
	wavPath: string;
	modelFiles: ParakeetModelFiles;
}): Promise<SherpaRecognitionResult> {
	return new Promise((resolve, reject) => {
		const worker = fork(options.workerPath, [], {
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1",
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		let settled = false;
		let stderr = "";

		worker.stdout?.on("data", (chunk) => {
			stderr = appendWorkerDiagnostic(stderr, chunk);
		});
		worker.stderr?.on("data", (chunk) => {
			stderr = appendWorkerDiagnostic(stderr, chunk);
		});

		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			callback();
		};

		worker.once("error", (error) => {
			settle(() =>
				reject(new Error(`Failed to start Parakeet transcription process: ${error.message}`)),
			);
		});
		worker.once("exit", (code, signal) => {
			settle(() => reject(workerExitError(code, signal, stderr)));
		});
		worker.on("message", (message) => {
			if (!isParakeetWorkerResponse(message)) {
				settle(() =>
					reject(new Error("Parakeet transcription process returned an invalid response")),
				);
				return;
			}
			if (!message.ok || !message.result) {
				settle(() =>
					reject(
						new Error(message.error || "Parakeet transcription process failed without details"),
					),
				);
				return;
			}
			settle(() => resolve(message.result as SherpaRecognitionResult));
		});

		worker.send(
			{
				sherpaModulePath: require.resolve("sherpa-onnx-node"),
				wavPath: options.wavPath,
				modelFiles: options.modelFiles,
				numThreads: Math.max(1, Math.min(4, Number(process.env.OPENSCREEN_CAPTION_THREADS) || 2)),
			},
			(error) => {
				if (error) {
					settle(() => reject(new Error(`Failed to send audio to Parakeet: ${error.message}`)));
				}
			},
		);
	});
}

function normalizeTimestamp(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

function tokenTime(result: SherpaRecognitionResult, index: number): { start: number; end: number } {
	const start = Number(result.timestamps?.[index]);
	const duration = Number(result.durations?.[index]);
	const nextStart = Number(result.timestamps?.[index + 1]);
	const safeStart = Number.isFinite(start) ? normalizeTimestamp(Math.max(0, start)) : 0;
	const endFromDuration = Number.isFinite(duration) && duration > 0 ? safeStart + duration : NaN;
	const safeEnd = Number.isFinite(endFromDuration)
		? endFromDuration
		: Number.isFinite(nextStart) && nextStart > safeStart
			? nextStart
			: safeStart + 0.08;
	return { start: safeStart, end: normalizeTimestamp(safeEnd) };
}

function isPunctuation(text: string): boolean {
	return /^[\p{P}\p{S}]+$/u.test(text);
}

function crossesLetterNumberBoundary(current: string, next: string): boolean {
	const currentCharacter = current.match(/[\p{L}\p{N}](?=[\p{P}\p{S}]*$)/u)?.[0];
	const nextCharacter = next.match(/^[\p{L}\p{N}]/u)?.[0];
	if (!currentCharacter || !nextCharacter) return false;
	return /\p{L}/u.test(currentCharacter) && /\p{N}/u.test(nextCharacter);
}

/** Converts Parakeet's timestamped BPE pieces into the word segments used by the editor. */
export function parakeetResultToWordSegments(result: SherpaRecognitionResult): CaptionSegment[] {
	const tokens = result.tokens ?? [];
	if (tokens.length === 0) {
		if (String(result.text ?? "").trim()) {
			throw new Error("Parakeet returned text without token timestamps");
		}
		return [];
	}
	if (!result.timestamps || result.timestamps.length !== tokens.length) {
		throw new Error("Parakeet returned incomplete token timestamps");
	}

	const segments: CaptionSegment[] = [];
	let text = "";
	let startSec = 0;
	let endSec = 0;
	const flush = () => {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (normalized) {
			segments.push({
				startSec,
				endSec: Math.max(startSec + 0.08, endSec),
				text: normalized,
			});
		}
		text = "";
		endSec = 0;
	};

	for (let index = 0; index < tokens.length; index += 1) {
		const rawToken = String(tokens[index] ?? "");
		const startsWord = /^[\s▁]/u.test(rawToken);
		const cleanToken = rawToken.replace(/^[\s▁]+/u, "").replace(/▁/gu, " ");
		if (!cleanToken) continue;
		const timing = tokenTime(result, index);

		if (
			text &&
			!isPunctuation(cleanToken) &&
			(startsWord || crossesLetterNumberBoundary(text, cleanToken))
		) {
			flush();
		}
		if (!text) startSec = timing.start;
		text += cleanToken;
		endSec = Math.max(endSec, timing.end);
	}
	flush();
	return segments;
}

function overlapsTrimRegion(segment: CaptionSegment, trimRegions: TrimRegion[]): boolean {
	const startMs = Math.round(segment.startSec * 1000);
	const endMs = Math.round(segment.endSec * 1000);
	return trimRegions.some((trim) => startMs < trim.endMs && endMs > trim.startMs);
}

function extractCaptionAudio(
	ffmpegBinary: string,
	videoPath: string,
	outputPath: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			ffmpegBinary,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-y",
				"-i",
				videoPath,
				"-map",
				"0:a:0",
				"-vn",
				"-sn",
				"-dn",
				"-t",
				String(MAX_CAPTION_AUDIO_SEC),
				"-ac",
				"1",
				"-ar",
				"16000",
				"-c:a",
				"pcm_s16le",
				outputPath,
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", (error) => {
			reject(new Error(`Failed to start FFmpeg for captions: ${error.message}`));
		});
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `Caption audio extraction failed (${code})`));
		});
	});
}

export class ParakeetTranscriptionService {
	constructor(private readonly workerPath: string) {}

	async transcribeVideo(options: {
		ffmpegBinary: string;
		videoPath: string;
		modelFiles: ParakeetModelFiles;
		trimRegions: TrimRegion[];
		sourceDurationSec?: number;
	}): Promise<CaptionTranscriptionResult> {
		const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-captions-"));
		const wavPath = path.join(tempDirectory, "caption-audio.wav");
		try {
			await extractCaptionAudio(options.ffmpegBinary, options.videoPath, wavPath);
			const result = await recognizeInWorker({
				workerPath: this.workerPath,
				wavPath,
				modelFiles: options.modelFiles,
			});
			const segments = parakeetResultToWordSegments(result).filter(
				(segment) => !overlapsTrimRegion(segment, options.trimRegions),
			);
			return {
				segments,
				granularity: "word",
				truncated:
					typeof options.sourceDurationSec === "number" &&
					options.sourceDurationSec > MAX_CAPTION_AUDIO_SEC,
			};
		} finally {
			await fs.rm(tempDirectory, { recursive: true, force: true });
		}
	}
}
