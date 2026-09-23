import { describe, expect, it } from "vitest";
import { filterCaptionSegmentsByTrims } from "./filterCaptionSegmentsByTrims";
import { runTranscription } from "./transcribeCore";

const trimRegions = [{ id: "cut", startMs: 1000, endMs: 2000 }];

describe("filterCaptionSegmentsByTrims", () => {
	it("keeps words at both cut edges while removing words mostly inside the cut", () => {
		expect(
			filterCaptionSegmentsByTrims(
				[
					{ startSec: 0.8, endSec: 1.05, text: "before" },
					{ startSec: 1.2, endSec: 1.4, text: "removed" },
					{ startSec: 1.95, endSec: 2.2, text: "after" },
				],
				trimRegions,
			),
		).toEqual([
			{ startSec: 0.8, endSec: 1, text: "before" },
			{ startSec: 2, endSec: 2.2, text: "after" },
		]);
	});

	it("handles consecutive cuts without displaying captions in either removed span", () => {
		expect(
			filterCaptionSegmentsByTrims(
				[{ startSec: 1.9, endSec: 2.1, text: "between" }],
				[
					{ id: "first", startMs: 1000, endMs: 2000 },
					{ id: "second", startMs: 2100, endMs: 3000 },
				],
			),
		).toEqual([{ startSec: 2, endSec: 2.1, text: "between" }]);
	});
});

describe("runTranscription with cuts", () => {
	it("recognizes continuous audio once and keeps the word at a cut edge", async () => {
		const transcriber = async () => ({
			chunks: [
				{ timestamp: [0.8, 1.05], text: " before" },
				{ timestamp: [1.2, 1.4], text: " removed" },
				{ timestamp: [1.95, 2.2], text: " after" },
			],
		});
		const result = await runTranscription(transcriber, new Float32Array(3 * 16_000), trimRegions);
		expect(result).toMatchObject({
			granularity: "word",
			segments: [
				{ startSec: 0.8, endSec: 1, text: "before" },
				{ startSec: 2, endSec: 2.2, text: "after" },
			],
		});
	});
});
