import type { TrimRegion } from "@/components/video-editor/types";
import type { CaptionSegment } from "./captioning/transcribe";
import { type SilenceInterval, subtractExistingTrimSpans } from "./silenceDetection";

export type AiCutMode = "cleanup" | "tighten" | "custom";
export interface AiCutUnit extends SilenceInterval {
	id: number;
	text: string;
	kind: "word" | "pause";
}
export interface AiCutSuggestion extends SilenceInterval {
	id: string;
	text: string;
	reason: string;
}
export interface AiCutRequest {
	requestId: string;
	mode: AiCutMode;
	instructions: string;
	language: string;
	durationMs: number;
	existingTrims: SilenceInterval[];
	units: AiCutUnit[];
}
export interface AiCutSettings {
	model: string;
	hasApiKey: boolean;
	keyStorage: "encrypted" | "session" | "none";
	canStoreKey: boolean;
}
export interface AiCutSettingsUpdate {
	model: string;
	apiKey?: string;
}
export interface AiCutModel {
	id: string;
	name: string;
}
export interface AiCutAPI {
	getSettings(): Promise<AiCutSettings>;
	updateSettings(update: AiCutSettingsUpdate): Promise<AiCutSettings>;
	listModels(): Promise<AiCutModel[]>;
	analyze(request: AiCutRequest): Promise<AiCutSuggestion[]>;
	cancel(requestId: string): Promise<void>;
}

function overlaps(a: SilenceInterval, b: SilenceInterval) {
	return a.startMs < b.endMs && a.endMs > b.startMs;
}

/** Stable word references prevent the model from inventing timestamps. */
export function buildAiCutUnits(
	segments: CaptionSegment[],
	pauses: SilenceInterval[],
	existingTrims: SilenceInterval[],
	durationMs: number,
): AiCutUnit[] {
	const words = segments
		.flatMap((segment) => (segment.words?.length ? segment.words : [segment]))
		.map((word) => ({
			startMs: Math.round(word.startSec * 1000),
			endMs: Math.round(word.endSec * 1000),
			text: word.text.trim(),
			kind: "word" as const,
		}))
		.filter(
			(word) =>
				word.text &&
				word.startMs >= 0 &&
				word.endMs > word.startMs &&
				word.endMs <= durationMs &&
				!existingTrims.some((trim) => overlaps(word, trim)),
		)
		.sort((a, b) => a.startMs - b.startMs);
	const silence = subtractExistingTrimSpans(pauses, existingTrims)
		.filter(
			(pause) =>
				pause.startMs >= 0 &&
				pause.endMs <= durationMs &&
				!words.some((word) => overlaps(word, pause)),
		)
		.map((pause) => ({ ...pause, kind: "pause" as const, text: "[silence]" }));
	return [...words, ...silence]
		.sort((a, b) => a.startMs - b.startMs)
		.map((unit, id) => ({ ...unit, id }));
}

export function validateAiCutRequest(value: AiCutRequest): void {
	if (
		!value ||
		typeof value.requestId !== "string" ||
		!/^[a-zA-Z0-9-]{1,80}$/.test(value.requestId) ||
		!["cleanup", "tighten", "custom"].includes(value.mode) ||
		typeof value.instructions !== "string" ||
		value.instructions.length > 8000 ||
		typeof value.language !== "string" ||
		!/^[a-zA-Z-]{2,20}$/.test(value.language) ||
		!Number.isFinite(value.durationMs) ||
		value.durationMs <= 0 ||
		!Array.isArray(value.units) ||
		!value.units.length ||
		!Array.isArray(value.existingTrims) ||
		JSON.stringify(value).length > 4_000_000
	) {
		throw new Error(
			"Invalid AI cut request or transcript too large (maximum 4 MB). Split the scene and try again.",
		);
	}
	if (value.mode === "custom" && !value.instructions.trim())
		throw new Error("Enter an editing instruction.");
	const validSpan = (span: SilenceInterval) =>
		span &&
		Number.isFinite(span.startMs) &&
		Number.isFinite(span.endMs) &&
		span.startMs >= 0 &&
		span.endMs > span.startMs &&
		span.endMs <= value.durationMs;
	if (value.existingTrims.some((trim) => !validSpan(trim)))
		throw new Error("Invalid existing cuts.");
	for (const [index, unit] of value.units.entries()) {
		if (
			!validSpan(unit) ||
			unit.id !== index ||
			!["word", "pause"].includes(unit.kind) ||
			typeof unit.text !== "string" ||
			!unit.text.trim() ||
			unit.text.length > 2000 ||
			(index > 0 && unit.startMs < value.units[index - 1].startMs) ||
			value.existingTrims.some((trim) => overlaps(unit, trim))
		)
			throw new Error("Invalid transcript timing or word references.");
	}
}

