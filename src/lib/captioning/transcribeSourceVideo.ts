import type {
	CaptionTranscriptionResult,
	CaptionTranscriptionStatus,
} from "./captionTranscriptionProtocol";
import { extractMono16kFromVideoUrl } from "./extractMono16k";
import { trimLeadingSilenceMono16k } from "./leadingSilence";
import { type SourceTranscript, transcriptSourcePath } from "./sourceTranscript";
import {
	type CaptionEngine,
	type CaptionWordSegment,
	transcribeVideoToSegments,
	transcribeWhisperMono16kToSegments,
} from "./transcribe";

export async function transcribeSourceVideo(
	videoPath: string,
	options: {
		engine: CaptionEngine;
		model?: string;
		sourceDurationSec: number;
		signal?: AbortSignal;
		onStatus?: (status: CaptionTranscriptionStatus) => void;
	},
): Promise<SourceTranscript> {
	options.signal?.throwIfAborted();
	let result: CaptionTranscriptionResult;
	if (options.engine !== "whisper-tiny") {
		result = await transcribeVideoToSegments(videoPath, { ...options, engine: options.engine });
	} else {
		const extracted = await extractMono16kFromVideoUrl(videoPath, { signal: options.signal });
		if (
			!Number.isFinite(extracted.durationSec) ||
			extracted.durationSec <= 0 ||
			extracted.samples.length < 800
		)
			throw new Error("No usable audio for transcription");
		const { samples, trimSec } = trimLeadingSilenceMono16k(extracted.samples);
		let whisper = await transcribeWhisperMono16kToSegments(samples, {
			signal: options.signal,
			onStatus: options.onStatus,
		});
		let offset = trimSec;
		if (!whisper.segments.length && trimSec > 0) {
			whisper = await transcribeWhisperMono16kToSegments(extracted.samples, {
				signal: options.signal,
				onStatus: options.onStatus,
			});
			offset = 0;
		}
		const shift = (word: CaptionWordSegment) => ({
			...word,
			startSec: word.startSec + offset,
			endSec: word.endSec + offset,
		});
		result = {
			...whisper,
			segments: whisper.segments.map((segment) => ({
				...shift(segment),
				...(segment.words ? { words: segment.words.map(shift) } : {}),
			})),
			truncated: extracted.truncated,
		};
	}
	options.signal?.throwIfAborted();
	return {
		...result,
		sourcePath: transcriptSourcePath(videoPath),
		sourceDurationSec: options.sourceDurationSec,
		engine: options.engine,
		...(options.engine === "openrouter" ? { model: options.model } : {}),
	};
}
