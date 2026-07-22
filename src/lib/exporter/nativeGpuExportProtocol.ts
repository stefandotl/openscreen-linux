import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";

export const NATIVE_GPU_EXPORT_PROTOCOL_VERSION = 3 as const;

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
	cropRegion: { x: number; y: number; width: number; height: number };
	frames: NativeGpuExportFrame[];
	overlays: NativeGpuExportOverlay[];
}

export interface NativeGpuExportRequest {
	plan: NativeGpuExportPlan;
	outputPath: string;
	audioPath?: string;
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
