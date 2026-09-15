import { describe, expect, it } from "vitest";
import {
	buildExportTimelineSegments,
	getContinuousExportSourceTimestampsMs,
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

	it("keeps CFR cadence continuous across fractional trim boundaries", () => {
		const timestamps = getContinuousExportSourceTimestampsMs(1, 30, [
			{ startMs: 50, endMs: 100 },
			{ startMs: 150, endMs: 300 },
		]);

		expect(timestamps).toHaveLength(24);
		expect(timestamps[0]).toBe(0);
		expect(timestamps[1]).toBeCloseTo(1000 / 30);
		expect(timestamps[2]).toBeCloseTo(100 + (1000 / 30) * 2 - 50);
		expect(timestamps.at(-1)).toBeCloseTo(300 + (1000 / 30) * 23 - 100);
	});
	it("does not reintroduce trimmed video when a silence trim is nested in a scene trim", () => {
		const trims = [
			{ startMs: 1000, endMs: 5000 },
			{ startMs: 2000, endMs: 3000 },
			{ startMs: 8000, endMs: 12000 },
		];
		expect(buildExportTimelineSegments(10, trims)).toEqual([
			{ startSec: 0, endSec: 1, speed: 1 },
			{ startSec: 5, endSec: 8, speed: 1 },
		]);
		const timestamps = getContinuousExportSourceTimestampsMs(10, 30, trims);
		expect(timestamps).toHaveLength(120);
		expect(timestamps[30]).toBe(5000);
		expect(timestamps.every((time) => time < 1000 || (time >= 5000 && time < 8000))).toBe(true);
	});

	it("keeps 100 fractional silence cuts on the continuous audio clock", () => {
		const trims = Array.from({ length: 100 }, (_, i) => ({
			startMs: i * 1000 + 417,
			endMs: i * 1000 + 763,
		}));
		const timestamps = getContinuousExportSourceTimestampsMs(100, 30, trims);
		expect(timestamps).toHaveLength(1962);
		for (const [index, sourceMs] of timestamps.entries()) {
			const removedMs = trims.reduce(
				(total, trim) => total + Math.max(0, Math.min(sourceMs, trim.endMs) - trim.startMs),
				0,
			);
			expect(sourceMs - removedMs).toBeCloseTo((index * 1000) / 30, 6);
		}
	});
});
