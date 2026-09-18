import fs, { type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { createParakeetChunkWindows, PARAKEET_SAMPLE_RATE } from "./parakeetChunking";
import type { ParakeetModelFiles } from "./parakeetModelManager";

interface ParakeetWorkerRequest {
	sherpaModulePath: string;
	pcmPath: string;
	modelFiles: ParakeetModelFiles;
	numThreads: number;
}

interface SherpaRecognitionResult {
	text?: string;
	tokens?: string[];
	timestamps?: number[];
	durations?: number[];
}

interface SherpaRecognitionChunk {
	result: SherpaRecognitionResult;
	audioStartSec: number;
	keepStartSec: number;
	keepEndSec: number;
	isLast: boolean;
}

interface SherpaRecognizer {
	createStream(): {
		acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
	};
	decodeAsync(stream: unknown): Promise<SherpaRecognitionResult>;
}

interface SherpaModule {
	OfflineRecognizer: {
		createAsync(config: Record<string, unknown>): Promise<SherpaRecognizer>;
	};
}

function isWorkerRequest(message: unknown): message is ParakeetWorkerRequest {
	if (!message || typeof message !== "object") return false;
	const candidate = message as Partial<ParakeetWorkerRequest>;
	return (
		typeof candidate.sherpaModulePath === "string" &&
		typeof candidate.pcmPath === "string" &&
		Boolean(candidate.modelFiles) &&
		typeof candidate.modelFiles?.encoder === "string" &&
		typeof candidate.modelFiles.decoder === "string" &&
		typeof candidate.modelFiles.joiner === "string" &&
		typeof candidate.modelFiles.tokens === "string" &&
		typeof candidate.numThreads === "number" &&
		Number.isInteger(candidate.numThreads) &&
		candidate.numThreads >= 1 &&
		candidate.numThreads <= 4
	);
}

async function readPcm16LeChunk(
	file: FileHandle,
	startSample: number,
	endSample: number,
): Promise<Float32Array> {
	const sampleCount = endSample - startSample;
	const pcm = Buffer.allocUnsafe(sampleCount * 2);
	let bytesRead = 0;
	while (bytesRead < pcm.byteLength) {
		const result = await file.read(
			pcm,
			bytesRead,
			pcm.byteLength - bytesRead,
			startSample * 2 + bytesRead,
		);
		if (result.bytesRead === 0) {
			throw new Error("Parakeet PCM audio ended before the requested chunk was read");
		}
		bytesRead += result.bytesRead;
	}

	const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	const samples = new Float32Array(sampleCount);
	for (let index = 0; index < sampleCount; index += 1) {
		samples[index] = view.getInt16(index * 2, true) / 32_768;
	}
	return samples;
}

async function recognize(request: ParakeetWorkerRequest): Promise<SherpaRecognitionChunk[]> {
	const require = createRequire(import.meta.url);
	const sherpa = require(request.sherpaModulePath) as SherpaModule;
	const recognizer = await sherpa.OfflineRecognizer.createAsync({
		featConfig: { sampleRate: PARAKEET_SAMPLE_RATE, featureDim: 80 },
		modelConfig: {
			transducer: {
				encoder: request.modelFiles.encoder,
				decoder: request.modelFiles.decoder,
				joiner: request.modelFiles.joiner,
			},
			tokens: request.modelFiles.tokens,
			numThreads: request.numThreads,
			provider: "cpu",
			modelType: "nemo_transducer",
			debug: 0,
		},
	});

	const file = await fs.open(request.pcmPath, "r");
	try {
		const stat = await file.stat();
		if (stat.size % 2 !== 0) {
			throw new Error("Caption audio extraction returned incomplete PCM data");
		}
		const totalSamples = stat.size / 2;
		if (totalSamples < 800) {
			throw new Error("This video has no usable audio track for captions");
		}

		const chunks: SherpaRecognitionChunk[] = [];
		for (const window of createParakeetChunkWindows(totalSamples)) {
			const samples = await readPcm16LeChunk(file, window.readStartSample, window.readEndSample);
			const stream = recognizer.createStream();
			stream.acceptWaveform({ sampleRate: PARAKEET_SAMPLE_RATE, samples });
			chunks.push({
				result: await recognizer.decodeAsync(stream),
				audioStartSec: window.readStartSample / PARAKEET_SAMPLE_RATE,
				keepStartSec: window.keepStartSample / PARAKEET_SAMPLE_RATE,
				keepEndSec: window.keepEndSample / PARAKEET_SAMPLE_RATE,
				isLast: window.isLast,
			});
		}
		return chunks;
	} finally {
		await file.close();
	}
}

function finish(
	message: { ok: true; result: SherpaRecognitionChunk[] } | { ok: false; error: string },
) {
	if (!process.send) {
		process.exitCode = 1;
		return;
	}
	process.send(message, () => process.disconnect());
}

process.once("message", (message) => {
	if (!isWorkerRequest(message)) {
		finish({ ok: false, error: "Parakeet transcription process received an invalid request" });
		return;
	}

	void recognize(message).then(
		(result) => finish({ ok: true, result }),
		(error) => finish({ ok: false, error: error instanceof Error ? error.message : String(error) }),
	);
});
