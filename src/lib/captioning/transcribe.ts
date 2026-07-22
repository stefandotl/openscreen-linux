import type { TrimRegion } from "@/components/video-editor/types";
import type {
	CaptionTranscriptionResult,
	CaptionTranscriptionStatus,
} from "./captionTranscriptionProtocol";

export interface CaptionSegment {
	startSec: number;
	endSec: number;
	text: string;
}

export type CaptionTimestampGranularity = "word" | "phrase";
export type CaptionEngine = "parakeet" | "whisper-tiny";

export interface TranscribeMono16kResult {
	segments: CaptionSegment[];
	granularity: CaptionTimestampGranularity;
}

export interface TranscribeWorkerRequest {
	samples: Float32Array;
	trimRegions: TrimRegion[];
	useLocalModels: boolean;
	assetBaseUrl?: string;
}

export type TranscribeWorkerResponse =
	| { type: "status"; phase: "model" | "transcribe" }
	| { type: "result"; segments: CaptionSegment[]; granularity: CaptionTimestampGranularity }
	| { type: "error"; message: string };

/**
 * Transcribes the video's audio with the native Parakeet caption service.
 * Model download, audio extraction, and inference run outside the renderer.
 */
export async function transcribeVideoToSegments(
	videoPath: string,
	options?: {
		trimRegions?: TrimRegion[];
		sourceDurationSec?: number;
		onStatus?: (status: CaptionTranscriptionStatus) => void;
	},
): Promise<CaptionTranscriptionResult> {
	const removeStatusListener = options?.onStatus
		? window.electronAPI.onCaptionTranscriptionStatus(options.onStatus)
		: undefined;
	try {
		return await window.electronAPI.transcribeVideoCaptions({
			videoPath,
			trimRegions: options?.trimRegions ?? [],
			sourceDurationSec: options?.sourceDurationSec,
		});
	} finally {
		removeStatusListener?.();
	}
}

/** Runs the compact Whisper Tiny alternative in a renderer Web Worker. */
export function transcribeWhisperMono16kToSegments(
	samples: Float32Array,
	options?: {
		trimRegions?: TrimRegion[];
		onStatus?: (status: CaptionTranscriptionStatus) => void;
		signal?: AbortSignal;
	},
): Promise<TranscribeMono16kResult> {
	if (options?.signal?.aborted) {
		return Promise.reject(new DOMException("Aborted", "AbortError"));
	}

	return new Promise<TranscribeMono16kResult>((resolve, reject) => {
		const worker = new Worker(new URL("./transcribe.worker.ts", import.meta.url), {
			type: "module",
		});

		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			options?.signal?.removeEventListener("abort", onAbort);
			worker.terminate();
			fn();
		};

		const onAbort = () => finish(() => reject(new DOMException("Aborted", "AbortError")));
		options?.signal?.addEventListener("abort", onAbort, { once: true });

		worker.onmessage = (event: MessageEvent<TranscribeWorkerResponse>) => {
			const message = event.data;
			if (message.type === "status") {
				options?.onStatus?.({ phase: message.phase });
				return;
			}
			if (message.type === "result") {
				finish(() => resolve({ segments: message.segments, granularity: message.granularity }));
				return;
			}
			finish(() => reject(new Error(message.message)));
		};

		worker.onerror = (event) => {
			finish(() => reject(new Error(event.message || "Whisper transcription worker failed")));
		};

		const useLocalModels = typeof window !== "undefined" && window.location?.protocol === "file:";
		const assetBaseUrl =
			typeof window !== "undefined" ? window.electronAPI?.assetBaseUrl : undefined;
		const request: TranscribeWorkerRequest = {
			samples,
			trimRegions: options?.trimRegions ?? [],
			useLocalModels,
			assetBaseUrl,
		};
		worker.postMessage(request);
	});
}
