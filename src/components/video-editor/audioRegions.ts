export interface AudioRegion {
	id: string;
	sourcePath: string;
	name: string;
	/** All timeline times use the scene's source clock, including after a scene split. */
	startMs: number;
	endMs: number;
	sourceStartMs: number;
	sourceDurationMs: number;
	volume: number;
	fadeInMs: number;
	fadeOutMs: number;
}

export function validateAudioRegions(value: unknown): AudioRegion[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("Invalid audio clips in project");
	const ids = new Set<string>();
	return value.map((clip: AudioRegion) => {
		if (
			!clip ||
			typeof clip.id !== "string" ||
			ids.has(clip.id) ||
			typeof clip.sourcePath !== "string" ||
			!clip.sourcePath ||
			typeof clip.name !== "string" ||
			![
				clip.startMs,
				clip.endMs,
				clip.sourceStartMs,
				clip.sourceDurationMs,
				clip.volume,
				clip.fadeInMs,
				clip.fadeOutMs,
			].every(Number.isFinite) ||
			clip.startMs < 0 ||
			clip.endMs <= clip.startMs ||
			clip.sourceStartMs < 0 ||
			clip.sourceStartMs + clip.endMs - clip.startMs > clip.sourceDurationMs + 1 ||
			clip.volume < 0 ||
			clip.volume > 1 ||
			clip.fadeInMs < 0 ||
			clip.fadeOutMs < 0
		) {
			throw new Error("Invalid audio clip timing, source or volume");
		}
		ids.add(clip.id);
		return { ...clip };
	});
}

export function audioGainAt(clip: AudioRegion, timeMs: number): number {
	if (timeMs < clip.startMs || timeMs >= clip.endMs) return 0;
	const duration = clip.endMs - clip.startMs;
	return (
		clip.volume *
		Math.min(
			1,
			clip.fadeInMs > 0 ? (timeMs - clip.startMs) / Math.min(duration, clip.fadeInMs) : 1,
		) *
		Math.min(1, clip.fadeOutMs > 0 ? (clip.endMs - timeMs) / Math.min(duration, clip.fadeOutMs) : 1)
	);
}

export function resizeAudioRegion(
	clip: AudioRegion,
	span: { start: number; end: number },
): AudioRegion {
	const oldDuration = clip.endMs - clip.startMs;
	const moving = Math.abs(span.end - span.start - oldDuration) < 1;
	const sourceStartMs = moving
		? clip.sourceStartMs
		: Math.max(0, clip.sourceStartMs + span.start - clip.startMs);
	const startMs = moving ? span.start : clip.startMs + sourceStartMs - clip.sourceStartMs;
	return {
		...clip,
		startMs,
		sourceStartMs,
		endMs: Math.min(span.end, startMs + clip.sourceDurationMs - sourceStartMs),
	};
}
