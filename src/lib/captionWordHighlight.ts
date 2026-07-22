import type { AnnotationCaptionWord, AnnotationRegion } from "@/components/video-editor/types";

export interface CaptionContentToken {
	text: string;
	wordIndex: number | null;
}

export function tokenizeCaptionContent(content: string): CaptionContentToken[] {
	let wordIndex = 0;
	return content
		.split(/(\s+)/)
		.filter(Boolean)
		.map((text) => {
			if (/^\s+$/.test(text)) return { text, wordIndex: null };
			return { text, wordIndex: wordIndex++ };
		});
}

function interpolateWords(texts: string[], durationMs: number): AnnotationCaptionWord[] {
	const weights = texts.map((text) => Math.max(1, Array.from(text).length));
	const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
	let elapsedWeight = 0;
	return texts.map((text, index) => {
		const startOffsetMs = (elapsedWeight / totalWeight) * durationMs;
		elapsedWeight += weights[index] ?? 0;
		return {
			text,
			startOffsetMs,
			endOffsetMs: (elapsedWeight / totalWeight) * durationMs,
		};
	});
}

/**
 * Uses stored model timing while reflecting text edits. If an edit changes the word count,
 * timing is redistributed deterministically over the annotation as the explicit fallback.
 */
export function getCaptionDisplayWords(
	annotation: Pick<AnnotationRegion, "captionWords" | "content" | "startMs" | "endMs">,
): AnnotationCaptionWord[] {
	const texts = tokenizeCaptionContent(annotation.content)
		.filter((token) => token.wordIndex !== null)
		.map((token) => token.text);
	if (texts.length === 0) return [];

	const durationMs = Math.max(1, annotation.endMs - annotation.startMs);
	const stored = annotation.captionWords;
	if (!stored || stored.length !== texts.length) {
		return interpolateWords(texts, durationMs);
	}

	return stored.map((word, index) => ({
		text: texts[index]!,
		startOffsetMs: Math.max(0, Math.min(durationMs, word.startOffsetMs)),
		endOffsetMs: Math.max(0, Math.min(durationMs, word.endOffsetMs)),
	}));
}

export function getActiveCaptionWordIndex(
	annotation: Pick<AnnotationRegion, "captionWords" | "content" | "startMs" | "endMs" | "style">,
	currentTimeMs: number,
): number | null {
	if (!annotation.style.wordHighlight) return null;
	const elapsedMs = currentTimeMs - annotation.startMs;
	const words = getCaptionDisplayWords(annotation);
	const index = words.findIndex(
		(word) => elapsedMs >= word.startOffsetMs && elapsedMs < word.endOffsetMs,
	);
	return index >= 0 ? index : null;
}
