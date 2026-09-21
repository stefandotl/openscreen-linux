import { describe, expect, it } from "vitest";
import {
	type AiCutRequest,
	aiCutSuggestionsToTrims,
	buildAiCutUnits,
	resolveAiCutPlan,
	validateAiCutRequest,
} from "./aiCut";

const units = buildAiCutUnits(
	[
		{ text: "Hello", startSec: 0.2, endSec: 0.7 },
		{ text: "um", startSec: 1, endSec: 1.3 },
		{ text: "world", startSec: 2.5, endSec: 3 },
	],
	[{ startMs: 1600, endMs: 2100 }],
	[],
	4000,
);
const request: AiCutRequest = {
	requestId: "test",
	mode: "cleanup",
	instructions: "",
	language: "en",
	units,
	existingTrims: [],
	durationMs: 4000,
};
const plan = (firstUnitId: number, lastUnitId = firstUnitId) => ({
	cuts: [{ firstUnitId, lastUnitId, reason: "Filler" }],
});

describe("AI cut plans", () => {
	it("keeps source word times and only offers silence outside words and existing edits", () => {
		const result = buildAiCutUnits(
			[
				{
					text: "Hello world",
					startSec: 0,
					endSec: 3,
					words: [
						{ text: "Hello", startSec: 0.2, endSec: 0.7 },
						{ text: "world", startSec: 2.5, endSec: 3 },
					],
				},
			],
			[
				{ startMs: 300, endMs: 600 },
				{ startMs: 1000, endMs: 2000 },
			],
			[{ startMs: 2500, endMs: 3100 }],
			4000,
		);
		expect(result).toEqual([
			{ id: 0, kind: "word", text: "Hello", startMs: 200, endMs: 700 },
			{ id: 1, kind: "pause", text: "[silence]", startMs: 1000, endMs: 2000 },
		]);
	});
	it("resolves word IDs into removable, ordinary source-time trims", () => {
		const proposals = resolveAiCutPlan(plan(1), request);
		expect(proposals).toEqual([
			{ id: "test-0", startMs: 1000, endMs: 1300, text: "um", reason: "Filler" },
		]);
		expect(aiCutSuggestionsToTrims(proposals, [])).toEqual([
			expect.objectContaining({ startMs: 1000, endMs: 1300 }),
		]);
		expect(
			aiCutSuggestionsToTrims(proposals, [{ id: "existing", startMs: 1000, endMs: 1300 }]),
		).toEqual([]);
	});
	it("accepts a no-change plan", () => expect(resolveAiCutPlan({ cuts: [] }, request)).toEqual([]));
	it.each([
		plan(-1),
		plan(500),
		plan(2, 1),
		{ cuts: [{ firstUnitId: 1.5, lastUnitId: 2, reason: "x" }] },
		{ cuts: [{ firstUnitId: 1, lastUnitId: 1, reason: "" }] },
		null,
	])("rejects invented references and malformed output %j", (raw) => {
		expect(() => resolveAiCutPlan(raw, request)).toThrow();
	});
	it("rejects overlap, whole-dialogue removal and crossing existing trims", () => {
		expect(() =>
			resolveAiCutPlan({ cuts: [...plan(1).cuts, ...plan(1, 2).cuts] }, request),
		).toThrow("overlapping");
		expect(() => resolveAiCutPlan(plan(0, 3), request)).toThrow("all spoken content");
		expect(() =>
			resolveAiCutPlan(plan(0, 1), { ...request, existingTrims: [{ startMs: 750, endMs: 900 }] }),
		).toThrow("crosses an existing cut");
	});
	it("validates settings and timing before any network call", () => {
		expect(() => validateAiCutRequest({ ...request, durationMs: Number.NaN })).toThrow();
		expect(() => validateAiCutRequest({ ...request, mode: "custom" })).toThrow("instruction");
		expect(() =>
			validateAiCutRequest({ ...request, units: [{ ...units[0], endMs: 5000 }] }),
		).toThrow("timing");
	});
});
