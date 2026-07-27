import type { EditorState } from "@/hooks/useEditorHistory";
import type { ProjectMedia } from "@/lib/recordingSession";

export interface EditorScene {
	id: string;
	name: string;
	media: ProjectMedia | null;
	editor: EditorState;
}

export const MAX_SCENE_NAME_LENGTH = 80;

export function createSceneId() {
	return `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createSceneName(existingScenes: readonly Pick<EditorScene, "name">[]) {
	const existingNames = new Set(
		existingScenes.map((scene) => scene.name.trim().toLocaleLowerCase()),
	);
	let sceneNumber = 1;
	while (existingNames.has(`scene ${sceneNumber}`)) {
		sceneNumber += 1;
	}
	return `Scene ${sceneNumber}`;
}

export function normalizeSceneName(value: string) {
	const trimmedName = value.trim();
	return trimmedName ? trimmedName.slice(0, MAX_SCENE_NAME_LENGTH) : null;
}

export function shouldPersistScenes(scenes: readonly Pick<EditorScene, "name">[]) {
	return scenes.length > 1 || (scenes.length === 1 && scenes[0].name !== "Scene 1");
}

export function createScenePlaybackKey(
	sceneId: string | null,
	videoPath: string,
	webcamVideoPath: string | null,
) {
	return JSON.stringify([sceneId, videoPath, webcamVideoPath]);
}

export function reorderScenes<T extends { id: string }>(
	scenes: T[],
	sceneId: string,
	targetIndex: number,
): T[] {
	const sourceIndex = scenes.findIndex((scene) => scene.id === sceneId);
	if (sourceIndex < 0) return scenes;

	const boundedTargetIndex = Math.max(0, Math.min(targetIndex, scenes.length));
	const insertionIndex =
		sourceIndex < boundedTargetIndex ? boundedTargetIndex - 1 : boundedTargetIndex;
	if (sourceIndex === insertionIndex) return scenes;

	const reordered = [...scenes];
	const [scene] = reordered.splice(sourceIndex, 1);
	reordered.splice(insertionIndex, 0, scene);
	return reordered;
}