export function resolveAiCutPlan(raw: unknown, request: AiCutRequest): AiCutSuggestion[] {
	validateAiCutRequest(request);
	const plan = raw as { cuts?: Array<{ firstUnitId: number; lastUnitId: number; reason: string }> };
	if (!plan || !Array.isArray(plan.cuts))
		throw new Error("The model returned an invalid cut plan.");
	const suggestions = plan.cuts
		.map((cut, index) => {
			if (
				!cut ||
				!Number.isInteger(cut.firstUnitId) ||
				!Number.isInteger(cut.lastUnitId) ||
				cut.firstUnitId < 0 ||
				cut.lastUnitId < cut.firstUnitId ||
				cut.lastUnitId >= request.units.length ||
				typeof cut.reason !== "string" ||
				!cut.reason.trim() ||
				cut.reason.length > 1000
			) {
				throw new Error(
					"The model referenced unknown words or returned an invalid reason. No cuts were applied.",
				);
			}
			const first = request.units[cut.firstUnitId];
			const last = request.units[cut.lastUnitId];
			// Leave a little room around surviving phonemes without crossing adjacent speech.
			const previous = request.units[cut.firstUnitId - 1];
			const next = request.units[cut.lastUnitId + 1];
			const startMs = Math.max(
				first.startMs,
				previous ? previous.endMs + (previous.kind === "word" ? 30 : 0) : 0,
			);
			const endMs = Math.min(
				last.endMs,
				next ? next.startMs - (next.kind === "word" ? 30 : 0) : request.durationMs,
			);
			if (
				endMs - startMs < 100 ||
				request.existingTrims.some((trim) => overlaps({ startMs, endMs }, trim))
			) {
				throw new Error(
					"A proposed cut crosses an existing cut or has invalid boundaries. No cuts were applied.",
				);
			}
			return {
				id: `${request.requestId}-${index}`,
				startMs,
				endMs,
				reason: cut.reason.trim(),
				text: request.units
					.slice(cut.firstUnitId, cut.lastUnitId + 1)
					.map((unit) => unit.text)
					.join(" "),
			};
		})
		.sort((a, b) => a.startMs - b.startMs);
	for (let i = 1; i < suggestions.length; i++) {
		if (overlaps(suggestions[i - 1], suggestions[i]))
			throw new Error("The model returned overlapping cuts. No cuts were applied.");
	}
	const remainingWords = request.units.filter(
		(unit) => unit.kind === "word" && !suggestions.some((cut) => overlaps(cut, unit)),
	);
	if (request.units.some((unit) => unit.kind === "word") && !remainingWords.length)
		throw new Error("The plan would remove all spoken content. No cuts were applied.");
	return suggestions;
}

/** Ordinary source-time trims keep preview, sidecar webcam, captions and native export aligned. */
export function aiCutSuggestionsToTrims(
	suggestions: AiCutSuggestion[],
	existing: TrimRegion[],
): TrimRegion[] {
	return subtractExistingTrimSpans(suggestions, existing).map((span, index) => ({
		...span,
		id: `trim-ai-${crypto.randomUUID()}-${index}`,
	}));
}
