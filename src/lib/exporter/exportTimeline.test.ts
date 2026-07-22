import { describe, expect, it } from "vitest";
import {
	buildExportTimelineSegments,
	getExportSourceTimestampsMs,
	getExportTimelineMetrics,
} from "./exportTimeline";

describe("export timeline", () => {
	it("keeps the existing trim and speed segment semantics", () => {
		expect(
			buildExportTimelineSegments(
				10,
				[{ startMs: 2000, endMs: 4000 }],
				[{ startMs: 5000, endMs: 7000, speed: 2 }],
			),
		).toEqual([
			{ startSec: 0, endSec: 2, speed: 1 },
			{ startSec: 4, endSec: 5, speed: 1 },
			{ startSec: 5, endSec: 7, speed: 2 },
			{ startSec: 7, endSec: 10, speed: 1 },
		]);
	});

	it("produces one source timestamp per reported output frame", () => {
		const metrics = getExportTimelineMetrics(
			10,
			30,
			[{ startMs: 2000, endMs: 4000 }],
			[{ startMs: 5000, endMs: 7000, speed: 2 }],
		);
		const timestamps = getExportSourceTimestampsMs(
			10,
			30,
			[{ startMs: 2000, endMs: 4000 }],
			[{ startMs: 5000, endMs: 7000, speed: 2 }],
		);

		expect(metrics.effectiveDuration).toBe(7);
		expect(timestamps).toHaveLength(metrics.totalFrames);
		expect(timestamps[0]).toBe(0);
		expect(timestamps.at(-1)).toBeLessThan(10_000);
	});
});
