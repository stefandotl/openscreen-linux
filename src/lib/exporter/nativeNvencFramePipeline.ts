import type { PackedI420FrameBuffer } from "./i420Frame";
import type { NativeNvencFramePortResult } from "./nativeNvencFramePort";

type PendingFrameWrite = {
	frame: PackedI420FrameBuffer;
	result: Promise<NativeNvencFramePortResult>;
};

export type NativeNvencFrameAcknowledgement = {
	acknowledgementMs: number;
};

export type NativeNvencFrameAcquisition = {
	frame: PackedI420FrameBuffer;
	pipelineWaitMs: number;
};

export class NativeNvencFramePipeline {
	private readonly available: PackedI420FrameBuffer[];
	private readonly leased = new Set<PackedI420FrameBuffer>();
	private readonly pending: PendingFrameWrite[] = [];

	constructor(
		frames: PackedI420FrameBuffer[],
		private readonly write: (chunk: ArrayBuffer) => Promise<NativeNvencFramePortResult>,
		private readonly onAcknowledged?: (sample: NativeNvencFrameAcknowledgement) => void,
	) {
		if (frames.length === 0 || new Set(frames).size !== frames.length) {
			throw new Error("Native NVENC frame pipeline requires unique frame buffers");
		}
		this.available = [...frames];
	}

	get depth(): number {
		return this.available.length + this.leased.size + this.pending.length;
	}

	get inFlight(): number {
		return this.pending.length;
	}

	async acquire(): Promise<NativeNvencFrameAcquisition> {
		const waitStartedAtMs = performance.now();
		if (this.available.length === 0) {
			await this.releaseOldest();
		}
		const frame = this.available.pop();
		if (!frame) throw new Error("Native NVENC frame pipeline has no available buffer");
		this.leased.add(frame);
		return {
			frame,
			pipelineWaitMs: performance.now() - waitStartedAtMs,
		};
	}

	submit(frame: PackedI420FrameBuffer): { framePostMs: number } {
		if (!this.leased.delete(frame)) {
			throw new Error("Native NVENC frame buffer was submitted without being acquired");
		}

		const submittedAtMs = performance.now();
		let writeResult: Promise<NativeNvencFramePortResult>;
		try {
			writeResult = this.write(frame.data);
		} catch (error) {
			this.available.push(frame);
			throw error;
		}
		const framePostMs = performance.now() - submittedAtMs;
		const result = writeResult
			.catch((error) => ({
				success: false,
				message: "Native NVENC frame write rejected",
				error: String(error),
			}))
			.then((writeResult) => {
				this.onAcknowledged?.({
					acknowledgementMs: performance.now() - submittedAtMs,
				});
				return writeResult;
			});
		this.pending.push({ frame, result });
		return { framePostMs };
	}

	async flush(): Promise<void> {
		while (this.pending.length > 0) {
			await this.releaseOldest();
		}
		if (this.leased.size > 0) {
			throw new Error("Native NVENC frame pipeline still has an acquired buffer during flush");
		}
	}

	private async releaseOldest(): Promise<void> {
		const pending = this.pending.shift();
		if (!pending) throw new Error("Native NVENC frame pipeline has no pending write");
		const result = await pending.result;
		this.available.push(pending.frame);
		if (!result.success) {
			throw new Error(result.message || result.error || "Native NVENC write failed");
		}
	}
}
