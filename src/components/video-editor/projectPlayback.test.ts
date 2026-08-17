import { describe, expect, it } from "vitest";
import {
	buildProjectPlaybackPlan,
	getEffectiveSceneDuration,
	getNextProjectPlaybackSegment,
	getProjectPlaybackDuration,
	hasProjectPlaybackIntent,
	isContiguousProjectPlaybackHandoff,
	type ProjectPlaybackScene,
	projectTimeToSceneSource,
	sceneSourceTimeToProjectTime,
} from "./projectPlayback";

function scene(
	id: string,
	sourceDurationSeconds: number,
	overrides: Partial<ProjectPlaybackScene> = {},
): ProjectPlaybackScene {
	return {
		id,
		name: id,
		sourceDurationSeconds,
		trimRegions: [],
		speedRegions: [],
		...overrides,
	};
}

describe("project playback plan", () => {
	it("does not treat a paused scene switch as active playback", () => {
		expect(hasProjectPlaybackIntent("switching", false)).toBe(false);
		expect(hasProjectPlaybackIntent("switching", undefined)).toBe(false);
		expect(hasProjectPlaybackIntent("switching", true)).toBe(true);
		expect(hasProjectPlaybackIntent("playing", false)).toBe(true);
	});

	it("uses effective durations after trims and speed changes", () => {
		const trimRegions = [{ id: "trim", startMs: 2000, endMs: 4000 }];
		const speedRegions = [{ id: "speed", startMs: 5000, endMs: 7000, speed: 2 as const }];
		const plan = buildProjectPlaybackPlan([
			scene("intro", 10, {
				trimRegions,
				speedRegions,
			}),
			scene("demo", 3),
		]);

		expect(getEffectiveSceneDuration(10, trimRegions, speedRegions)).toBe(7);
		expect(plan[0]).toMatchObject({
			sceneId: "intro",
			projectStartSeconds: 0,
			projectEndSeconds: 7,
			sourceStartSeconds: 0,
			sourceEndSeconds: 10,
		});
		expect(plan[1]).toMatchObject({
			sceneId: "demo",
			projectStartSeconds: 7,
			projectEndSeconds: 10,
		});
		expect(getProjectPlaybackDuration(plan)).toBe(10);
	});

	it("maps project time through trimmed and sped-up source ranges", () => {
		const plan = buildProjectPlaybackPlan([
			scene("edited", 10, {
				trimRegions: [{ id: "trim", startMs: 2000, endMs: 4000 }],
				speedRegions: [{ id: "speed", startMs: 5000, endMs: 7000, speed: 2 }],
			}),
		]);

		expect(projectTimeToSceneSource(plan, 2)).toMatchObject({
			sceneId: "edited",
			sourceTimeSeconds: 4,
		});
		expect(projectTimeToSceneSource(plan, 3.5)).toMatchObject({
			sceneId: "edited",
			sourceTimeSeconds: 6,
		});
		expect(sceneSourceTimeToProjectTime(plan, "edited", 3)).toBe(2);
		expect(sceneSourceTimeToProjectTime(plan, "edited", 6)).toBe(3.5);
	});

	it("selects the later scene exactly on a scene boundary", () => {
		const plan = buildProjectPlaybackPlan([scene("first", 2), scene("second", 3)]);

		expect(projectTimeToSceneSource(plan, 2)).toEqual({
			sceneId: "second",
			sourceTimeSeconds: 0,
			projectTimeSeconds: 2,
		});
		expect(projectTimeToSceneSource(plan, 5)).toEqual({
			sceneId: "second",
			sourceTimeSeconds: 3,
			projectTimeSeconds: 5,
		});
	});

	it("omits fully trimmed scenes and follows the supplied scene order", () => {
		const plan = buildProjectPlaybackPlan([
			scene("third", 3),
			scene("empty-after-trim", 2, {
				trimRegions: [{ id: "all", startMs: 0, endMs: 2000 }],
			}),
			scene("first", 1),
		]);

		expect(plan.map((segment) => segment.sceneId)).toEqual(["third", "first"]);
		expect(getNextProjectPlaybackSegment(plan, "third")?.sceneId).toBe("first");
		expect(getNextProjectPlaybackSegment(plan, "first")).toBeNull();
	});

	it("recognizes a source-contiguous scene handoff", () => {
		const contiguous = buildProjectPlaybackPlan([
			scene("first", 8, {
				trimRegions: [{ id: "after", startMs: 4000, endMs: 8000 }],
			}),
			scene("second", 8, {
				trimRegions: [{ id: "before", startMs: 0, endMs: 4000 }],
			}),
		]);
		const discontinuous = buildProjectPlaybackPlan([scene("first", 2), scene("second", 3)]);

		expect(isContiguousProjectPlaybackHandoff(contiguous[0], contiguous[1])).toBe(true);
		expect(isContiguousProjectPlaybackHandoff(discontinuous[0], discontinuous[1])).toBe(false);
	});
});
