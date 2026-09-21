export const WEBCAM_VIDEO_OFFSET_MIN_MS = -1_000;
export const WEBCAM_VIDEO_OFFSET_MAX_MS = 1_000;
export const WEBCAM_VIDEO_OFFSET_DEFAULT_MS = 0;
export const DROIDCAM_WEBCAM_VIDEO_OFFSET_MS = 200;

/**
 * Positive values advance the webcam image by sampling it at timeline time + offset.
 */
export function normalizeWebcamVideoOffsetMs(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return WEBCAM_VIDEO_OFFSET_DEFAULT_MS;
	}

	return Math.min(WEBCAM_VIDEO_OFFSET_MAX_MS, Math.max(WEBCAM_VIDEO_OFFSET_MIN_MS, value));
}

/**
 * A sidecar whose own length disagrees with the screen recording cannot be aligned by the
 * constant offset alone: the two capture clocks produced different amounts of timeline for the
 * same wall-clock recording. 250 ms / 0.3 % is well below what a viewer notices as lip-sync
 * error, so anything above it is a real skew rather than container rounding.
 */
export const WEBCAM_SYNC_DURATION_TOLERANCE_MS = 250;
export const WEBCAM_SYNC_DURATION_TOLERANCE_RATIO = 0.003;

export interface WebcamSyncDurationReport {
	screenDurationMs: number;
	webcamDurationMs: number;
	/** Positive when the webcam sidecar is longer than the screen recording. */
	deltaMs: number;
	/** Sample the webcam at `screenTimeMs * webcamTimeScale` to follow the screen timeline. */
	webcamTimeScale: number;
	skewed: boolean;
}

/**
 * Compares the two recordings of one scene. The webcam sidecar is driven by the renderer
 * (canvas capture + interval watchdog) while the screen recording is captured natively, so a
 * stalled camera or a camera format change can leave the sidecar with a different amount of
 * timeline. Reporting this is the only way to distinguish a constant offset from a real skew
 * before blaming trim handling.
 */
export function inspectWebcamSyncDurations(
	screenDurationSeconds: unknown,
	webcamDurationSeconds: unknown,
): WebcamSyncDurationReport | null {
	if (
		typeof screenDurationSeconds !== "number" ||
		!Number.isFinite(screenDurationSeconds) ||
		screenDurationSeconds <= 0 ||
		typeof webcamDurationSeconds !== "number" ||
		!Number.isFinite(webcamDurationSeconds) ||
		webcamDurationSeconds <= 0
	) {
		return null;
	}

	const screenDurationMs = screenDurationSeconds * 1000;
	const webcamDurationMs = webcamDurationSeconds * 1000;
	const deltaMs = webcamDurationMs - screenDurationMs;
	const toleranceMs = Math.max(
		WEBCAM_SYNC_DURATION_TOLERANCE_MS,
		screenDurationMs * WEBCAM_SYNC_DURATION_TOLERANCE_RATIO,
	);

	return {
		screenDurationMs,
		webcamDurationMs,
		deltaMs,
		webcamTimeScale: webcamDurationMs / screenDurationMs,
		skewed: Math.abs(deltaMs) > toleranceMs,
	};
}

export function getRecommendedWebcamVideoOffsetMs(deviceName: unknown): number {
	if (typeof deviceName !== "string") {
		return WEBCAM_VIDEO_OFFSET_DEFAULT_MS;
	}

	const normalizedName = deviceName.trim();
	if (/droidcam/i.test(normalizedName) || normalizedName === "Virtual Camera") {
		return DROIDCAM_WEBCAM_VIDEO_OFFSET_MS;
	}

	return WEBCAM_VIDEO_OFFSET_DEFAULT_MS;
}
