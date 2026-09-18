export const PARAKEET_SAMPLE_RATE = 16_000;
export const PARAKEET_CHUNK_DURATION_SEC = 60;
export const PARAKEET_CHUNK_CONTEXT_SEC = 2;

export interface ParakeetChunkWindow {
	readStartSample: number;
	readEndSample: number;
	keepStartSample: number;
	keepEndSample: number;
	isLast: boolean;
}

/**
 * Builds overlapping inference windows while assigning each timestamp to exactly one core window.
 * The overlap gives Parakeet enough speech context to recognize words at chunk boundaries.
 */
export function createParakeetChunkWindows(
	totalSamples: number,
	sampleRate = PARAKEET_SAMPLE_RATE,
	chunkDurationSec = PARAKEET_CHUNK_DURATION_SEC,
	contextSec = PARAKEET_CHUNK_CONTEXT_SEC,
): ParakeetChunkWindow[] {
	if (!Number.isInteger(totalSamples) || totalSamples < 0) {
		throw new Error("Parakeet PCM sample count must be a non-negative integer");
	}
	if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
		throw new Error("Parakeet sample rate must be a positive integer");
	}
	if (!Number.isFinite(chunkDurationSec) || chunkDurationSec <= 0) {
		throw new Error("Parakeet chunk duration must be positive");
	}
	if (!Number.isFinite(contextSec) || contextSec < 0) {
		throw new Error("Parakeet chunk context must not be negative");
	}

	const chunkSamples = Math.max(1, Math.round(chunkDurationSec * sampleRate));
	const contextSamples = Math.max(0, Math.round(contextSec * sampleRate));
	const windows: ParakeetChunkWindow[] = [];

	for (let keepStartSample = 0; keepStartSample < totalSamples; keepStartSample += chunkSamples) {
		const keepEndSample = Math.min(totalSamples, keepStartSample + chunkSamples);
		windows.push({
			readStartSample: Math.max(0, keepStartSample - contextSamples),
			readEndSample: Math.min(totalSamples, keepEndSample + contextSamples),
			keepStartSample,
			keepEndSample,
			isLast: keepEndSample === totalSamples,
		});
	}

	return windows;
}
