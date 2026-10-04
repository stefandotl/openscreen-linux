import type { TrimRegion } from "@/components/video-editor/types";
import type {
	CaptionTranscriptionResult,
	CaptionTranscriptionStatus,
} from "./captionTranscriptionProtocol";

export interface CaptionWordSegment {
	startSec: number;
	endSec: number;
	text: string;
}

export interface CaptionSegment extends CaptionWordSegment {
	/** Word-level timing retained while transcription segments are grouped into visible lines. */
	words?: CaptionWordSegment[];
}

export type CaptionTimestampGranularity = "word" | "phrase";
export type CaptionEngine = "parakeet" | "whisper-tiny" | "openrouter";

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
 * Transcribes with local Parakeet or the explicitly selected OpenRouter model.
 * Audio extraction, local inference and provider credentials stay in the main process.
 */
export async function transcribeVideoToSegments(
	videoPath: string,
	options?: {
		engine?: "parakeet" | "openrouter";
		model?: string;
		signal?: AbortSignal;
		trimRegions?: TrimRegion[];
		sourceDurationSec?: number;
		onStatus?: (status: CaptionTranscriptionStatus) => void;
	},
): Promise<CaptionTranscriptionResult> {
	options?.signal?.throwIfAborted();
	const requestId = options?.engine === "openrouter" ? crypto.randomUUID() : undefined;
	const removeStatusListener = options?.onStatus
		? window.electronAPI.onCaptionTranscriptionStatus((status) => {
				if (status.requestId === requestId) options.onStatus?.(status);
			})
		: undefined;
	const abort = () => {
		if (requestId)
			void window.electronAPI.cancelCaptionTranscription(requestId).catch(() => {
				// The main process also cancels when the editor is destroyed.
			});
	};
	try {
		const pending = window.electronAPI.transcribeVideoCaptions({
			videoPath,
			...(requestId ? { requestId, engine: "openrouter", model: options?.model } : {}),
			trimRegions: options?.trimRegions ?? [],
			sourceDurationSec: options?.sourceDurationSec,
		});
		options?.signal?.addEventListener("abort", abort, { once: true });
		if (options?.signal?.aborted) abort();
		return await pending;
	} finally {
		options?.signal?.removeEventListener("abort", abort);
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
