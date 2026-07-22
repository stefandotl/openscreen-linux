import { describe, expect, it } from "vitest";
import {
	buildSilenceTrimSpans,
	normalizeSilenceDetectionSettings,
	parseSilenceDetectionOutput,
	subtractExistingTrimSpans,
} from "./silenceDetection";

describe("silence detection", () => {
	it("parses FFmpeg silence events and closes a final open interval", () => {
		const output = [
			"[silencedetect] silence_start: 1.25",
			"[silencedetect] silence_end: 3.5 | silence_duration: 2.25",
			"[silencedetect] silence_start: 8",
		].join("\n");

		expect(parseSilenceDetectionOutput(output, 10_000)).toEqual([
			{ startMs: 1250, endMs: 3500 },
			{ startMs: 8000, endMs: 10_000 },
		]);
	});

	it("applies protective padding and drops unusably short trims", () => {
		const result = buildSilenceTrimSpans(
			[
				{ startMs: 0, endMs: 1000 },
				{ startMs: 2000, endMs: 2250 },
			],
			{ noiseThresholdDb: -38, minimumSilenceMs: 600, paddingMs: 150 },
			5000,
		);

		expect(result).toEqual([{ startMs: 150, endMs: 850 }]);
	});

	it("subtracts existing manual trims without creating tiny fragments", () => {
		expect(
			subtractExistingTrimSpans(
				[{ startMs: 1000, endMs: 5000 }],
				[
					{ startMs: 900, endMs: 1800 },
					{ startMs: 3000, endMs: 4900 },
				],
			),
		).toEqual([
			{ startMs: 1800, endMs: 3000 },
			{ startMs: 4900, endMs: 5000 },
		]);
	});

	it("clamps untrusted settings", () => {
		expect(
			normalizeSilenceDetectionSettings({
				noiseThresholdDb: -200,
				minimumSilenceMs: 5,
				paddingMs: 99_000,
			}),
		).toEqual({ noiseThresholdDb: -60, minimumSilenceMs: 200, paddingMs: 2000 });
	});
});
