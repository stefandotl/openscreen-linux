import { describe, expect, it } from "vitest";
import {
	createSceneName,
	createScenePlaybackKey,
	MAX_SCENE_NAME_LENGTH,
	normalizeSceneName,
	reorderScenes,
	shouldPersistScenes,
} from "./sceneModel";

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
