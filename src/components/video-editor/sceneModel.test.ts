import { describe, expect, it } from "vitest";
import { INITIAL_EDITOR_STATE } from "@/hooks/useEditorHistory";
import { buildProjectPlaybackPlan, getProjectPlaybackDuration } from "./projectPlayback";
import type { EditorScene } from "./sceneModel";
import {
	canSplitSceneAtSourceTime,
	createSceneName,
	createScenePlaybackKey,
	MAX_SCENE_NAME_LENGTH,
	normalizeSceneName,
	reorderScenes,
	shouldPersistScenes,
	splitSceneAtSourceTime,
} from "./sceneModel";
import { DEFAULT_ANNOTATION_STYLE } from "./types";

const scenes = [{ id: "one" }, { id: "two" }, { id: "three" }, { id: "four" }];

describe("reorderScenes", () => {
	it("moves a scene later in the ordered collection", () => {
		expect(reorderScenes(scenes, "one", 3).map((scene) => scene.id)).toEqual([
			"two",
			"three",
			"one",
			"four",
		]);
	});

	it("moves a scene earlier in the ordered collection", () => {
		expect(reorderScenes(scenes, "four", 1).map((scene) => scene.id)).toEqual([
			"one",
			"four",
			"two",
			"three",
		]);
	});

	it("keeps the same array when the drop does not change the order", () => {
		expect(reorderScenes(scenes, "two", 2)).toBe(scenes);
	});
});

describe("createScenePlaybackKey", () => {
	it("reinitializes playback when another scene uses the same media path", () => {
		const firstKey = createScenePlaybackKey("scene-1", "file:///recording.webm", null);
		const secondKey = createScenePlaybackKey("scene-2", "file:///recording.webm", null);

		expect(secondKey).not.toBe(firstKey);
	});
});

describe("scene names", () => {
	it("creates the first unused default name after scenes are deleted or renamed", () => {
		expect(createSceneName([{ name: "Scene 1" }, { name: "Intro" }, { name: "Scene 3" }])).toBe(
			"Scene 2",
		);
	});

	it("normalizes user-entered names without accepting blank values", () => {
		expect(normalizeSceneName("  Product demo  ")).toBe("Product demo");
		expect(normalizeSceneName("   ")).toBeNull();
		expect(normalizeSceneName("x".repeat(MAX_SCENE_NAME_LENGTH + 10))).toHaveLength(
			MAX_SCENE_NAME_LENGTH,
		);
	});

	it("persists a single scene only when its stable name carries project information", () => {
		expect(shouldPersistScenes([{ name: "Scene 1" }])).toBe(false);
		expect(shouldPersistScenes([{ name: "Introduction" }])).toBe(true);
		expect(shouldPersistScenes([{ name: "Scene 1" }, { name: "Scene 2" }])).toBe(true);
	});
});

