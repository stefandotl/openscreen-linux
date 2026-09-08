import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/contexts/I18nContext";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("./KeyboardShortcutsHelp", () => ({ KeyboardShortcutsHelp: () => null }));

beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {
				// jsdom does not calculate layout.
			}
			unobserve() {
				// jsdom does not calculate layout.
			}
			disconnect() {
				// jsdom does not calculate layout.
			}
		},
	);
});

function renderSettingsPanel(
	onWebcamVideoOffsetChange = vi.fn(),
	onWebcamVideoOffsetCommit = vi.fn(),
) {
	const view = render(
		<I18nProvider>
			<TooltipProvider>
				<SettingsPanel
					selected=""
					onWallpaperChange={vi.fn()}
					aspectRatio="16:9"
					hasWebcam
					webcamVideoOffsetMs={200}
					onWebcamVideoOffsetChange={onWebcamVideoOffsetChange}
					onWebcamVideoOffsetCommit={onWebcamVideoOffsetCommit}
				/>
			</TooltipProvider>
		</I18nProvider>,
	);

	fireEvent.click(screen.getByTitle("Layout"));
	return { ...view, onWebcamVideoOffsetChange, onWebcamVideoOffsetCommit };
}

describe("SettingsPanel webcam A/V sync", () => {
	it("keeps the slider collapsed until A/V sync is explicitly opened", () => {
		renderSettingsPanel();
		const toggle = screen.getByRole("button", { name: /A\/V Sync/ });

		expect(screen.queryByRole("slider", { name: "A/V Sync" })).toBeNull();
		expect(toggle.textContent).toContain("+200 ms");

		fireEvent.click(toggle);
		expect(screen.getByRole("slider", { name: "A/V Sync" })).toBeTruthy();
	});

	it("previews slider changes immediately and commits them when interaction ends", () => {
		const { onWebcamVideoOffsetChange, onWebcamVideoOffsetCommit } = renderSettingsPanel();
		fireEvent.click(screen.getByRole("button", { name: /A\/V Sync/ }));
		const slider = screen.getByRole("slider", { name: "A/V Sync" });

		fireEvent.keyDown(slider, { key: "ArrowRight" });
		expect(onWebcamVideoOffsetChange).toHaveBeenCalledWith(210);

		fireEvent.keyUp(slider, { key: "ArrowRight" });
		expect(onWebcamVideoOffsetCommit).toHaveBeenCalledWith(210);
	});
});
