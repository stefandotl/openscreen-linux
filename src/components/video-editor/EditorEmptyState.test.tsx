import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorEmptyState } from "./EditorEmptyState";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => {
		const messages: Record<string, string> = {
			"emptyState.title": "No project open",
			"emptyState.description": "Import a video or load a project.",
			"emptyState.sceneTitle": "This scene is empty",
			"emptyState.sceneDescription": "Record or import a video for this scene.",
			"emptyState.recordSceneButton": "Record Scene",
			"emptyState.importVideoButton": "Import Video File…",
			"emptyState.loadProjectButton": "Load Project…",
			"emptyState.supportedFormats": "Supported formats",
			"emptyState.dragDropHint": "Drop a project",
		};
		return messages[key] ?? key;
	},
}));

describe("EditorEmptyState scene mode", () => {
	it("makes scene recording the contextual primary action", () => {
		const onStartRecording = vi.fn();
		render(
			<EditorEmptyState
				mode="scene"
				onVideoImported={vi.fn()}
				onProjectOpened={vi.fn()}
				onStartRecording={onStartRecording}
				recordVideoLabel="Record Scene"
			/>,
		);

		expect(screen.getByRole("heading", { name: "This scene is empty" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Record Scene" }));
		expect(onStartRecording).toHaveBeenCalledOnce();
		expect(screen.getByRole("button", { name: "Import Video File…" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Load Project…" })).not.toBeInTheDocument();
	});
});
