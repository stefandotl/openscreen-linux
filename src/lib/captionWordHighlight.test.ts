import { describe, expect, it } from "vitest";
import { getActiveCaptionWordIndex, getCaptionDisplayWords } from "./captionWordHighlight";

const annotation = {
	startMs: 1_000,
	endMs: 1_800,
	content: "one two",
	captionWords: [
		{ text: "one", startOffsetMs: 0, endOffsetMs: 300 },
		{ text: "two", startOffsetMs: 450, endOffsetMs: 800 },
	],
	style: { wordHighlight: true },
};

describe("caption word highlighting", () => {
	it("selects only the word active at the current timeline time", () => {
		expect(getActiveCaptionWordIndex(annotation, 1_200)).toBe(0);
		expect(getActiveCaptionWordIndex(annotation, 1_400)).toBeNull();
		expect(getActiveCaptionWordIndex(annotation, 1_600)).toBe(1);
	});

	it("falls back to deterministic proportional timing after the word count changes", () => {
		const words = getCaptionDisplayWords({ ...annotation, content: "a longer replacement" });
		expect(words).toHaveLength(3);
		expect(words[0]?.startOffsetMs).toBe(0);
		expect(words.at(-1)?.endOffsetMs).toBe(800);
		expect(words.map((word) => word.text)).toEqual(["a", "longer", "replacement"]);
	});

	it("highlights legacy captions by interpolating when stored word timing is absent", () => {
		const legacy = { ...annotation, captionWords: undefined };
		expect(getActiveCaptionWordIndex(legacy, 1_100)).toBe(0);
		expect(getActiveCaptionWordIndex(legacy, 1_700)).toBe(1);
	});
});
