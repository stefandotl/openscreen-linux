import { describe, expect, it } from "vitest";
import { normalizeProjectEditor } from "@/components/video-editor/projectPersistence";
import { buildAiCutUnits } from "@/lib/aiCut";
import { filterCaptionSegmentsByTrims } from "./filterCaptionSegmentsByTrims";
import {
	normalizeSourceTranscript,
	reusableSourceTranscript,
	type SourceTranscript,
} from "./sourceTranscript";

const transcript: SourceTranscript = {
	sourcePath: "/recordings/speech recording.mp4",
	sourceDurationSec: 5,
	engine: "openrouter",
	model: "fish-audio/transcribe-1-pro",
	truncated: false,
	granularity: "word",
	segments: [
		{
			text: "Hello um world",
			startSec: 0.2,
			endSec: 3,
			words: [
				{ text: "Hello", startSec: 0.2, endSec: 0.8 },
				{ text: "um", startSec: 1, endSec: 1.4 },
				{ text: "world", startSec: 2, endSec: 3 },
			],
		},
	],
};

describe("shared source transcript", () => {
	it("round trips independently of captions and filters current cuts without losing source words", () => {
		const editor = normalizeProjectEditor(
			JSON.parse(JSON.stringify({ sourceTranscript: transcript, annotationRegions: [] })),
		);
		const saved = reusableSourceTranscript(
			editor.sourceTranscript,
			"file:///recordings/speech%20recording.mp4",
			5,
		)!;
		expect(saved).toEqual(transcript);
		const trims = [{ id: "trim-1", startMs: 900, endMs: 1500 }];
		expect(filterCaptionSegmentsByTrims(saved.segments, trims)[0].text).toBe("Hello world");
		expect(buildAiCutUnits(saved.segments, [], trims, 5000).map((unit) => unit.text)).toEqual([
			"Hello",
			"world",
		]);
		expect(buildAiCutUnits(saved.segments, [], [], 5000).map((unit) => unit.text)).toEqual([
			"Hello",
			"um",
			"world",
		]);
		expect(saved).toEqual(transcript);
	});
	it("does not reuse changed media, changed duration, incomplete or empty analysis", () => {
		expect(reusableSourceTranscript(transcript, "/different.mp4", 5)).toBeUndefined();
		expect(reusableSourceTranscript(transcript, transcript.sourcePath, 6)).toBeUndefined();
		expect(
			reusableSourceTranscript({ ...transcript, truncated: true }, transcript.sourcePath, 5),
		).toBeUndefined();
		expect(
			reusableSourceTranscript({ ...transcript, segments: [] }, transcript.sourcePath, 5),
		).toBeUndefined();
	});
	it("keeps old projects compatible and rejects malformed saved timing", () => {
		expect(normalizeProjectEditor({}).sourceTranscript).toBeUndefined();
		expect(() =>
			normalizeSourceTranscript({
				...transcript,
				segments: [{ text: "broken", startSec: 2, endSec: 1 }],
			}),
		).toThrow("Invalid saved source transcript");
		expect(() =>
			normalizeSourceTranscript({
				...transcript,
				segments: [
					{
						text: "broken",
						startSec: 0,
						endSec: 1,
						words: [{ text: "bad", startSec: 0, endSec: Infinity }],
					},
				],
			}),
		).toThrow();
	});
});
