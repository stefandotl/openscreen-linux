import {
	DEFAULT_ROTATION_3D,
	getRotation3D,
	getZoomScale,
	isRotation3DIdentity,
	lerpRotation3D,
	type Rotation3D,
	type ZoomFocus,
} from "@/components/video-editor/types";
import {
	AUTO_FOLLOW_PARAMS,
	DEFAULT_FOCUS,
} from "@/components/video-editor/videoPlayback/constants";
import { advanceFollowFocus } from "@/components/video-editor/videoPlayback/cursorFollowUtils";
import { clampFocusToScale } from "@/components/video-editor/videoPlayback/focusUtils";
import { findDominantRegion } from "@/components/video-editor/videoPlayback/zoomRegionUtils";
import {
	createZoomSpringState,
	resetZoomSpring,
	stepZoomSpring,
} from "@/components/video-editor/videoPlayback/zoomSpring";
import {
	computeFocusFromTransform,
	computeZoomTransform,
} from "@/components/video-editor/videoPlayback/zoomTransform";
import { computeCompositeLayout } from "@/lib/compositeLayout";
import { renderAnnotations } from "./annotationRenderer";
import { getContinuousExportSourceTimestampsMs } from "./exportTimeline";
import {
	NATIVE_GPU_EXPORT_PROTOCOL_VERSION,
	type NativeGpuExportFrame,
	type NativeGpuExportPlan,
} from "./nativeGpuExportProtocol";
import type { VideoExporterConfig } from "./videoExporter";
import { renderWallpaperCanvas } from "./wallpaperRenderer";

export const NATIVE_GPU_EXPORT_FRAME_RATE = 30;
export const NATIVE_GPU_EXPORT_MAX_DIMENSION = 4096;

const EPSILON = 0.0001;
const MOTION_BLUR_PEAK_VELOCITY_PPS = 1400;
const MOTION_BLUR_MAX_PX = 14;
const MOTION_BLUR_VELOCITY_THRESHOLD_PPS = 12;
const MOTION_BLUR_MAX_AMOUNT_BOOST = 2.2;

export interface NativeGpuExportVideoInfo {
	width: number;
	height: number;
	duration: number;
}

function isDefaultCrop(config: VideoExporterConfig) {
	const crop = config.cropRegion;
	return (
		Math.abs(crop.x) <= EPSILON &&
		Math.abs(crop.y) <= EPSILON &&
		Math.abs(crop.width - 1) <= EPSILON &&
		Math.abs(crop.height - 1) <= EPSILON
	);
}

function activeAnnotations(config: VideoExporterConfig) {
	return (config.annotationRegions ?? []).filter(
		(annotation) => annotation.endMs - annotation.startMs > EPSILON,
	);
}

function sortedActiveAnnotations(config: VideoExporterConfig) {
	return activeAnnotations(config).sort((a, b) => a.zIndex - b.zIndex);
}

function annotationPixelBounds(
	annotation: ReturnType<typeof activeAnnotations>[number],
	config: VideoExporterConfig,
) {
	const left = Math.max(0, Math.floor((annotation.position.x / 100) * config.width));
	const top = Math.max(0, Math.floor((annotation.position.y / 100) * config.height));
	const right = Math.min(
		config.width,
		Math.ceil(((annotation.position.x + annotation.size.width) / 100) * config.width),
	);
	const bottom = Math.min(
		config.height,
		Math.ceil(((annotation.position.y + annotation.size.height) / 100) * config.height),
	);
	return {
		x: left,
		y: top,
		width: Math.max(0, right - left),
		height: Math.max(0, bottom - top),
	};
}

