import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";

export const NATIVE_GPU_EXPORT_PROTOCOL_VERSION = 8 as const;

export const NATIVE_GPU_EXPORT_CHANNELS = {
	start: "start-native-gpu-export",
	finish: "finish-native-gpu-export",
	cancel: "cancel-native-gpu-export",
	progress: "native-gpu-export-progress",
} as const;

export interface NativeGpuExportFrame {
	sourceTimestampMs: number;
	cameraScale: number;
	cameraX: number;
	cameraY: number;
	motionBlurX: number;
	motionBlurY: number;
	webcamScale: number;
}

export interface NativeGpuExportOverlay {
	startMs: number;
	endMs: number;
	x: number;
	y: number;
	width: number;
	height: number;
	zIndex: number;
}

export interface NativeGpuExportBlurRegion {
	startMs: number;
	endMs: number;
	x: number;
	y: number;
	width: number;
	height: number;
	type: "blur" | "mosaic";
	intensity: number;
	shape: "rectangle" | "oval";
	blockSize: number;
	color: "white" | "black";
	zIndex: number;
}

export interface NativeGpuExportPlan {
	version: typeof NATIVE_GPU_EXPORT_PROTOCOL_VERSION;
	inputPath: string;
	width: number;
	height: number;
	frameRate: number;
	bitrate: number;
	sourceWidth: number;
	sourceHeight: number;
	screenRect: { x: number; y: number; width: number; height: number };
	screenCover: boolean;
	screenBorderRadius: number;
	cropRegion: { x: number; y: number; width: number; height: number };
	webcam?: {
		inputPath: string;
		sourceWidth: number;
		sourceHeight: number;
		durationMs: number;
		videoOffsetMs: number;
		rect: { x: number; y: number; width: number; height: number };
		borderRadius: number;
		maskShape: "rectangle" | "rounded" | "circle" | "square";
		mirrored: boolean;
		rotation: import("@/components/video-editor/types").WebcamRotation;
		anchorRight: boolean;
		anchorBottom: boolean;
		shadow: {
			color: string;
			blur: number;
			offsetX: number;
			offsetY: number;
		} | null;
	};
	frames: NativeGpuExportFrame[];
	blurRegions: NativeGpuExportBlurRegion[];
	overlays: NativeGpuExportOverlay[];
}

export interface NativeGpuExportRequest {
	plan: NativeGpuExportPlan;
	outputPath: string;
	audioPath?: string;
	/** Multi-scene exports require every segment to expose the same audio layout. */
	ensureAudioTrack?: boolean;
	sourceDurationSec: number;
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	wallpaperPng: ArrayBuffer;
	overlayPngs: ArrayBuffer[];
}

export interface NativeGpuExportProgress {
	sessionId: string;
	phase: "rendering" | "finalizing";
	currentFrame: number;
	totalFrames: number;
	fps: number;
}

export interface NativeGpuExportStartResult {
	success: boolean;
	sessionId?: string;
	message?: string;
	error?: string;
}

export interface NativeGpuExportFinishResult {
	success: boolean;
	path?: string;
	message?: string;
	error?: string;
	stderr?: string;
}
