import type { AiCutModel } from "./aiCut";
import type { CaptionEngine } from "./captioning/transcribe";

// Only models with documented word timing belong in the captions picker.
// Reviewed 2026-10-04 against the linked OpenRouter model pages.
export const OPENROUTER_CAPTION_MODELS = [
	{ id: "assemblyai/universal-3-5-pro", name: "AssemblyAI · Universal-3.5 Pro" },
	{ id: "fish-audio/transcribe-1", name: "Fish Audio · Transcribe 1" },
	{ id: "fish-audio/transcribe-1-pro", name: "Fish Audio · Transcribe 1 Pro" },
	{ id: "openai/whisper-1", name: "OpenAI · Whisper" },
] as const;

export function isOpenRouterCaptionModel(value: unknown): value is string {
	return OPENROUTER_CAPTION_MODELS.some((model) => model.id === value);
}

export interface OpenRouterSettings {
	/** AI Cut model; preserves the existing openrouter.json field. */
	model: string;
	captionEngine: CaptionEngine;
	transcriptionModel: string;
	hasApiKey: boolean;
	keyStorage: "encrypted" | "session" | "none";
	canStoreKey: boolean;
}
export interface OpenRouterSettingsUpdate {
	model?: string;
	captionEngine?: CaptionEngine;
	transcriptionModel?: string;
	apiKey?: string;
}
export interface OpenRouterAPI {
	getSettings(): Promise<OpenRouterSettings>;
	updateSettings(update: OpenRouterSettingsUpdate): Promise<OpenRouterSettings>;
	listAiCutModels(): Promise<AiCutModel[]>;
}
