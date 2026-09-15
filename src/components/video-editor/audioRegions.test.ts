import { describe, expect, it } from "vitest";
import { INITIAL_EDITOR_STATE } from "@/hooks/useEditorHistory";
import {
	type AudioRegion,
	audioGainAt,
	resizeAudioRegion,
	validateAudioRegions,
} from "./audioRegions";
import { normalizeProjectEditor } from "./projectPersistence";
import { mergeScenesAtCut, splitSceneAtSourceTime } from "./sceneModel";

const clip: AudioRegion = {
	id: "music",
	name: "Music.wav",
	sourcePath: "/tmp/music.wav",
	startMs: 1000,
	endMs: 5000,
	sourceStartMs: 500,
	sourceDurationMs: 8000,
	volume: 0.5,
	fadeInMs: 1000,
	fadeOutMs: 1000,
};

describe("scene audio clips", () => {
	it("moves a clip without changing its source offset, and trims from the left without slipping audio", () => {
		expect(resizeAudioRegion(clip, { start: 2000, end: 6000 })).toMatchObject({
			startMs: 2000,
			endMs: 6000,
			sourceStartMs: 500,
		});
		expect(resizeAudioRegion(clip, { start: 2000, end: 5000 })).toMatchObject({
			startMs: 2000,
			endMs: 5000,
			sourceStartMs: 1500,
		});
		expect(resizeAudioRegion(clip, { start: 0, end: 5000 })).toMatchObject({
			startMs: 500,
			endMs: 5000,
			sourceStartMs: 0,
		});
		expect(resizeAudioRegion(clip, { start: 1000, end: 10000 }).endMs).toBe(8500);
	});
	it("keeps source offsets and fades through split, save/load and merge", () => {
		const split = splitSceneAtSourceTime({
			scene: {
				id: "one",
				name: "One",
				media: { screenVideoPath: "/tmp/source.mp4" },
				editor: { ...INITIAL_EDITOR_STATE, audioRegions: [clip] },
			},
			splitTimeMs: 3000,
			durationMs: 6000,
			secondSceneId: "two",
			secondSceneName: "Two",
		})!;
		for (const scene of [split.firstScene, split.secondScene]) {
			expect(normalizeProjectEditor(JSON.parse(JSON.stringify(scene.editor))).audioRegions).toEqual(
				[clip],
			);
		}
		// Scene trims keep the common source clock: the second half resumes at 2.5s into the audio.
		expect(clip.sourceStartMs + 3000 - clip.startMs).toBe(2500);
		const merged = mergeScenesAtCut(split.firstScene, split.secondScene)!;
		expect(merged.mergedScene.editor.audioRegions).toEqual([clip]);
		expect(merged.hasEditorConflicts).toBe(false);
	});
	it("loads older projects without audio and rejects malformed saved clips", () => {
		expect(normalizeProjectEditor({}).audioRegions).toEqual([]);
		expect(() => validateAudioRegions([{ ...clip, volume: Number.NaN }])).toThrow();
		expect(() => validateAudioRegions([{ ...clip, sourceDurationMs: 100 }])).toThrow();
		expect(() => validateAudioRegions([clip, clip])).toThrow();
	});
	it("applies gain only inside the clip and matches linear fades", () => {
		expect([999, 1000, 1500, 3000, 4500, 5000].map((time) => audioGainAt(clip, time))).toEqual([
			0, 0, 0.25, 0.5, 0.25, 0,
		]);
	});
});
