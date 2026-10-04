import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { useEditorHistory } from "@/hooks/useEditorHistory";
import { type AiCutAPI, aiCutSuggestionsToTrims } from "@/lib/aiCut";
import type { SourceTranscript } from "@/lib/captioning/sourceTranscript";
import type { OpenRouterSettings } from "@/lib/openRouter";
import { AiCutDialog } from "./AiCutDialog";

const settings: OpenRouterSettings = {
	captionEngine: "parakeet",
	transcriptionModel: "assemblyai/universal-3-5-pro",
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
			openRouter: {
				getSettings: vi.fn().mockResolvedValue(settings),
				updateSettings: vi.fn().mockResolvedValue(settings),
				listAiCutModels: vi.fn().mockResolvedValue([]),
			},
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
function mount(
	onApply = vi.fn(),
	sourceTranscript?: SourceTranscript,
	onTranscriptReady = vi.fn(),
) {
	return render(
		<I18nProvider>
			<AiCutDialog
				videoPath="file:///source.mp4"
				durationMs={4000}
				trimRegions={[]}
				sourceTranscript={sourceTranscript}
				onTranscriptReady={onTranscriptReady}
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
	it("uses a saved caption transcript without transcribing again, including after reopening", async () => {
		const transcript: SourceTranscript = {
			sourcePath: "/source.mp4",
			sourceDurationSec: 4,
			engine: "openrouter",
			model: "fish-audio/transcribe-1-pro",
			granularity: "word",
			truncated: false,
			segments: [
				{
					text: "Saved words",
					startSec: 0.2,
					endSec: 0.8,
					words: [
						{ text: "Saved", startSec: 0.2, endSec: 0.4 },
						{ text: "words", startSec: 0.5, endSec: 0.8 },
					],
				},
			],
		};
		let view = mount(vi.fn(), transcript);
		await screen.findByLabelText("Use existing transcript · fish-audio/transcribe-1-pro");
		await analyze();
		await waitFor(() => expect(api.analyze).toHaveBeenCalledOnce());
		expect(transcribe).not.toHaveBeenCalled();
		expect(api.analyze).toHaveBeenCalledWith(
			expect.objectContaining({
				units: expect.arrayContaining([
					expect.objectContaining({ text: "Saved", startMs: 200, endMs: 400 }),
				]),
			}),
		);
		view.unmount();
		view = mount(vi.fn(), transcript);
		await analyze();
		await waitFor(() => expect(api.analyze).toHaveBeenCalledTimes(2));
		expect(transcribe).not.toHaveBeenCalled();
	});

	it("uses the saved speech model for a missing transcript and publishes the reusable result", async () => {
		const configured = {
			...settings,
			captionEngine: "openrouter" as const,
			transcriptionModel: "fish-audio/transcribe-1",
		};
		vi.mocked(window.electronAPI.openRouter.getSettings).mockResolvedValue(configured);
		vi.mocked(window.electronAPI.openRouter.updateSettings).mockResolvedValue(configured);
		const ready = vi.fn();
		mount(vi.fn(), undefined, ready);
		await screen.findByText(
			"No complete transcript exists for this video. Choose a transcription model.",
		);
		await analyze();
		await waitFor(() => expect(api.analyze).toHaveBeenCalledOnce());
		expect(transcribe).toHaveBeenCalledWith(
			expect.objectContaining({
				engine: "openrouter",
				model: "fish-audio/transcribe-1",
				trimRegions: [],
			}),
		);
		expect(ready).toHaveBeenCalledWith(
			expect.objectContaining({
				sourcePath: "/source.mp4",
				engine: "openrouter",
				model: "fish-audio/transcribe-1",
			}),
		);
	});

	it("offers explicit regeneration and never reuses a transcript from a different video", async () => {
		const transcript: SourceTranscript = {
			sourcePath: "/source.mp4",
			sourceDurationSec: 4,
			engine: "parakeet",
			granularity: "word",
			truncated: false,
			segments: [{ text: "old", startSec: 0.2, endSec: 0.8 }],
		};
		const view = mount(vi.fn(), transcript);
		await screen.findByLabelText("Use existing transcript · Parakeet");
		fireEvent.click(screen.getByLabelText("Create a new transcript"));
		await analyze();
		await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
		view.unmount();
		mount(vi.fn(), { ...transcript, sourcePath: "/different.mp4" });
		await analyze();
		await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
	});

	it("cancels a cloud transcription when the source dialog unmounts", async () => {
		const configured = { ...settings, captionEngine: "openrouter" as const };
		vi.mocked(window.electronAPI.openRouter.getSettings).mockResolvedValue(configured);
		vi.mocked(window.electronAPI.openRouter.updateSettings).mockResolvedValue(configured);
		transcribe.mockImplementation(
			() =>
				new Promise(() => {
					/* Leave transcription pending until the dialog closes. */
				}),
		);
		const cancel = vi.fn().mockResolvedValue(undefined);
		window.electronAPI.cancelCaptionTranscription = cancel;
		const view = mount();
		await analyze();
		await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
		const request = transcribe.mock.calls[0][0];
		view.unmount();
		expect(cancel).toHaveBeenCalledWith(request.requestId);
		expect(api.analyze).not.toHaveBeenCalled();
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
