import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";

export const EXPORT_TIMELINE_EPSILON_SEC = 0.001;

export type ExportTimelineSegment = {
	startSec: number;
	endSec: number;
	speed: number;
};

function computeKeepSegments(
	totalDuration: number,
	trimRegions?: TrimRegion[],
): Array<{ startSec: number; endSec: number }> {
	if (!trimRegions || trimRegions.length === 0) {
		return [{ startSec: 0, endSec: totalDuration }];
	}

	const sorted = [...trimRegions].sort((a, b) => a.startMs - b.startMs);
	const segments: Array<{ startSec: number; endSec: number }> = [];
	let cursor = 0;

	for (const trim of sorted) {
		const trimStart = trim.startMs / 1000;
		const trimEnd = trim.endMs / 1000;
		if (cursor < trimStart) {
			segments.push({ startSec: cursor, endSec: trimStart });
		}
		cursor = trimEnd;
	}

	if (cursor < totalDuration) {
		segments.push({ startSec: cursor, endSec: totalDuration });
	}

	return segments;
}

export function buildExportTimelineSegments(
	totalDuration: number,
	trimRegions?: TrimRegion[],
	speedRegions?: SpeedRegion[],
): ExportTimelineSegment[] {
	const keepSegments = computeKeepSegments(totalDuration, trimRegions);
	if (!speedRegions || speedRegions.length === 0) {
		return keepSegments.map((segment) => ({ ...segment, speed: 1 }));
	}

	const result: ExportTimelineSegment[] = [];
	for (const segment of keepSegments) {
		const overlapping = speedRegions
			.filter(
				(region) =>
					region.startMs / 1000 < segment.endSec && region.endMs / 1000 > segment.startSec,
			)
			.sort((a, b) => a.startMs - b.startMs);

		if (overlapping.length === 0) {
			result.push({ ...segment, speed: 1 });
			continue;
		}

		let cursor = segment.startSec;
		for (const region of overlapping) {
			const startSec = Math.max(region.startMs / 1000, segment.startSec);
			const endSec = Math.min(region.endMs / 1000, segment.endSec);
			if (cursor < startSec) {
				result.push({ startSec: cursor, endSec: startSec, speed: 1 });
			}
			result.push({ startSec, endSec, speed: region.speed });
			cursor = endSec;
		}
		if (cursor < segment.endSec) {
			result.push({ startSec: cursor, endSec: segment.endSec, speed: 1 });
		}
	}

	return result.filter((segment) => segment.endSec - segment.startSec > 0.0001);
}

export function getExportTimelineMetrics(
	totalDuration: number,
	targetFrameRate: number,
	trimRegions?: TrimRegion[],
	speedRegions?: SpeedRegion[],
): { effectiveDuration: number; totalFrames: number } {
	const segments = buildExportTimelineSegments(totalDuration, trimRegions, speedRegions);
	return {
		effectiveDuration: segments.reduce(
			(sum, segment) => sum + (segment.endSec - segment.startSec) / segment.speed,
			0,
		),
		totalFrames: segments.reduce((sum, segment) => {
			const durationSec = segment.endSec - segment.startSec - EXPORT_TIMELINE_EPSILON_SEC;
			return sum + Math.max(0, Math.ceil((durationSec / segment.speed) * targetFrameRate));
		}, 0),
	};
}

export function getExportSourceTimestampsMs(
	totalDuration: number,
	targetFrameRate: number,
	trimRegions?: TrimRegion[],
	speedRegions?: SpeedRegion[],
): number[] {
	const segments = buildExportTimelineSegments(totalDuration, trimRegions, speedRegions);
	const timestamps: number[] = [];

	for (const segment of segments) {
		const durationSec = segment.endSec - segment.startSec - EXPORT_TIMELINE_EPSILON_SEC;
		const frameCount = Math.max(0, Math.ceil((durationSec / segment.speed) * targetFrameRate));
		for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
			const sourceTimeSec = segment.startSec + (frameIndex / targetFrameRate) * segment.speed;
			if (sourceTimeSec >= segment.endSec - EXPORT_TIMELINE_EPSILON_SEC) break;
			timestamps.push(sourceTimeSec * 1000);
		}
	}

	return timestamps;
}
