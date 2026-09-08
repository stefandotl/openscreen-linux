const MAX_PREVIEW_BACKING_PIXELS = 1920 * 1080;

/**
 * Keeps the interactive preview sharp without letting a fullscreen/high-DPI window
 * allocate and redraw a canvas larger than 1080p. Export rendering is separate and
 * continues to use the requested output resolution.
 */
export function getPreviewRendererResolution(
	width: number,
	height: number,
	devicePixelRatio: number,
	isScrubbing = false,
) {
	const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
	const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
	const safeDevicePixelRatio =
		Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
	const pixelBudgetResolution = Math.sqrt(MAX_PREVIEW_BACKING_PIXELS / (safeWidth * safeHeight));
	const idleResolution = Math.min(safeDevicePixelRatio, pixelBudgetResolution);

	return Math.max(0.5, Math.min(isScrubbing ? 1 : idleResolution, 2));
}

export function shouldRenderScreenPreview(webcamLayoutPreset: string) {
	return webcamLayoutPreset !== "only-webcam";
}
