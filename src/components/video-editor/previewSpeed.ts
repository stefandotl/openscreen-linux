import {
	clampPlaybackSpeed,
	DEFAULT_PREVIEW_SPEED,
	type PlaybackSpeed,
	PREVIEW_SPEED_OPTIONS,
} from "./types";

const SPEED_EPSILON = 0.0001;

/**
 * Steps the preview speed ladder. A value that is not exactly on the ladder still steps to the
 * next defined speed, so a restored or externally set speed can never strand the user on it.
 */
export function stepPreviewSpeed(current: number, direction: "faster" | "slower"): PlaybackSpeed {
	if (direction === "faster") {
		const next = PREVIEW_SPEED_OPTIONS.find((option) => option > current + SPEED_EPSILON);
		return next ?? PREVIEW_SPEED_OPTIONS[PREVIEW_SPEED_OPTIONS.length - 1];
	}

	for (let index = PREVIEW_SPEED_OPTIONS.length - 1; index >= 0; index -= 1) {
		if (PREVIEW_SPEED_OPTIONS[index] < current - SPEED_EPSILON) {
			return PREVIEW_SPEED_OPTIONS[index];
		}
	}
	return PREVIEW_SPEED_OPTIONS[0];
}

/**
 * The rate applied to the preview media element. A timeline speed region still governs its own
 * span, and the preview multiplier scales that result. Clamped to the rate range the decoder can
 * follow so a slow region at a high preview multiplier cannot stall the playhead.
 */
export function resolvePreviewPlaybackRate(
	speedRegionSpeed: number | null | undefined,
	previewSpeed: number,
): PlaybackSpeed {
	const baseRate =
		typeof speedRegionSpeed === "number" &&
		Number.isFinite(speedRegionSpeed) &&
		speedRegionSpeed > 0
			? speedRegionSpeed
			: 1;
	const multiplier =
		Number.isFinite(previewSpeed) && previewSpeed > 0 ? previewSpeed : DEFAULT_PREVIEW_SPEED;
	return clampPlaybackSpeed(baseRate * multiplier);
}

export function formatPreviewSpeedLabel(speed: number): string {
	return `${speed}×`;
}
