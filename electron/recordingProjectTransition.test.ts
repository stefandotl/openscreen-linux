import { describe, expect, it } from "vitest";
import { RecordingProjectTransitionState } from "./recordingProjectTransition";

describe("RecordingProjectTransitionState", () => {
	it("keeps a scene-targeted project snapshot for exactly one editor restore", () => {
		const transition = new RecordingProjectTransitionState();
		const project = { scenes: [{ id: "scene-2", media: null }] };

		transition.begin("scene-2", project);

		expect(transition.sceneId).toBe("scene-2");
		expect(transition.consumeProjectData()).toBe(project);
		expect(transition.consumeProjectData()).toBeNull();
		expect(transition.sceneId).toBe("scene-2");
	});

	it("does not retain project data for a standalone recording", () => {
		const transition = new RecordingProjectTransitionState();

		transition.begin(undefined, { scenes: [] });

		expect(transition.sceneId).toBeNull();
		expect(transition.consumeProjectData()).toBeNull();
	});

	it("clears both the scene target and any unconsumed project data", () => {
		const transition = new RecordingProjectTransitionState();
		transition.begin("scene-1", { scenes: [] });

		transition.clear();

		expect(transition.sceneId).toBeNull();
		expect(transition.consumeProjectData()).toBeNull();
	});
});
