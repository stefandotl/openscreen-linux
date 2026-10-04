import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TrimRegion } from "../../src/components/video-editor/types";
import { MAX_CAPTION_AUDIO_SEC } from "../../src/lib/captioning/captionConstants";
import type { CaptionTranscriptionResult } from "../../src/lib/captioning/captionTranscriptionProtocol";
import { filterCaptionSegmentsByTrims } from "../../src/lib/captioning/filterCaptionSegmentsByTrims";
import type { CaptionSegment } from "../../src/lib/captioning/transcribe";
import { isOpenRouterCaptionModel } from "../../src/lib/openRouter";
import { createParakeetChunkWindows, PARAKEET_SAMPLE_RATE } from "./parakeetChunking";

/** OpenRouter normalizes provider word timestamps to seconds in verbose_json. */
export function openRouterWords(body: unknown, durationSec: number): CaptionSegment[] {
	if (!body || typeof body !== "object")
		throw new Error("OpenRouter returned an invalid transcription.");
	const response = body as { text?: unknown; words?: unknown; error?: unknown };
	if (response.error) throw new Error("OpenRouter returned a transcription provider error.");
	if (!Array.isArray(response.words))
		throw new Error(
			"The selected OpenRouter model returned no word timestamps. Captions were not added.",
		);
	if (!response.words.length && typeof response.text === "string" && response.text.trim())
		throw new Error("OpenRouter returned speech without word timestamps. Captions were not added.");
	let previousStart = -1;
	return response.words.map((value: unknown) => {
		if (!value || typeof value !== "object")
			throw new Error("OpenRouter returned an invalid timed word.");
		const word = value as { word?: unknown; text?: unknown; start?: unknown; end?: unknown };
		const text = word.word ?? word.text;
		if (
			typeof text !== "string" ||
			!text.trim() ||
			typeof word.start !== "number" ||
			typeof word.end !== "number" ||
			!Number.isFinite(word.start) ||
			!Number.isFinite(word.end) ||
			word.start < 0 ||
			word.start >= durationSec ||
			word.end <= word.start ||
			word.start < previousStart ||
			word.end > durationSec + 0.05
		)
			throw new Error(
				"OpenRouter returned invalid or unordered word timestamps. Captions were not added.",
			);
		previousStart = word.start;
		return { text: text.trim(), startSec: word.start, endSec: Math.min(word.end, durationSec) };
	});
}

export function pcmToWav(pcm: Buffer): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(PARAKEET_SAMPLE_RATE, 24);
	header.writeUInt32LE(PARAKEET_SAMPLE_RATE * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

export async function requestTimedTranscription(
	options: {
		model: string;
		apiKey: string;
		pcm: Buffer;
		signal: AbortSignal;
	},
	fetcher: typeof fetch = fetch,
): Promise<CaptionSegment[]> {
	if (!isOpenRouterCaptionModel(options.model))
		throw new Error("This OpenRouter model is not supported for timed captions.");
	options.signal.throwIfAborted();
	const response = await fetcher("https://openrouter.ai/api/v1/audio/transcriptions", {
		method: "POST",
		redirect: "error",
		signal: AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]),
		headers: {
			Authorization: `Bearer ${options.apiKey}`,
			"Content-Type": "application/json",
			"X-Title": "Videtio",
		},
		body: JSON.stringify({
			model: options.model,
			input_audio: { data: pcmToWav(options.pcm).toString("base64"), format: "wav" },
			response_format: "verbose_json",
			timestamp_granularities: ["word"],
		}),
	});
	if (!response.ok) {
		const explanations: Record<number, string> = {
			400: "The model/provider rejected word timestamps or the audio format.",
			401: "The OpenRouter API key is invalid.",
			402: "Insufficient OpenRouter credits.",
			403: "Access denied by OpenRouter or your provider settings.",
			429: "OpenRouter rate limit reached. Try again later.",
		};
		// Provider bodies may echo audio, transcripts or credentials; never log or display them.
		throw new Error(
			`OpenRouter transcription HTTP ${response.status}: ${explanations[response.status] ?? "The transcription provider failed. Try again later."}`,
		);
	}
	return openRouterWords(await response.json(), options.pcm.length / (PARAKEET_SAMPLE_RATE * 2));
}

