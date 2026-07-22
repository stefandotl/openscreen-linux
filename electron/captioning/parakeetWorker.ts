import { createRequire } from "node:module";
import type { ParakeetModelFiles } from "./parakeetModelManager";

interface ParakeetWorkerRequest {
	sherpaModulePath: string;
	wavPath: string;
	modelFiles: ParakeetModelFiles;
	numThreads: number;
}

interface SherpaRecognitionResult {
	text?: string;
	tokens?: string[];
	timestamps?: number[];
	durations?: number[];
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
	readWave(
		filePath: string,
		exposeExternalArrayBuffer: boolean,
	): { sampleRate: number; samples: Float32Array };
}

function isWorkerRequest(message: unknown): message is ParakeetWorkerRequest {
	if (!message || typeof message !== "object") return false;
	const candidate = message as Partial<ParakeetWorkerRequest>;
	return (
		typeof candidate.sherpaModulePath === "string" &&
		typeof candidate.wavPath === "string" &&
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

async function recognize(request: ParakeetWorkerRequest): Promise<SherpaRecognitionResult> {
	const require = createRequire(import.meta.url);
	const sherpa = require(request.sherpaModulePath) as SherpaModule;
	const recognizer = await sherpa.OfflineRecognizer.createAsync({
		featConfig: { sampleRate: 16_000, featureDim: 80 },
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

	// Electron disables external ArrayBuffers. The worker is deliberately launched in Node mode,
	// and `false` also keeps waveform ownership explicit on all supported platforms.
	const wave = sherpa.readWave(request.wavPath, false);
	if (wave.sampleRate !== 16_000 || wave.samples.length < 800) {
		throw new Error("This video has no usable audio track for captions");
	}
	const stream = recognizer.createStream();
	stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
	return recognizer.decodeAsync(stream);
}

function finish(
	message: { ok: true; result: SherpaRecognitionResult } | { ok: false; error: string },
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