export function getNativeGpuExportBlockers(
	config: VideoExporterConfig,
	videoInfo: NativeGpuExportVideoInfo,
): string[] {
	const blockers: string[] = [];
	if (
		!Number.isInteger(config.width) ||
		!Number.isInteger(config.height) ||
		config.width < 2 ||
		config.height < 2 ||
		config.width % 2 !== 0 ||
		config.height % 2 !== 0 ||
		config.width > NATIVE_GPU_EXPORT_MAX_DIMENSION ||
		config.height > NATIVE_GPU_EXPORT_MAX_DIMENSION
	) {
		blockers.push(
			`output dimensions must be positive, even, and at most ${NATIVE_GPU_EXPORT_MAX_DIMENSION}px per side; got ${config.width}x${config.height}`,
		);
	}
	if (config.frameRate !== NATIVE_GPU_EXPORT_FRAME_RATE) {
		blockers.push(`output must be ${NATIVE_GPU_EXPORT_FRAME_RATE} fps, got ${config.frameRate}`);
	}
	if (!Number.isFinite(config.bitrate) || config.bitrate <= 0) {
		blockers.push("bitrate is invalid");
	}
	if (
		!Number.isInteger(videoInfo.width) ||
		!Number.isInteger(videoInfo.height) ||
		videoInfo.width <= 0 ||
		videoInfo.height <= 0 ||
		videoInfo.width % 2 !== 0 ||
		videoInfo.height % 2 !== 0
	) {
		blockers.push(
			`source dimensions must be positive and even, got ${videoInfo.width}x${videoInfo.height}`,
		);
	}
	if (!Number.isFinite(videoInfo.duration) || videoInfo.duration <= 0) {
		blockers.push("source duration is invalid");
	}
	if (config.webcamVideoUrl) blockers.push("webcam composition is not implemented");
	if (!isDefaultCrop(config)) blockers.push("cropping is not implemented");
	if (config.showShadow || config.shadowIntensity > EPSILON) {
		blockers.push("recording shadow is not implemented");
	}
	if ((config.borderRadius ?? 0) > EPSILON) blockers.push("recording roundness is not implemented");
	if (
		(config.cursorScale ?? 0) > 0 &&
		Boolean(config.cursorRecordingData?.samples.some((sample) => sample.visible !== false))
	) {
		blockers.push("editable cursor composition is not implemented");
	}
	if (
		config.webcamLayoutPreset &&
		config.webcamLayoutPreset !== "picture-in-picture" &&
		config.webcamLayoutPreset !== "no-webcam"
	) {
		blockers.push(`layout ${config.webcamLayoutPreset} is not implemented without a webcam`);
	}
	if (config.zoomRegions.some((region) => region.focusMode === "auto")) {
		blockers.push("automatic cursor-follow zoom is not implemented");
	}
	if (config.zoomRegions.some((region) => !isRotation3DIdentity(getRotation3D(region)))) {
		blockers.push("3D zoom rotation is not implemented");
	}

	const annotations = activeAnnotations(config);
	for (const annotation of annotations) {
		if (annotation.type !== "text")
			blockers.push(`annotation type ${annotation.type} is not implemented`);
		if (annotation.style.textAnimation && annotation.style.textAnimation !== "none") {
			blockers.push(`text animation ${annotation.style.textAnimation} is not implemented`);
		}
		const bounds = annotationPixelBounds(annotation, config);
		if (bounds.width < 1 || bounds.height < 1) {
			blockers.push(`annotation ${annotation.id} has no visible export area`);
		}
	}
	return blockers;
}

