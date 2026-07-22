export interface SilenceDetectionSettings {
	noiseThresholdDb: number;
	minimumSilenceMs: number;
	paddingMs: number;
}

export interface SilenceInterval {
	startMs: number;
	endMs: number;
}

export type SilenceDetectionResult =
	| {
			success: true;
			regions: SilenceInterval[];
			removableDurationMs: number;
	  }
	| {
			success: false;
			message: string;
			error?: string;
	  };

export const DEFAULT_SILENCE_DETECTION_SETTINGS: SilenceDetectionSettings = {
	noiseThresholdDb: -38,
	minimumSilenceMs: 600,
	paddingMs: 150,
};

const MIN_TRIM_DURATION_MS = 100;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function normalizeSilenceDetectionSettings(
	value: Partial<SilenceDetectionSettings> | null | undefined,
): SilenceDetectionSettings {
	const noiseThresholdDb = Number(value?.noiseThresholdDb);
	const minimumSilenceMs = Number(value?.minimumSilenceMs);
	const paddingMs = Number(value?.paddingMs);

	return {
		noiseThresholdDb: Number.isFinite(noiseThresholdDb)
			? clamp(noiseThresholdDb, -60, -20)
			: DEFAULT_SILENCE_DETECTION_SETTINGS.noiseThresholdDb,
		minimumSilenceMs: Number.isFinite(minimumSilenceMs)
			? Math.round(clamp(minimumSilenceMs, 200, 10_000))
			: DEFAULT_SILENCE_DETECTION_SETTINGS.minimumSilenceMs,
		paddingMs: Number.isFinite(paddingMs)
			? Math.round(clamp(paddingMs, 0, 2_000))
			: DEFAULT_SILENCE_DETECTION_SETTINGS.paddingMs,
	};
}

/** Parse FFmpeg silencedetect events in their emitted order. */
export function parseSilenceDetectionOutput(
	output: string,
	sourceDurationMs?: number,
): SilenceInterval[] {
	const eventPattern = /silence_(start|end):\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/g;
	const intervals: SilenceInterval[] = [];
	let activeStartMs: number | null = null;

	for (const match of output.matchAll(eventPattern)) {
		const valueMs = Math.max(0, Number(match[2]) * 1000);
		if (!Number.isFinite(valueMs)) continue;

		if (match[1] === "start") {
			activeStartMs = valueMs;
			continue;
		}

		if (activeStartMs !== null && valueMs > activeStartMs) {
			intervals.push({ startMs: activeStartMs, endMs: valueMs });
		}
		activeStartMs = null;
	}

	if (
		activeStartMs !== null &&
		Number.isFinite(sourceDurationMs) &&
		(sourceDurationMs ?? 0) > activeStartMs
	) {
		intervals.push({ startMs: activeStartMs, endMs: sourceDurationMs as number });
	}

	return intervals;
}

export function buildSilenceTrimSpans(
	intervals: SilenceInterval[],
	settings: SilenceDetectionSettings,
	sourceDurationMs?: number,
): SilenceInterval[] {
	const normalized = normalizeSilenceDetectionSettings(settings);
	const durationLimit =
		Number.isFinite(sourceDurationMs) && (sourceDurationMs ?? 0) > 0
			? (sourceDurationMs as number)
			: Number.POSITIVE_INFINITY;

	return intervals
		.filter((interval) => interval.endMs - interval.startMs >= normalized.minimumSilenceMs)
		.map((interval) => ({
			startMs: clamp(interval.startMs + normalized.paddingMs, 0, durationLimit),
			endMs: clamp(interval.endMs - normalized.paddingMs, 0, durationLimit),
		}))
		.filter((interval) => interval.endMs - interval.startMs >= MIN_TRIM_DURATION_MS)
		.map((interval) => ({
			startMs: Math.round(interval.startMs),
			endMs: Math.round(interval.endMs),
		}));
}

/** Keep generated trims non-overlapping with trims the user already has. */
export function subtractExistingTrimSpans(
	candidates: SilenceInterval[],
	existing: SilenceInterval[],
): SilenceInterval[] {
	const sortedExisting = existing
		.filter((span) => span.endMs > span.startMs)
		.slice()
		.sort((a, b) => a.startMs - b.startMs);
	const result: SilenceInterval[] = [];

	for (const candidate of candidates) {
		let fragments = [candidate];
		for (const occupied of sortedExisting) {
			const next: SilenceInterval[] = [];
			for (const fragment of fragments) {
				if (occupied.endMs <= fragment.startMs || occupied.startMs >= fragment.endMs) {
					next.push(fragment);
					continue;
				}
				if (occupied.startMs - fragment.startMs >= MIN_TRIM_DURATION_MS) {
					next.push({ startMs: fragment.startMs, endMs: occupied.startMs });
				}
				if (fragment.endMs - occupied.endMs >= MIN_TRIM_DURATION_MS) {
					next.push({ startMs: occupied.endMs, endMs: fragment.endMs });
				}
			}
			fragments = next;
			if (fragments.length === 0) break;
		}
		result.push(...fragments);
	}

	return result;
}
