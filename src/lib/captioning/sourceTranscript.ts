import type { CaptionTranscriptionResult } from "./captionTranscriptionProtocol";
import type { CaptionEngine, CaptionWordSegment } from "./transcribe";

/** Full source transcript; timeline cuts are applied by consumers, never baked into this cache. */
export interface SourceTranscript extends CaptionTranscriptionResult {
	sourcePath: string;
	sourceDurationSec: number;
	engine: CaptionEngine;
	model?: string;
}

export function transcriptSourcePath(videoPath: string): string {
	if (!videoPath.startsWith("file://")) return videoPath.replace(/\\/g, "/");
	const url = new URL(videoPath);
	const path = decodeURIComponent(url.pathname);
	if (url.host && url.host !== "localhost") return `//${url.host}${path}`;
	return path.replace(/^\/([a-zA-Z]:)/, "$1");
}

export function reusableSourceTranscript(
	transcript: SourceTranscript | null | undefined,
	videoPath: string,
	durationSec: number,
): SourceTranscript | undefined {
	return transcript &&
		!transcript.truncated &&
		transcript.segments.length > 0 &&
		transcriptSourcePath(transcript.sourcePath) === transcriptSourcePath(videoPath) &&
		Math.abs(transcript.sourceDurationSec - durationSec) <= 0.1
		? transcript
		: undefined;
}

/** Validate persisted analysis separately from editable caption annotations. */
export function normalizeSourceTranscript(value: unknown): SourceTranscript | undefined {
	if (value == null) return undefined;
	const transcript = value as SourceTranscript;
	const validWord = (word: CaptionWordSegment) =>
		word &&
		typeof word.text === "string" &&
		word.text.trim().length > 0 &&
		Number.isFinite(word.startSec) &&
		Number.isFinite(word.endSec) &&
		word.startSec >= 0 &&
		word.endSec > word.startSec &&
		word.endSec <= transcript.sourceDurationSec + 0.1;
	if (
		typeof transcript.sourcePath !== "string" ||
		!transcript.sourcePath ||
		!Number.isFinite(transcript.sourceDurationSec) ||
		transcript.sourceDurationSec <= 0 ||
		!["parakeet", "whisper-tiny", "openrouter"].includes(transcript.engine) ||
		(transcript.engine === "openrouter" &&
			(typeof transcript.model !== "string" || !transcript.model)) ||
		!["word", "phrase"].includes(transcript.granularity) ||
		typeof transcript.truncated !== "boolean" ||
		!Array.isArray(transcript.segments) ||
		transcript.segments.length > 250_000 ||
		!transcript.segments.every(
			(segment) =>
				validWord(segment) &&
				(segment.words === undefined ||
					(Array.isArray(segment.words) && segment.words.every(validWord))),
		)
	)
		throw new Error("Invalid saved source transcript");
	return transcript;
}
