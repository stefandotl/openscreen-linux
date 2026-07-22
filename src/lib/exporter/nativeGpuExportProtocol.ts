import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";

export const NATIVE_GPU_EXPORT_PROTOCOL_VERSION = 2 as const;

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
	overlay?: { startMs: number; endMs: number };
}

export interface NativeGpuExportRequest {
	plan: NativeGpuExportPlan;
	outputPath: string;
	audioPath?: string;
	sourceDurationSec: number;
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	wallpaperPng: ArrayBuffer;
	overlayPng?: ArrayBuffer;
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
