import type { TrimRegion } from "@/components/video-editor/types";
import type { CaptionSegment } from "./transcribe";

/** Keep words that are mostly audible and confine their display to the playable side of a cut. */
export function filterCaptionSegmentsByTrims(
	segments: CaptionSegment[],
	trimRegions: readonly TrimRegion[],
): CaptionSegment[] {
	if (trimRegions.length === 0) return segments;
	const trims = [...trimRegions].sort((a, b) => a.startMs - b.startMs);
	return segments.flatMap((segment) => {
		if (segment.words?.length) {
			const words = filterCaptionSegmentsByTrims(segment.words, trims);
			return words.length
				? [
						{
							...segment,
							startSec: words[0].startSec,
							endSec: words.at(-1)!.endSec,
							text: words.map((word) => word.text).join(" "),
							words,
						},
					]
				: [];
		}
		const midpointMs = ((segment.startSec + segment.endSec) * 1000) / 2;
		if (trims.some((trim) => midpointMs >= trim.startMs && midpointMs < trim.endMs)) {
			return [];
		}
		let startMs = segment.startSec * 1000;
		let endMs = segment.endSec * 1000;
		for (const trim of trims) {
			if (trim.endMs <= midpointMs) startMs = Math.max(startMs, trim.endMs);
			if (trim.startMs > midpointMs) endMs = Math.min(endMs, trim.startMs);
		}
		if (endMs <= startMs) return [];
		return [{ ...segment, startSec: startMs / 1000, endSec: endMs / 1000 }];
	});
}