function extractPcm(
	ffmpeg: string,
	videoPath: string,
	pcmPath: string,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			ffmpeg,
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
				String(PARAKEET_SAMPLE_RATE),
				"-c:a",
				"pcm_s16le",
				"-f",
				"s16le",
				pcmPath,
			],
			{ stdio: ["ignore", "ignore", "pipe"], signal },
		);
		let noAudio = false;
		child.stderr.on("data", (chunk: Buffer) => {
			noAudio ||= /matches no streams|does not contain any stream/i.test(chunk.toString());
		});
		child.once("error", () =>
			reject(
				new Error(
					signal.aborted
						? "Caption transcription cancelled."
						: "Could not start FFmpeg caption audio extraction.",
				),
			),
		);
		child.once("close", (code) =>
			code === 0
				? resolve()
				: reject(
						new Error(
							noAudio
								? "This video has no usable audio to transcribe."
								: `Caption audio extraction failed (${code}).`,
						),
					),
		);
	});
}

/** Disk-backed PCM and bounded WAV requests keep long recordings outside renderer IPC. */
export async function transcribeOpenRouterVideo(options: {
	ffmpegBinary: string;
	videoPath: string;
	model: string;
	apiKey: string;
	trimRegions: TrimRegion[];
	sourceDurationSec?: number;
	signal: AbortSignal;
	onProgress?(percent: number): void;
}): Promise<CaptionTranscriptionResult> {
	if (!isOpenRouterCaptionModel(options.model))
		throw new Error("This OpenRouter model is not supported for timed captions.");
	const stat = await fs.stat(options.videoPath);
	if (!stat.isFile()) throw new Error("Caption source is not a readable video file.");
	options.signal.throwIfAborted();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "videtio-openrouter-captions-"));
	try {
		const pcmPath = path.join(directory, "audio.pcm");
		await extractPcm(options.ffmpegBinary, options.videoPath, pcmPath, options.signal);
		const bytes = (await fs.stat(pcmPath)).size;
		if (!bytes || bytes % 2) throw new Error("This video has no usable audio to transcribe.");
		const windows = createParakeetChunkWindows(bytes / 2);
		const handle = await fs.open(pcmPath, "r");
		const segments: CaptionSegment[] = [];
		try {
			for (let index = 0; index < windows.length; index++) {
				options.signal.throwIfAborted();
				const window = windows[index];
				const pcm = Buffer.alloc((window.readEndSample - window.readStartSample) * 2);
				let read = 0;
				while (read < pcm.length) {
					const result = await handle.read(
						pcm,
						read,
						pcm.length - read,
						window.readStartSample * 2 + read,
					);
					if (!result.bytesRead) throw new Error("Caption audio extraction ended unexpectedly.");
					read += result.bytesRead;
				}
				const words = await requestTimedTranscription({ ...options, pcm });
				for (const word of words) {
					const offset = window.readStartSample / PARAKEET_SAMPLE_RATE;
					const shifted = {
						...word,
						startSec: word.startSec + offset,
						endSec: word.endSec + offset,
					};
					const midpoint = (shifted.startSec + shifted.endSec) / 2;
					if (
						midpoint >= window.keepStartSample / PARAKEET_SAMPLE_RATE &&
						(window.isLast
							? midpoint <= window.keepEndSample / PARAKEET_SAMPLE_RATE
							: midpoint < window.keepEndSample / PARAKEET_SAMPLE_RATE)
					)
						segments.push(shifted);
				}
				options.onProgress?.(Math.round(((index + 1) / windows.length) * 100));
			}
		} finally {
			await handle.close();
		}
		options.signal.throwIfAborted();
		return {
			segments: filterCaptionSegmentsByTrims(
				segments.sort((a, b) => a.startSec - b.startSec),
				options.trimRegions,
			),
			granularity: "word",
			truncated:
				typeof options.sourceDurationSec === "number"
					? options.sourceDurationSec > MAX_CAPTION_AUDIO_SEC
					: bytes / 2 / PARAKEET_SAMPLE_RATE >= MAX_CAPTION_AUDIO_SEC,
		};
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}