describe("splitSceneAtSourceTime", () => {
	const scene: EditorScene = {
		id: "scene-1",
		name: "Scene 1",
		media: { screenVideoPath: "/tmp/recording.webm", webcamVideoPath: "/tmp/webcam.webm" },
		editor: {
			...INITIAL_EDITOR_STATE,
			trimRegions: [{ id: "existing-trim", startMs: 2000, endMs: 2500 }],
			zoomRegions: [
				{
					id: "left-zoom",
					startMs: 500,
					endMs: 1500,
					depth: 2,
					focus: { cx: 0.25, cy: 0.25 },
				},
				{
					id: "crossing-zoom",
					startMs: 3500,
					endMs: 4500,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
				},
				{
					id: "right-zoom",
					startMs: 6000,
					endMs: 7000,
					depth: 2,
					focus: { cx: 0.75, cy: 0.75 },
				},
			],
			speedRegions: [{ id: "crossing-speed", startMs: 3000, endMs: 5000, speed: 2 }],
			annotationRegions: [
				{
					id: "crossing-caption",
					startMs: 3500,
					endMs: 4500,
					type: "text",
					content: "Across both scenes",
					position: { x: 50, y: 80 },
					size: { width: 40, height: 20 },
					style: { ...DEFAULT_ANNOTATION_STYLE },
					zIndex: 1,
				},
				{
					id: "right-caption",
					startMs: 5500,
					endMs: 6500,
					type: "text",
					content: "Right",
					position: { x: 50, y: 50 },
					size: { width: 30, height: 20 },
					style: { ...DEFAULT_ANNOTATION_STYLE },
					zIndex: 2,
				},
			],
		},
	};

	it("creates two adjacent scene views over the same media", () => {
		const result = splitSceneAtSourceTime({
			scene,
			splitTimeMs: 4000,
			durationMs: 8000,
			secondSceneId: "scene-2",
			secondSceneName: "Scene 2",
		});

		expect(result).not.toBeNull();
		expect(result?.firstScene.media).toEqual(scene.media);
		expect(result?.secondScene.media).toEqual(scene.media);
		expect(result?.firstScene.editor.trimRegions).toEqual([
			{ id: "trim-split-scene-1-1", startMs: 2000, endMs: 2500 },
			{
				id: "trim-split-scene-1-2",
				startMs: 4000,
				endMs: 8000,
				source: "scene-split",
			},
		]);
		expect(result?.secondScene.editor.trimRegions).toEqual([
			{
				id: "trim-split-scene-2-1",
				startMs: 0,
				endMs: 4000,
				source: "scene-split",
			},
		]);
		expect(result?.firstScene.editor.zoomRegions.map((region) => region.id)).toEqual([
			"left-zoom",
			"crossing-zoom",
		]);
		expect(result?.secondScene.editor.zoomRegions.map((region) => region.id)).toEqual([
			"crossing-zoom",
			"right-zoom",
		]);
		expect(result?.firstScene.editor.speedRegions).toHaveLength(1);
		expect(result?.secondScene.editor.speedRegions).toHaveLength(1);
		expect(result?.firstScene.editor.annotationRegions.map((region) => region.id)).toEqual([
			"crossing-caption",
		]);
		expect(result?.secondScene.editor.annotationRegions.map((region) => region.id)).toEqual([
			"crossing-caption",
			"right-caption",
		]);

		const plan = buildProjectPlaybackPlan(
			[result?.firstScene, result?.secondScene].flatMap((splitScene) =>
				splitScene
					? [
							{
								id: splitScene.id,
								name: splitScene.name,
								sourceDurationSeconds: 8,
								trimRegions: splitScene.editor.trimRegions,
								speedRegions: splitScene.editor.speedRegions,
							},
						]
					: [],
			),
		);
		expect(plan.map((segment) => segment.sceneId)).toEqual(["scene-1", "scene-2"]);
		expect(getProjectPlaybackDuration(plan)).toBe(6.5);
	});

	it("rejects boundaries, trimmed points, and halves without enough playable media", () => {
		expect(canSplitSceneAtSourceTime(scene.editor, 0, 8000)).toBe(false);
		expect(canSplitSceneAtSourceTime(scene.editor, 2250, 8000)).toBe(false);
		expect(canSplitSceneAtSourceTime(scene.editor, 7950, 8000)).toBe(false);
		expect(canSplitSceneAtSourceTime(scene.editor, 4000, 8000)).toBe(true);
	});

	it("does not share mutable editor state between the two scenes", () => {
		const result = splitSceneAtSourceTime({
			scene,
			splitTimeMs: 4000,
			durationMs: 8000,
			secondSceneId: "scene-2",
			secondSceneName: "Scene 2",
		});
		if (!result) throw new Error("Expected a split result");

		result.secondScene.editor.zoomRegions[0].focus.cx = 0.9;
		expect(result.firstScene.editor.zoomRegions[1].focus.cx).toBe(0.5);
	});
});
