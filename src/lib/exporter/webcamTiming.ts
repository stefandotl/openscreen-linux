function getFiniteWebcamVideoOffsetMs(webcamVideoOffsetMs: number | undefined): number {
	const offsetMs = webcamVideoOffsetMs ?? 0;
	if (!Number.isFinite(offsetMs)) {
		throw new Error("Webcam video offset must be a finite number");
	}
	return offsetMs;
}

export function getWebcamSourceTimestampMs(
	screenSourceTimestampMs: number,
	webcamVideoOffsetMs: number | undefined,
	webcamDurationSeconds: number,
): number {
	const offsetMs = getFiniteWebcamVideoOffsetMs(webcamVideoOffsetMs);
	if (!Number.isFinite(screenSourceTimestampMs) || screenSourceTimestampMs < 0) {
		throw new Error("Screen source timestamp must be a finite, non-negative number");
	}
	if (!Number.isFinite(webcamDurationSeconds) || webcamDurationSeconds <= 0) {
		throw new Error("Webcam duration must be a finite, positive number");
	}

	return Math.min(webcamDurationSeconds * 1000, Math.max(0, screenSourceTimestampMs + offsetMs));
}

export function offsetWebcamTimelineRegions<T extends { startMs: number; endMs: number }>(
	regions: T[] | undefined,
	webcamVideoOffsetMs: number | undefined,
): T[] | undefined {
	const offsetMs = getFiniteWebcamVideoOffsetMs(webcamVideoOffsetMs);
	if (!regions || offsetMs === 0) return regions;

	return regions.map((region) => ({
		...region,
		startMs: region.startMs + offsetMs,
		endMs: region.endMs + offsetMs,
	}));
}
