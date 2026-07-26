export class RecordingProjectTransitionState {
	private pendingSceneId: string | null = null;
	private pendingProjectData: unknown | null = null;

	get sceneId() {
		return this.pendingSceneId;
	}

	begin(sceneId?: string, projectData?: unknown) {
		this.pendingSceneId = typeof sceneId === "string" && sceneId.length > 0 ? sceneId : null;
		this.pendingProjectData =
			this.pendingSceneId && projectData && typeof projectData === "object" ? projectData : null;
	}

	consumeProjectData() {
		const projectData = this.pendingProjectData;
		this.pendingProjectData = null;
		return projectData;
	}

	clear() {
		this.pendingSceneId = null;
		this.pendingProjectData = null;
	}
}

export function beginRecordingProjectTransition(
	transition: RecordingProjectTransitionState,
	clearCurrentRecordingSession: () => void,
	sceneId?: string,
	projectData?: unknown,
) {
	transition.begin(sceneId, projectData);
	// A session already present here belongs to the previous editor visit. Only a
	// session stored after this transition may be attached to the target scene.
	clearCurrentRecordingSession();
}
