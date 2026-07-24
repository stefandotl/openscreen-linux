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
