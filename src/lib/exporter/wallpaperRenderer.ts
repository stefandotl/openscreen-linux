import { BackgroundLoadError, classifyWallpaper, resolveImageWallpaperUrl } from "@/lib/wallpaper";
import {
	getLinearGradientPoints,
	getRadialGradientShape,
	parseCssGradient,
	resolveLinearGradientAngle,
} from "./gradientParser";

export async function renderWallpaperCanvas(
	wallpaper: string,
	width: number,
	height: number,
): Promise<HTMLCanvasElement> {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("Failed to get 2D context for wallpaper canvas");
	}

	const classified = classifyWallpaper(wallpaper);
	if (classified.kind === "color") {
		context.fillStyle = classified.value;
		context.fillRect(0, 0, width, height);
		return canvas;
	}

	if (classified.kind === "gradient") {
		const parsedGradient = parseCssGradient(classified.value);
		if (!parsedGradient) {
			throw new BackgroundLoadError(classified.value);
		}
		const gradient =
			parsedGradient.type === "linear"
				? (() => {
						const points = getLinearGradientPoints(
							resolveLinearGradientAngle(parsedGradient.descriptor),
							width,
							height,
						);
						return context.createLinearGradient(points.x0, points.y0, points.x1, points.y1);
					})()
				: (() => {
						const shape = getRadialGradientShape(parsedGradient.descriptor, width, height);
						return context.createRadialGradient(
							shape.cx,
							shape.cy,
							0,
							shape.cx,
							shape.cy,
							shape.radius,
						);
					})();

		for (const stop of parsedGradient.stops) {
			gradient.addColorStop(stop.offset, stop.color);
		}
		context.fillStyle = gradient;
		context.fillRect(0, 0, width, height);
		return canvas;
	}

	const imageUrl = resolveImageWallpaperUrl(classified.path);
	const image = new Image();
	if (imageUrl.startsWith("http") && !imageUrl.startsWith(window.location.origin)) {
		image.crossOrigin = "anonymous";
	}

	try {
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = (error) => reject(error);
			image.src = imageUrl;
		});
	} catch (error) {
		throw new BackgroundLoadError(imageUrl, error);
	}

	const imageAspect = image.width / image.height;
	const canvasAspect = width / height;
	let drawWidth: number;
	let drawHeight: number;
	let drawX: number;
	let drawY: number;
	if (imageAspect > canvasAspect) {
		drawHeight = height;
		drawWidth = drawHeight * imageAspect;
		drawX = (width - drawWidth) / 2;
		drawY = 0;
	} else {
		drawWidth = width;
		drawHeight = drawWidth / imageAspect;
		drawX = 0;
		drawY = (height - drawHeight) / 2;
	}
	context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
	return canvas;
}
