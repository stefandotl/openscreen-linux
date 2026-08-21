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
