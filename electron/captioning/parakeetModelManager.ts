import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import unbzip2 from "unbzip2-stream";

export const PARAKEET_MODEL_ID = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
export const PARAKEET_MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${PARAKEET_MODEL_ID}.tar.bz2`;

const REQUIRED_MODEL_FILES = {
	"encoder.int8.onnx": 500 * 1024 * 1024,
	"decoder.int8.onnx": 5 * 1024 * 1024,
	"joiner.int8.onnx": 2 * 1024 * 1024,
	"tokens.txt": 10 * 1024,
} as const;

export interface ParakeetDownloadProgress {
	received: number;
	total: number;
	percent?: number;
}

export interface ParakeetModelFiles {
	encoder: string;
	decoder: string;
	joiner: string;
	tokens: string;
}

function isPathWithinDirectory(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function validateParakeetModel(modelDirectory: string): Promise<boolean> {
	try {
		for (const [name, minimumSize] of Object.entries(REQUIRED_MODEL_FILES)) {
			const stat = await fs.stat(path.join(modelDirectory, name));
			if (!stat.isFile() || stat.size < minimumSize) return false;
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function extractModelArchive(
	response: Response,
	destination: string,
	onProgress: (progress: ParakeetDownloadProgress) => void,
): Promise<void> {
	if (!response.body) throw new Error("Parakeet model download returned no data");

	const total = Number(response.headers.get("content-length")) || 0;
	let received = 0;
	const progress = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			received += chunk.length;
			onProgress({
				received,
				total,
				...(total > 0 ? { percent: Math.round((received / total) * 100) } : {}),
			});
			callback(null, chunk);
		},
	});

	const extract = tar.extract();
	extract.on("entry", (header, entry, next) => {
		const archivePath = path.posix.normalize(header.name);
		const parts = archivePath.split("/").filter(Boolean);
		if (parts[0] !== PARAKEET_MODEL_ID || parts.includes("..")) {
			extract.destroy(new Error(`Unsafe path in Parakeet model archive: ${header.name}`));
			return;
		}

		const target = path.resolve(destination, ...parts);
		if (!isPathWithinDirectory(destination, target)) {
			extract.destroy(new Error(`Unsafe path in Parakeet model archive: ${header.name}`));
			return;
		}

		if (header.type === "directory") {
			entry.resume();
			fs.mkdir(target, { recursive: true }).then(
				() => next(),
				(error) => extract.destroy(error),
			);
			return;
		}

		if (header.type !== "file") {
			entry.resume();
			entry.once("end", next);
			return;
		}

		fs.mkdir(path.dirname(target), { recursive: true })
			.then(() => pipeline(entry, createWriteStream(target, { mode: 0o600 })))
			.then(
				() => next(),
				(error) => extract.destroy(error),
			);
	});

	await pipeline(
		Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
		progress,
		unbzip2(),
		extract,
	);
}

export class ParakeetModelManager {
	readonly modelDirectory: string;
	private downloadPromise: Promise<void> | null = null;

	constructor(private readonly modelsDirectory: string) {
		this.modelDirectory = path.join(modelsDirectory, PARAKEET_MODEL_ID);
	}

	getModelFiles(): ParakeetModelFiles {
		return {
			encoder: path.join(this.modelDirectory, "encoder.int8.onnx"),
			decoder: path.join(this.modelDirectory, "decoder.int8.onnx"),
			joiner: path.join(this.modelDirectory, "joiner.int8.onnx"),
			tokens: path.join(this.modelDirectory, "tokens.txt"),
		};
	}

	async ensureDownloaded(onProgress: (progress: ParakeetDownloadProgress) => void): Promise<void> {
		if (await validateParakeetModel(this.modelDirectory)) return;
		if (!this.downloadPromise) {
			this.downloadPromise = this.download(onProgress).finally(() => {
				this.downloadPromise = null;
			});
		}
		await this.downloadPromise;
	}

	private async download(onProgress: (progress: ParakeetDownloadProgress) => void): Promise<void> {
		await fs.mkdir(this.modelsDirectory, { recursive: true });
		const stagingDirectory = await fs.mkdtemp(
			path.join(this.modelsDirectory, ".parakeet-download-"),
		);

		try {
			const response = await fetch(PARAKEET_MODEL_URL, { redirect: "follow" });
			if (!response.ok) {
				throw new Error(`Parakeet model download failed (HTTP ${response.status})`);
			}

			await extractModelArchive(response, stagingDirectory, onProgress);
			const extractedDirectory = path.join(stagingDirectory, PARAKEET_MODEL_ID);
			if (!(await validateParakeetModel(extractedDirectory))) {
				throw new Error("Downloaded Parakeet model is incomplete");
			}

			await fs.rm(this.modelDirectory, { recursive: true, force: true });
			await fs.rename(extractedDirectory, this.modelDirectory);
			onProgress({ received: 1, total: 1, percent: 100 });
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				throw new Error("Parakeet model download was aborted");
			}
			throw error;
		} finally {
			await fs.rm(stagingDirectory, { recursive: true, force: true });
		}
	}
}
