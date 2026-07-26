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
