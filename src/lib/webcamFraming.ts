import {
	DEFAULT_WEBCAM_FRAMING,
	type WebcamFraming,
	type WebcamRotation,
} from "@/components/video-editor/types";

export const MAX_WEBCAM_ZOOM = 4;

export function isValidWebcamFraming(value: WebcamFraming): boolean {
	return (
		Number.isFinite(value.zoom) &&
		value.zoom >= 1 &&
		value.zoom <= MAX_WEBCAM_ZOOM &&
		Number.isFinite(value.x) &&
		value.x >= 0 &&
		value.x <= 1 &&
		Number.isFinite(value.y) &&
		value.y >= 0 &&
		value.y <= 1
	);
}

export function normalizeWebcamFraming(value: unknown): WebcamFraming {
	const raw = value && typeof value === "object" ? (value as Partial<WebcamFraming>) : {};
	const bounded = (value: unknown, fallback: number, min: number, max: number) =>
		typeof value === "number" && Number.isFinite(value)
			? Math.max(min, Math.min(max, value))
			: fallback;
	return {
		zoom: bounded(raw.zoom, DEFAULT_WEBCAM_FRAMING.zoom, 1, MAX_WEBCAM_ZOOM),
		x: bounded(raw.x, DEFAULT_WEBCAM_FRAMING.x, 0, 1),
		y: bounded(raw.y, DEFAULT_WEBCAM_FRAMING.y, 0, 1),
	};
}

/** Source pixels shared by preview, Canvas export and the native GPU plan.
 * Position is expressed in the displayed orientation, including rotation/mirroring.
 */
export function getWebcamSourceCrop(
	source: { width: number; height: number },
	destination: { width: number; height: number },
	framing: WebcamFraming = DEFAULT_WEBCAM_FRAMING,
	rotation: WebcamRotation = 0,
	mirrored = false,
) {
	if (
		!isValidWebcamFraming(framing) ||
		![source.width, source.height, destination.width, destination.height].every(
			(v) => Number.isFinite(v) && v > 0,
		)
	) {
		throw new Error("Webcam framing or dimensions are invalid");
	}
	const swapsAxes = rotation === 90 || rotation === 270;
	const aspect = swapsAxes
		? destination.height / destination.width
		: destination.width / destination.height;
	const width = Math.min(source.width, source.height * aspect) / framing.zoom;
	const height = width / aspect;
	let { x, y } = framing;
	if (rotation === 90) [x, y] = [y, 1 - x];
	else if (rotation === 180) [x, y] = [1 - x, 1 - y];
	else if (rotation === 270) [x, y] = [1 - y, x];
	if (mirrored) x = 1 - x;
	return { x: (source.width - width) * x, y: (source.height - height) * y, width, height };
}

export function getWebcamVideoStyle(
	source: { width: number; height: number },
	destination: { width: number; height: number },
	framing: WebcamFraming = DEFAULT_WEBCAM_FRAMING,
	rotation: WebcamRotation = 0,
	mirrored = false,
) {
	const crop = getWebcamSourceCrop(source, destination, framing, rotation, mirrored);
	const unrotatedWidth =
		rotation === 90 || rotation === 270 ? destination.height : destination.width;
	const scale = unrotatedWidth / crop.width;
	const offsetX = (source.width / 2 - crop.x - crop.width / 2) * scale;
	const offsetY = (source.height / 2 - crop.y - crop.height / 2) * scale;
	return {
		left: "50%",
		top: "50%",
		width: source.width * scale,
		height: source.height * scale,
		maxWidth: "none",
		transform: `translate(-50%, -50%) rotate(${rotation}deg) scaleX(${mirrored ? -1 : 1}) translate(${offsetX}px, ${offsetY}px)`,
	};
}
