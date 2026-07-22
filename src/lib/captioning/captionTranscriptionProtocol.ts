import type { TrimRegion } from "@/components/video-editor/types";
import type { CaptionSegment, CaptionTimestampGranularity } from "./transcribe";

export const CAPTION_TRANSCRIPTION_CHANNELS = {
	transcribe: "caption-transcription:transcribe",
	status: "caption-transcription:status",
} as const;

export type CaptionTranscriptionPhase = "download" | "model" | "transcribe";

export interface CaptionTranscriptionStatus {
	phase: CaptionTranscriptionPhase;
	percent?: number;
}

export interface CaptionTranscriptionRequest {
	videoPath: string;
	trimRegions: TrimRegion[];
	sourceDurationSec?: number;
}

export interface CaptionTranscriptionResult {
	segments: CaptionSegment[];
	granularity: CaptionTimestampGranularity;
	truncated: boolean;
}
