import { describe, expect, it } from "vitest";
import { createScenePlaybackKey, reorderScenes } from "./sceneModel";

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