function createFrameTransforms(
	config: VideoExporterConfig,
	screenRect: { x: number; y: number; width: number; height: number },
	sourceTimestampsMs: number[],
): NativeGpuExportFrame[] {
	const spring = createZoomSpringState();
	let smoothedAutoFocus: ZoomFocus | null = null;
	let previousTimeMs: number | null = null;
	let previousApplied: { scale: number; x: number; y: number } | null = null;
	let previousTargetProgress = 0;
	let currentRotation: Rotation3D = { ...DEFAULT_ROTATION_3D };

	return sourceTimestampsMs.map((timeMs) => {
		const { region, strength, blendedScale, rotation3D, transition } = findDominantRegion(
			config.zoomRegions,
			timeMs,
			{ connectZooms: true, cursorTelemetry: config.cursorTelemetry },
		);
		let targetScale = 1;
		let targetFocus = { ...DEFAULT_FOCUS };
		let targetProgress = 0;
		currentRotation =
			region && strength > 0
				? lerpRotation3D(DEFAULT_ROTATION_3D, rotation3D, strength)
				: { ...DEFAULT_ROTATION_3D };

		if (region && strength > 0) {
			const zoomScale = blendedScale ?? getZoomScale(region);
			targetScale = zoomScale;
			targetFocus = clampFocusToScale(region.focus, zoomScale);
			targetProgress = strength;

			if (region.focusMode === "auto" && !transition) {
				const deltaMs = previousTimeMs == null ? 0 : timeMs - previousTimeMs;
				const isZoomingIn = targetProgress < 0.999 && targetProgress >= previousTargetProgress;
				if (targetProgress >= 0.999) {
					const previous = smoothedAutoFocus ?? targetFocus;
					targetFocus = advanceFollowFocus(previous, targetFocus, deltaMs, AUTO_FOLLOW_PARAMS);
					smoothedAutoFocus = targetFocus;
				} else if (isZoomingIn) {
					smoothedAutoFocus = targetFocus;
				} else {
					const previous = smoothedAutoFocus ?? targetFocus;
					targetFocus = advanceFollowFocus(previous, targetFocus, deltaMs, AUTO_FOLLOW_PARAMS);
					smoothedAutoFocus = targetFocus;
				}
			} else if (region.focusMode !== "auto") {
				smoothedAutoFocus = null;
			}
			previousTargetProgress = targetProgress;

			if (transition) {
				const start = computeZoomTransform({
					stageSize: { width: config.width, height: config.height },
					baseMask: screenRect,
					zoomScale: transition.startScale,
					zoomProgress: 1,
					focusX: transition.startFocus.cx,
					focusY: transition.startFocus.cy,
				});
				const end = computeZoomTransform({
					stageSize: { width: config.width, height: config.height },
					baseMask: screenRect,
					zoomScale: transition.endScale,
					zoomProgress: 1,
					focusX: transition.endFocus.cx,
					focusY: transition.endFocus.cy,
				});
				const interpolated = {
					scale: start.scale + (end.scale - start.scale) * transition.progress,
					x: start.x + (end.x - start.x) * transition.progress,
					y: start.y + (end.y - start.y) * transition.progress,
				};
				targetScale = interpolated.scale;
				targetFocus = computeFocusFromTransform({
					stageSize: { width: config.width, height: config.height },
					baseMask: screenRect,
					zoomScale: interpolated.scale,
					x: interpolated.x,
					y: interpolated.y,
				});
				targetProgress = 1;
			}
		}

		if (!isRotation3DIdentity(currentRotation)) {
			throw new Error("Native GPU export plan unexpectedly contains 3D rotation");
		}
		const projected = computeZoomTransform({
			stageSize: { width: config.width, height: config.height },
			baseMask: screenRect,
			zoomScale: targetScale,
			zoomProgress: targetProgress,
			focusX: targetFocus.cx,
			focusY: targetFocus.cy,
		});
		const deltaMs = previousTimeMs == null ? 0 : timeMs - previousTimeMs;
		const applied =
			previousTimeMs == null || deltaMs <= 0 || deltaMs > 80
				? (resetZoomSpring(spring, projected), projected)
				: stepZoomSpring(spring, projected, deltaMs);
		previousTimeMs = timeMs;
		let motionBlurX = 0;
		let motionBlurY = 0;
		const motionBlurAmount = Math.min(1, Math.max(0, config.motionBlurAmount ?? 0));
		if (previousApplied && deltaMs > 0 && deltaMs <= 80 && motionBlurAmount > EPSILON) {
			const dtSeconds = Math.min(80, Math.max(1, deltaMs)) / 1000;
			const dx = applied.x - previousApplied.x;
			const dy = applied.y - previousApplied.y;
			const dScale = applied.scale - previousApplied.scale;
			const velocityX = dx / dtSeconds;
			const velocityY = dy / dtSeconds;
			const scaleVelocity =
				Math.abs(dScale / dtSeconds) * Math.max(config.width, config.height) * 0.5;
			const speed = Math.hypot(velocityX, velocityY) + scaleVelocity;
			if (speed >= MOTION_BLUR_VELOCITY_THRESHOLD_PPS) {
				const normalizedSpeed = Math.min(1, speed / MOTION_BLUR_PEAK_VELOCITY_PPS);
				const amountResponse =
					motionBlurAmount * (1 + (MOTION_BLUR_MAX_AMOUNT_BOOST - 1) * motionBlurAmount);
				const targetBlur = normalizedSpeed * normalizedSpeed * MOTION_BLUR_MAX_PX * amountResponse;
				const directionMagnitude = Math.hypot(velocityX, velocityY);
				if (targetBlur > 0.5 && directionMagnitude > EPSILON) {
					const velocityScale = targetBlur * 2.4;
					motionBlurX = (velocityX / directionMagnitude) * velocityScale;
					motionBlurY = (velocityY / directionMagnitude) * velocityScale;
				}
			}
		}
		previousApplied = applied;
		return {
			sourceTimestampMs: timeMs,
			cameraScale: applied.scale,
			cameraX: applied.x,
			cameraY: applied.y,
			motionBlurX,
			motionBlurY,
		};
	});
}

function blurWallpaperCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = source.width;
	canvas.height = source.height;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Failed to create background-blur canvas for native GPU export");
	context.filter = "blur(6px)";
	context.drawImage(source, 0, 0, source.width, source.height);
	return canvas;
}

export function createNativeGpuExportPlan(
	config: VideoExporterConfig,
	videoInfo: NativeGpuExportVideoInfo,
): NativeGpuExportPlan {
	const blockers = getNativeGpuExportBlockers(config, videoInfo);
	if (blockers.length > 0) {
		throw new Error(`Native GPU export does not support this project: ${blockers.join("; ")}`);
	}
	const paddingScale = 1 - ((config.padding ?? 0) / 100) * 0.4;
	const layout = computeCompositeLayout({
		canvasSize: { width: config.width, height: config.height },
		maxContentSize: {
			width: config.width * paddingScale,
			height: config.height * paddingScale,
		},
		screenSize: { width: videoInfo.width, height: videoInfo.height },
		layoutPreset: config.webcamLayoutPreset,
	});
	if (!layout || layout.screenCover) {
		throw new Error("Native GPU export could not create a supported recording layout");
	}
	const sourceTimestampsMs = getContinuousExportSourceTimestampsMs(
		videoInfo.duration,
		config.frameRate,
		config.trimRegions,
		config.speedRegions,
	);
	if (sourceTimestampsMs.length === 0) {
		throw new Error("Native GPU export timeline contains no frames");
	}
	const overlays = sortedActiveAnnotations(config).map((annotation) => ({
		startMs: annotation.startMs,
		endMs: annotation.endMs,
		...annotationPixelBounds(annotation, config),
		zIndex: annotation.zIndex,
	}));
	return {
		version: NATIVE_GPU_EXPORT_PROTOCOL_VERSION,
		inputPath: config.videoUrl,
		width: config.width,
		height: config.height,
		frameRate: config.frameRate,
		bitrate: config.bitrate,
		sourceWidth: videoInfo.width,
		sourceHeight: videoInfo.height,
		screenRect: layout.screenRect,
		cropRegion: config.cropRegion,
		frames: createFrameTransforms(config, layout.screenRect, sourceTimestampsMs),
		overlays,
	};
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (!blob) {
				reject(new Error("Canvas PNG encoding returned no data"));
				return;
			}
			blob.arrayBuffer().then(resolve, reject);
		}, "image/png");
	});
}

export async function createNativeGpuExportAssets(config: VideoExporterConfig): Promise<{
	wallpaperPng: ArrayBuffer;
	overlayPngs: ArrayBuffer[];
}> {
	const rawWallpaperCanvas = await renderWallpaperCanvas(
		config.wallpaper,
		config.width,
		config.height,
	);
	const wallpaperCanvas = config.showBlur
		? blurWallpaperCanvas(rawWallpaperCanvas)
		: rawWallpaperCanvas;
	const wallpaperPng = await canvasToPng(wallpaperCanvas);
	const annotations = sortedActiveAnnotations(config);
	const previewWidth = config.previewWidth ?? config.width;
	const previewHeight = config.previewHeight ?? config.height;
	const scaleFactor = (config.width / previewWidth + config.height / previewHeight) / 2;
	const overlayPngs: ArrayBuffer[] = [];
	for (const annotation of annotations) {
		const bounds = annotationPixelBounds(annotation, config);
		if (bounds.width < 1 || bounds.height < 1) {
			throw new Error(`Annotation ${annotation.id} has no visible export area`);
		}
		if (document.fonts) {
			const fontStyle = annotation.style.fontStyle === "italic" ? "italic" : "normal";
			const fontWeight = annotation.style.fontWeight === "bold" ? "bold" : "normal";
			await document.fonts.load(
				`${fontStyle} ${fontWeight} ${annotation.style.fontSize * scaleFactor}px ${annotation.style.fontFamily}`,
			);
		}
		const overlayCanvas = document.createElement("canvas");
		overlayCanvas.width = bounds.width;
		overlayCanvas.height = bounds.height;
		const context = overlayCanvas.getContext("2d");
		if (!context) throw new Error("Failed to get 2D context for native GPU overlay");
		context.translate(-bounds.x, -bounds.y);
		await renderAnnotations(
			context,
			[annotation],
			config.width,
			config.height,
			(annotation.startMs + annotation.endMs) / 2,
			scaleFactor,
		);
		overlayPngs.push(await canvasToPng(overlayCanvas));
	}
	return { wallpaperPng, overlayPngs };
}
