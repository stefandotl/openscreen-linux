import { describe, expect, it } from "vitest";
import { mergeConnectedTrimRegions } from "./trimRegions";

describe("mergeConnectedTrimRegions", () => {
	it("merges touching and overlapping editable trims regardless of input order", () => {
		expect(
			mergeConnectedTrimRegions([
				{ id: "overlap", startMs: 4800, endMs: 6000 },
				{ id: "first", startMs: 2000, endMs: 4000 },
				{ id: "touching", startMs: 4000, endMs: 5000 },
			]),
		).toEqual([{ id: "first", startMs: 2000, endMs: 6000 }]);
	});

	it("keeps real gaps and locked scene-split ranges independent", () => {
		expect(
			mergeConnectedTrimRegions([
				{ id: "first", startMs: 1000, endMs: 2000 },
				{ id: "locked", startMs: 2000, endMs: 3000, source: "scene-split" },
				{ id: "second", startMs: 3001, endMs: 4000 },
			]),
		).toEqual([
			{ id: "first", startMs: 1000, endMs: 2000 },
			{ id: "locked", startMs: 2000, endMs: 3000, source: "scene-split" },
			{ id: "second", startMs: 3001, endMs: 4000 },
		]);
	});

	it("preserves the preferred ID for timeline selection", () => {
		expect(
			mergeConnectedTrimRegions(
				[
					{ id: "existing", startMs: 1000, endMs: 2000 },
					{ id: "selected", startMs: 2000, endMs: 3000 },
				],
				{ preferredId: "selected" },
			),
		).toEqual([{ id: "selected", startMs: 1000, endMs: 3000 }]);
	});
});
