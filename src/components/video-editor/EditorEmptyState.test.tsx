import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorEmptyState } from "./EditorEmptyState";

const { importVideoFileFromPath, setCurrentVideoPath, translate } = vi.hoisted(() => {
	const messages: Record<string, string> = {
		"emptyState.title": "No project open",
		"emptyState.description": "Import a video or load a project.",
		"emptyState.sceneTitle": "This scene is empty",
		"emptyState.sceneDescription": "Record or import a video for this scene.",
		"emptyState.recordSceneButton": "Record Scene",
		"emptyState.importVideoButton": "Import Video File…",
		"emptyState.loadProjectButton": "Load Project…",
		"emptyState.supportedFormats": "Supported formats",
		"emptyState.dragDropHint": "Video file or project",
		"emptyState.dropOverlay": "Drop video or project here",
	};
	return {
		importVideoFileFromPath: vi.fn(),
		setCurrentVideoPath: vi.fn(),
		translate: (key: string) => messages[key] ?? key,
	};
});

vi.mock("@/native", () => ({
	nativeBridgeClient: {
		project: {
			importVideoFileFromPath,
			setCurrentVideoPath,
		},
	},
}));

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => translate,
}));

beforeEach(() => {
	importVideoFileFromPath.mockReset();
	setCurrentVideoPath.mockReset();
});

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

describe("EditorEmptyState project mode", () => {
	it("opens a supported video dropped onto the field", async () => {
		const recordingPath = "/app-data/recordings/recording-1800000000000.mp4";
		importVideoFileFromPath.mockResolvedValue({ success: true, path: recordingPath });
		const onVideoImported = vi.fn();
		const getPathForFile = vi.fn().mockReturnValue(recordingPath);
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { getPathForFile },
		});

		render(
			<EditorEmptyState
				onVideoImported={onVideoImported}
				onProjectOpened={vi.fn()}
				onStartRecording={vi.fn()}
			/>,
		);

		const videoFile = new File(["video"], "recording-1800000000000.mp4", {
			type: "video/mp4",
		});
		fireEvent.drop(screen.getByTestId("video-project-drop-zone"), {
			dataTransfer: { files: [videoFile] },
		});

		await waitFor(() => {
			expect(getPathForFile).toHaveBeenCalledWith(videoFile);
			expect(importVideoFileFromPath).toHaveBeenCalledWith(recordingPath);
			expect(onVideoImported).toHaveBeenCalledWith(recordingPath);
		});
		expect(screen.getByRole("button", { name: "Import Video File…" })).toBeInTheDocument();
	});
});
