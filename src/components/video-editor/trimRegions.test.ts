import { describe, expect, it } from "vitest";
import { mergeConnectedTrimRegions } from "./trimRegions";

describe("mergeConnectedTrimRegions", () => {
	it("merges overlapping editable trims regardless of input order", () => {
		expect(
			mergeConnectedTrimRegions([
				{ id: "overlap", startMs: 4800, endMs: 6000 },
				{ id: "first", startMs: 2000, endMs: 4000 },
				{ id: "touching", startMs: 3900, endMs: 5000 },
			]),
		).toEqual([{ id: "first", startMs: 2000, endMs: 6000 }]);
	});

	it("keeps adjacent cuts independently editable, including after normalization", () => {
		expect(
			mergeConnectedTrimRegions([
				{ id: "later", startMs: 3000, endMs: 4000 },
				{ id: "one-second-cut", startMs: 2000, endMs: 3000 },
			]),
		).toEqual([
			{ id: "one-second-cut", startMs: 2000, endMs: 3000 },
			{ id: "later", startMs: 3000, endMs: 4000 },
		]);
	});

	it("joins every trim reached by an edited edge while leaving distant touching trims separate", () => {
		expect(
			mergeConnectedTrimRegions(
				[
					{ id: "unrelated-a", startMs: 0, endMs: 1000 },
					{ id: "unrelated-b", startMs: 1000, endMs: 2000 },
					{ id: "first", startMs: 3000, endMs: 7000 },
					{ id: "middle", startMs: 4000, endMs: 4500 },
					{ id: "last", startMs: 7000, endMs: 8000 },
				],
				{ preferredId: "first", mergeTouching: true },
			),
		).toEqual([
			{ id: "unrelated-a", startMs: 0, endMs: 1000 },
			{ id: "unrelated-b", startMs: 1000, endMs: 2000 },
			{ id: "first", startMs: 3000, endMs: 8000 },
		]);
	});

	it("joins a chain of earlier touching trims when dragging into it from the right", () => {
		expect(
			mergeConnectedTrimRegions(
				[
					{ id: "a", startMs: 1000, endMs: 2000 },
					{ id: "b", startMs: 2000, endMs: 3000 },
					{ id: "dragged", startMs: 3000, endMs: 5000 },
				],
				{ preferredId: "dragged", mergeTouching: true },
			),
		).toEqual([{ id: "dragged", startMs: 1000, endMs: 5000 }]);
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
					{ id: "selected", startMs: 1900, endMs: 3000 },
				],
				{ preferredId: "selected" },
			),
		).toEqual([{ id: "selected", startMs: 1000, endMs: 3000 }]);
	});
});
