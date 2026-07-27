import "@testing-library/jest-dom";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProjectPlaybackPreloader, {
	PROJECT_MEDIA_PRELOAD_TIMEOUT_MS,
} from "./ProjectPlaybackPreloader";
import type { EditorScene } from "./sceneModel";

const scenes: EditorScene[] = [
	{
		id: "active",
		name: "Active",
		media: { screenVideoPath: "/recordings/active.webm" },
		editor: {} as EditorScene["editor"],
	},
	{
		id: "next",
		name: "Next scene",
		media: {
			screenVideoPath: "/recordings/next.webm",
			webcamVideoPath: "/recordings/next-camera.webm",
		},
		editor: {} as EditorScene["editor"],
	},
	{
		id: "empty",
		name: "Empty",
		media: null,
		editor: {} as EditorScene["editor"],
	},
];

describe("ProjectPlaybackPreloader", () => {
	it("keeps the next scene preloaded and reports its metadata", () => {
		const onDuration = vi.fn();
		const onReady = vi.fn();
		const { container } = render(
			<ProjectPlaybackPreloader
				scenes={scenes}
				toVideoUrl={(path) => `file://${path}`}
				onDuration={onDuration}
				onReady={onReady}
				onError={vi.fn()}
			/>,
		);

		const videos = container.querySelectorAll("video");
		expect(videos).toHaveLength(3);
		const screenVideo = container.querySelector(
			'video[src="file:///recordings/next.webm"]',
		) as HTMLVideoElement;
		const webcamVideo = container.querySelector(
			'video[src="file:///recordings/next-camera.webm"]',
		) as HTMLVideoElement;
		expect(screenVideo).toHaveAttribute("preload", "auto");
		expect(webcamVideo).toBeInTheDocument();

		Object.defineProperty(screenVideo, "duration", { configurable: true, value: 4.25 });
		fireEvent.loadedMetadata(screenVideo);
		expect(onDuration).toHaveBeenCalledWith("next", "/recordings/next.webm", 4.25);
		expect(onReady).not.toHaveBeenCalled();
		fireEvent.loadedMetadata(webcamVideo);
		expect(onReady).toHaveBeenCalledWith("next", "/recordings/next.webm");
	});

	it("reports the failing scene instead of silently skipping it", () => {
		const onError = vi.fn();
		const { container } = render(
			<ProjectPlaybackPreloader
				scenes={scenes}
				toVideoUrl={(path) => `file://${path}`}
				onDuration={vi.fn()}
				onReady={vi.fn()}
				onError={onError}
			/>,
		);

		fireEvent.error(
			container.querySelector('video[src="file:///recordings/next.webm"]') as HTMLVideoElement,
		);
		expect(onError).toHaveBeenCalledWith(
			"next",
			"/recordings/next.webm",
			'Failed to preload media for scene "Next scene"',
		);

		fireEvent.error(
			container.querySelector(
				'video[src="file:///recordings/next-camera.webm"]',
			) as HTMLVideoElement,
		);
		expect(onError).toHaveBeenCalledWith(
			"next",
			"/recordings/next.webm",
			'Failed to preload webcam media for scene "Next scene"',
		);
	});

	it("fails loudly when metadata loading stalls", () => {
		vi.useFakeTimers();
		const onError = vi.fn();
		const { unmount } = render(
			<ProjectPlaybackPreloader
				scenes={scenes}
				toVideoUrl={(path) => `file://${path}`}
				onDuration={vi.fn()}
				onReady={vi.fn()}
				onError={onError}
			/>,
		);

		vi.advanceTimersByTime(PROJECT_MEDIA_PRELOAD_TIMEOUT_MS);
		expect(onError).toHaveBeenCalledWith(
			"next",
			"/recordings/next.webm",
			'Timed out while preloading media for scene "Next scene"',
		);
		unmount();
		vi.useRealTimers();
	});
});
