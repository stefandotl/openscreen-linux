import { describe, expect, it } from "vitest";
import { parakeetResultToWordSegments } from "./parakeetTranscription";

describe("parakeetResultToWordSegments", () => {
	it("combines timestamped BPE pieces into editor word segments", () => {
		expect(
			parakeetResultToWordSegments({
				text: "This is faster.",
				tokens: [" This", " is", " f", "as", "ter", "."],
				timestamps: [0.4, 0.8, 1.2, 1.28, 1.36, 1.6],
				durations: [0.24, 0.16, 0.08, 0.08, 0.24, 0.08],
			}),
		).toEqual([
			{ startSec: 0.4, endSec: 0.64, text: "This" },
			{ startSec: 0.8, endSec: 0.96, text: "is" },
			{ startSec: 1.2, endSec: 1.68, text: "faster." },
		]);
	});

	it("recognizes SentencePiece word boundaries", () => {
		expect(
			parakeetResultToWordSegments({
				text: "hello world",
				tokens: ["▁hello", "▁world"],
				timestamps: [0, 0.5],
				durations: [0.4, 0.4],
			}),
		).toEqual([
			{ startSec: 0, endSec: 0.4, text: "hello" },
			{ startSec: 0.5, endSec: 0.9, text: "world" },
		]);
	});

	it("separates a number token that Parakeet attaches to the preceding word", () => {
		expect(
			parakeetResultToWordSegments({
				text: "Version 2 starts",
				tokens: [" Version", "2", " starts"],
				timestamps: [0, 0.4, 0.7],
				durations: [0.32, 0.2, 0.3],
			}),
		).toEqual([
			{ startSec: 0, endSec: 0.32, text: "Version" },
			{ startSec: 0.4, endSec: 0.6, text: "2" },
			{ startSec: 0.7, endSec: 1, text: "starts" },
		]);
	});

	it("keeps numeric BPE pieces and decimal punctuation in one number", () => {
		expect(
			parakeetResultToWordSegments({
				text: "3.14",
				tokens: [" 3", ".", "1", "4"],
				timestamps: [0, 0.1, 0.2, 0.3],
				durations: [0.08, 0.08, 0.08, 0.08],
			}),
		).toEqual([{ startSec: 0, endSec: 0.38, text: "3.14" }]);
	});

	it("fails loudly when recognized text has no token timing", () => {
		expect(() => parakeetResultToWordSegments({ text: "untimed" })).toThrow(
			"without token timestamps",
		);
	});
});
