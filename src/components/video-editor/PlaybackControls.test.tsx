import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import PlaybackControls from "./PlaybackControls";

describe("PlaybackControls project scope", () => {
	it("renders named scene segments, empty markers, and seeks on the project rail", () => {
		const onSeek = vi.fn();
		render(
			<I18nProvider>
				<PlaybackControls
					isPlaying={false}
					currentTime={2}
					duration={8}
					scope="project"
					showScopeSwitch
					projectSegments={[
						{
							sceneId: "intro",
							name: "Introduction",
							projectStartSeconds: 0,
							projectEndSeconds: 3,
						},
						{
							sceneId: "demo",
							name: "Demo",
							projectStartSeconds: 3,
							projectEndSeconds: 8,
						},
					]}
					projectSceneMarkers={[
						{
							sceneId: "empty",
							name: "Intermission",
							projectTimeSeconds: 3,
							isPlayable: false,
						},
					]}
					onScopeChange={vi.fn()}
					onTogglePlayPause={vi.fn()}
					onSeek={onSeek}
				/>
			</I18nProvider>,
		);

		expect(screen.getByRole("img", { name: "Scene segment: Introduction" })).toHaveAttribute(
			"title",
			"Introduction",
		);
		expect(screen.getByRole("img", { name: "Empty scene: Intermission" })).toBeInTheDocument();

		fireEvent.change(screen.getByRole("slider", { name: "Project timeline" }), {
			target: { value: "3" },
		});
		expect(onSeek).toHaveBeenCalledWith(3);
	});

	it("switches explicitly between scene and project scope", () => {
		const onScopeChange = vi.fn();
		render(
			<I18nProvider>
				<PlaybackControls
					isPlaying={false}
					currentTime={0}
					duration={5}
					showScopeSwitch
					onScopeChange={onScopeChange}
					onTogglePlayPause={vi.fn()}
					onSeek={vi.fn()}
				/>
			</I18nProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Project" }));
		expect(onScopeChange).toHaveBeenCalledWith("project");
	});
});

describe("PlaybackControls preview speed", () => {
	it("shows the current preview speed and reports a picked speed", () => {
		const onPreviewSpeedChange = vi.fn();
		render(
			<I18nProvider>
				<PlaybackControls
					isPlaying={false}
					currentTime={0}
					duration={5}
					previewSpeed={1}
					onPreviewSpeedChange={onPreviewSpeedChange}
					onTogglePlayPause={vi.fn()}
					onSeek={vi.fn()}
				/>
			</I18nProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Playback Speed" }));

		const option = screen.getByRole("button", { name: "2×" });
		expect(option).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(option);

		expect(onPreviewSpeedChange).toHaveBeenCalledWith(2);
	});

	it("marks the active preview speed as pressed", () => {
		render(
			<I18nProvider>
				<PlaybackControls
					isPlaying={false}
					currentTime={0}
					duration={5}
					previewSpeed={3}
					onPreviewSpeedChange={vi.fn()}
					onTogglePlayPause={vi.fn()}
					onSeek={vi.fn()}
				/>
			</I18nProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Playback Speed" }));

		expect(screen.getByRole("button", { name: "3×" })).toHaveAttribute("aria-pressed", "true");
	});

	it("hides the speed control when the editor cannot change preview speed", () => {
		render(
			<I18nProvider>
				<PlaybackControls
					isPlaying={false}
					currentTime={0}
					duration={5}
					onTogglePlayPause={vi.fn()}
					onSeek={vi.fn()}
				/>
			</I18nProvider>,
		);

		expect(screen.queryByRole("button", { name: "Playback Speed" })).not.toBeInTheDocument();
	});
});
