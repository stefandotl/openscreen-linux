import { describe, expect, it } from "vitest";
import { type AnnotationRegion, DEFAULT_ANNOTATION_STYLE } from "../types";
import { annotationTrackKind, contentTrackLanes } from "./contentTracks";

describe("content tracks", () => {
	it("separates legacy text, auto subtitles and images without changing saved annotations", () => {
		const text: AnnotationRegion = {
			id: "text",
			type: "text",
			startMs: 0,
			endMs: 1000,
			content: "Title",
			position: { x: 0, y: 0 },
			size: { width: 50, height: 20 },
			zIndex: 1,
			style: DEFAULT_ANNOTATION_STYLE,
		};
		expect(annotationTrackKind(text)).toBe("text");
		expect(annotationTrackKind({ ...text, annotationSource: "auto-caption" })).toBe("captions");
		expect(annotationTrackKind({ ...text, type: "image" })).toBe("image");
	});
	it("keeps three sequential captions together and makes overlapping text independently accessible", () => {
		const clips = [
			{ id: "third", startMs: 600, endMs: 900 },
			{ id: "first", startMs: 0, endMs: 300 },
			{ id: "second", startMs: 300, endMs: 600 },
		];
		expect(contentTrackLanes(clips).map((lane) => lane.map((clip) => clip.id))).toEqual([
			["first", "second", "third"],
		]);
		const overlays = [
			{ id: "a", startMs: 100, endMs: 500 },
			{ id: "b", startMs: 200, endMs: 700 },
		];
		expect(contentTrackLanes(overlays)).toEqual([[overlays[0]], [overlays[1]]]);
		expect(clips[0].id).toBe("third");
	});
});
