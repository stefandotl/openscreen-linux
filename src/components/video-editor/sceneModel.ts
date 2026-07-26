import type { EditorState } from "@/hooks/useEditorHistory";
import type { ProjectMedia } from "@/lib/recordingSession";

export interface EditorScene {
	id: string;
	name: string;
	media: ProjectMedia | null;
	editor: EditorState;
}

export function createSceneId() {
	return `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createSceneName(index: number) {
	return `Scene ${index + 1}`;
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
