import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { useEditorHistory } from "@/hooks/useEditorHistory";
import { type AiCutAPI, type AiCutSettings, aiCutSuggestionsToTrims } from "@/lib/aiCut";
import { AiCutDialog } from "./AiCutDialog";

const settings: AiCutSettings = {
	model: "provider/model",
	hasApiKey: true,
	keyStorage: "encrypted",
	canStoreKey: true,
};
const suggestions = [
	{ id: "first", startMs: 1000, endMs: 1400, text: "um", reason: "Filler" },
	{ id: "second", startMs: 2500, endMs: 3200, text: "[silence]", reason: "Long pause" },
];
let api: AiCutAPI;
let transcribe: ReturnType<typeof vi.fn>;
beforeEach(() => {
	localStorage.clear();
	api = {
		getSettings: vi.fn().mockResolvedValue(settings),
		updateSettings: vi.fn().mockResolvedValue(settings),
		listModels: vi.fn().mockResolvedValue([]),
		analyze: vi.fn().mockResolvedValue(suggestions),
		cancel: vi.fn().mockResolvedValue(undefined),
	};
	transcribe = vi.fn().mockResolvedValue({
		granularity: "word",
		truncated: false,
		segments: [
			{ text: "Hello", startSec: 0.2, endSec: 0.8 },
			{ text: "um", startSec: 1, endSec: 1.4 },
			{ text: "world", startSec: 1.8, endSec: 2.4 },
		],
	});
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			aiCut: api,
			transcribeVideoCaptions: transcribe,
			detectSilence: vi.fn().mockResolvedValue({
				success: true,
				regions: [{ startMs: 2500, endMs: 3200 }],
				removableDurationMs: 700,
			}),
			onCaptionTranscriptionStatus: () => vi.fn(),
			setLocale: vi.fn(),
		},
	});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
function mount(onApply = vi.fn()) {
	return render(
		<I18nProvider>
			<AiCutDialog
				videoPath="file:///source.mp4"
				durationMs={4000}
				trimRegions={[]}
				onClose={vi.fn()}
				onApply={onApply}
			/>
		</I18nProvider>,
	);
}
async function analyze() {
	await waitFor(() => expect(screen.getByRole("button", { name: "Analyze scene" })).toBeEnabled());
	fireEvent.click(screen.getByRole("button", { name: "Analyze scene" }));
}
describe("AI Cut review", () => {
	it("makes no model call until requested, reviews individual suggestions and applies only selected cuts", async () => {
		const apply = vi.fn();
		mount(apply);
		await waitFor(() => expect(screen.getByDisplayValue("provider/model")).toBeInTheDocument());
		expect(api.analyze).not.toHaveBeenCalled();
		await analyze();
		await screen.findByText("2 selected cuts · 1.1 seconds removed (source time)");
		expect(apply).not.toHaveBeenCalled();
		fireEvent.click(screen.getAllByRole("checkbox")[1]);
		fireEvent.click(screen.getByRole("button", { name: "Apply selected cuts" }));
		expect(apply).toHaveBeenCalledWith([suggestions[0]]);
	});
	it("reuses the transcript when changing the instruction", async () => {
		mount();
		await analyze();
		await screen.findByText("2 selected cuts · 1.1 seconds removed (source time)");
		fireEvent.click(screen.getByRole("button", { name: "Custom instruction" }));
		expect(screen.getByRole("button", { name: "Analyze scene" })).toBeDisabled();
		fireEvent.change(screen.getByRole("textbox", { name: /For example/ }), {
			target: { value: "Keep the introduction" },
		});
		await analyze();
		await waitFor(() => expect(api.analyze).toHaveBeenCalledTimes(2));
		expect(transcribe).toHaveBeenCalledOnce();
		expect(api.analyze).toHaveBeenLastCalledWith(
			expect.objectContaining({ mode: "custom", instructions: "Keep the introduction" }),
		);
	});
	it("does not send a truncated transcription to OpenRouter", async () => {
		transcribe.mockResolvedValue({ granularity: "word", truncated: true, segments: [] });
		mount();
		await analyze();
		await screen.findByRole("alert");
		expect(api.analyze).not.toHaveBeenCalled();
	});
	it("cancels a pending model call when the source dialog unmounts", async () => {
		let resolve!: (value: typeof suggestions) => void;
		vi.mocked(api.analyze).mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const apply = vi.fn();
		const view = mount(apply);
		await analyze();
		await waitFor(() => expect(api.analyze).toHaveBeenCalledOnce());
		view.unmount();
		expect(api.cancel).toHaveBeenCalledWith(expect.any(String));
		await act(async () => resolve(suggestions));
		expect(apply).not.toHaveBeenCalled();
	});
	it("applies the batch in one history step without changing existing cuts", async () => {
		function Harness() {
			const { state, pushState, undo } = useEditorHistory();
			return (
				<>
					<AiCutDialog
						videoPath="file:///source.mp4"
						durationMs={4000}
						trimRegions={[]}
						onClose={vi.fn()}
						onApply={(cuts) =>
							pushState({ trimRegions: aiCutSuggestionsToTrims(cuts, state.trimRegions) })
						}
					/>
					<button type="button" onClick={undo}>
						Test undo
					</button>
					<output data-testid="cuts">{state.trimRegions.length}</output>
				</>
			);
		}
		render(
			<I18nProvider>
				<Harness />
			</I18nProvider>,
		);
		await analyze();
		await screen.findByRole("button", { name: "Apply selected cuts" });
		fireEvent.click(screen.getByRole("button", { name: "Apply selected cuts" }));
		expect(screen.getByTestId("cuts")).toHaveTextContent("2");
		fireEvent.click(screen.getByRole("button", { name: "Test undo", hidden: true }));
		expect(screen.getByTestId("cuts")).toHaveTextContent("0");
	});
});
