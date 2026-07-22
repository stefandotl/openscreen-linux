import { spawn } from "node:child_process";
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

interface SherpaRecognitionResult {
	text?: string;
	tokens?: string[];
	timestamps?: number[];
	durations?: number[];
}

interface SherpaRecognizer {
	createStream(): {
		acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
	};
	decodeAsync(stream: unknown): Promise<SherpaRecognitionResult>;
}

interface SherpaModule {
	OfflineRecognizer: {
		createAsync(config: Record<string, unknown>): Promise<SherpaRecognizer>;
	};
	readWave(
		filePath: string,
		exposeExternalArrayBuffer: boolean,
	): { sampleRate: number; samples: Float32Array };
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

		if (text && startsWord && !isPunctuation(cleanToken)) flush();
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
	private recognizer: SherpaRecognizer | null = null;
	private loadedModelDirectory = "";

	async transcribeVideo(options: {
		ffmpegBinary: string;
		videoPath: string;
		modelDirectory: string;
		modelFiles: ParakeetModelFiles;
		trimRegions: TrimRegion[];
		sourceDurationSec?: number;
	}): Promise<CaptionTranscriptionResult> {
		const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-captions-"));
		const wavPath = path.join(tempDirectory, "caption-audio.wav");
		try {
			await extractCaptionAudio(options.ffmpegBinary, options.videoPath, wavPath);
			const sherpa = require("sherpa-onnx-node") as SherpaModule;
			const activeRecognizer = await this.loadRecognizer(
				sherpa,
				options.modelDirectory,
				options.modelFiles,
			);
			// Electron disables V8 external ArrayBuffers. `false` makes sherpa copy samples into a
			// regular Float32Array before the native recognizer consumes them.
			const wave = sherpa.readWave(wavPath, false);
			if (wave.sampleRate !== 16_000 || wave.samples.length < 800) {
				throw new Error("This video has no usable audio track for captions");
			}
			const stream = activeRecognizer.createStream();
			stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
			const result = await activeRecognizer.decodeAsync(stream);
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

	private async loadRecognizer(
		sherpa: SherpaModule,
		modelDirectory: string,
		files: ParakeetModelFiles,
	): Promise<SherpaRecognizer> {
		if (this.recognizer && this.loadedModelDirectory === modelDirectory) return this.recognizer;

		this.recognizer = await sherpa.OfflineRecognizer.createAsync({
			featConfig: { sampleRate: 16_000, featureDim: 80 },
			modelConfig: {
				transducer: {
					encoder: files.encoder,
					decoder: files.decoder,
					joiner: files.joiner,
				},
				tokens: files.tokens,
				numThreads: Math.max(1, Math.min(4, Number(process.env.OPENSCREEN_CAPTION_THREADS) || 2)),
				provider: "cpu",
				modelType: "nemo_transducer",
				debug: 0,
			},
		});
		this.loadedModelDirectory = modelDirectory;
		return this.recognizer;
	}
}
