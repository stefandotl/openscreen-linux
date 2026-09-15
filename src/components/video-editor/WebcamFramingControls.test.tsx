import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { useEditorHistory } from "@/hooks/useEditorHistory";
import { DEFAULT_WEBCAM_FRAMING } from "./types";
import { WebcamFramingControls } from "./WebcamFramingControls";

afterEach(cleanup);
beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {
				/* jsdom has no layout. */
			}
			unobserve() {
				/* jsdom has no layout. */
			}
			disconnect() {
				/* jsdom has no layout. */
			}
		},
	);
});

function Harness() {
	const { state, updateState, commitState, pushState, undo, redo } = useEditorHistory();
	return (
		<I18nProvider>
			<WebcamFramingControls
				value={state.webcamFraming}
				onChange={(value) => updateState({ webcamFraming: value })}
				onCommit={commitState}
				onReset={() => pushState({ webcamFraming: { ...DEFAULT_WEBCAM_FRAMING } })}
			/>
			<button type="button" onClick={undo}>
				Undo
			</button>
			<button type="button" onClick={redo}>
				Redo
			</button>
			<output>{JSON.stringify(state.webcamFraming)}</output>
		</I18nProvider>
	);
}

function changeSlider(name: string, key: string) {
	const slider = screen.getByRole("slider", { name });
	fireEvent.keyDown(slider, { key });
	fireEvent.keyUp(slider, { key });
}

describe("webcam framing controls", () => {
	it("previews changes, supports undo/redo and resets all framing settings", () => {
		const { container } = render(<Harness />);
		const value = () => JSON.parse(container.querySelector("output")!.textContent!);
		changeSlider("Zoom", "ArrowRight");
		expect(value().zoom).toBe(1.05);
		changeSlider("Horizontal position", "End");
		expect(value().x).toBe(1);
		fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		expect(value()).toEqual({ zoom: 1.05, x: 0.5, y: 0.5 });
		fireEvent.click(screen.getByRole("button", { name: "Redo" }));
		expect(value().x).toBe(1);
		changeSlider("Vertical position", "Home");
		expect(value().y).toBe(0);
		fireEvent.click(screen.getByRole("button", { name: "Reset webcam framing" }));
		expect(value()).toEqual(DEFAULT_WEBCAM_FRAMING);
		fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		expect(value()).toEqual({ zoom: 1.05, x: 1, y: 0 });
	});
});
