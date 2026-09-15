import type { AnnotationRegion } from "../types";

export type ContentTrackKind = "text" | "captions" | "image" | "figure" | "audio";

export function annotationTrackKind(region: AnnotationRegion): ContentTrackKind {
	if (region.type === "image") return "image";
	if (region.type === "figure") return "figure";
	return region.annotationSource === "auto-caption" ? "captions" : "text";
}

/** Separate overlapping clips visually without changing their timing or compositing order. */
export function contentTrackLanes<T extends { id: string; startMs: number; endMs: number }>(
	regions: readonly T[],
): T[][] {
	const lanes: T[][] = [];
	for (const region of [...regions].sort(
		(a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id),
	)) {
		const lane = lanes.find((items) => items[items.length - 1].endMs <= region.startMs);
		if (lane) lane.push(region);
		else lanes.push([region]);
	}
	return lanes;
}
