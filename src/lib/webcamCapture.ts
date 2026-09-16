export const WEBCAM_TARGET_FRAME_RATE = 30;
export const WEBCAM_IDEAL_WIDTH = 1920;
export const WEBCAM_IDEAL_HEIGHT = 1080;
export const VIRTUAL_CAMERA_MIN_SHORT_EDGE = 720;
export const VIRTUAL_CAMERA_MIN_LONG_EDGE = 1280;

const VIRTUAL_CAMERA_LABEL_PATTERN =
	/(camera\s*lab|virtual|obs|droidcam|iriun|epoccam|camo|ndi|v4l2loopback)/i;

export function createWebcamVideoConstraints(deviceId: string): MediaTrackConstraints {
	return {
		deviceId: { exact: deviceId },
		width: { ideal: WEBCAM_IDEAL_WIDTH },
		height: { ideal: WEBCAM_IDEAL_HEIGHT },
		frameRate: { ideal: WEBCAM_TARGET_FRAME_RATE, max: WEBCAM_TARGET_FRAME_RATE },
	};
}

export function isLowResolutionVirtualCamera(
	deviceName: string | undefined,
	dimensions: { width: number; height: number },
) {
	if (!deviceName || !VIRTUAL_CAMERA_LABEL_PATTERN.test(deviceName)) {
		return false;
	}
	const shortEdge = Math.min(dimensions.width, dimensions.height);
	const longEdge = Math.max(dimensions.width, dimensions.height);
	return shortEdge < VIRTUAL_CAMERA_MIN_SHORT_EDGE || longEdge < VIRTUAL_CAMERA_MIN_LONG_EDGE;
}
