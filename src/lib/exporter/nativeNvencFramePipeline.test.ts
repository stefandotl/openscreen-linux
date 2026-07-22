import { describe, expect, it } from "vitest";
import type { PackedI420FrameBuffer } from "./i420Frame";
import { NativeNvencFramePipeline } from "./nativeNvencFramePipeline";
import type { NativeNvencFramePortResult } from "./nativeNvencFramePort";

function createFrame(id: number): PackedI420FrameBuffer {
	const data = new ArrayBuffer(1);
	const view = new Uint8Array(data);
	view[0] = id;
	return { data, view };
}

function deferredResult() {
	let resolve!: (result: NativeNvencFramePortResult) => void;
	const promise = new Promise<NativeNvencFramePortResult>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("NativeNvencFramePipeline", () => {
	it("allows two writes in flight and applies backpressure before reusing the oldest buffer", async () => {
		const writes = [deferredResult(), deferredResult()];
		let writeIndex = 0;
		const frames = [createFrame(1), createFrame(2)];
		const pipeline = new NativeNvencFramePipeline(frames, () => writes[writeIndex++].promise);

		const first = await pipeline.acquire();
		pipeline.submit(first.frame);
		const second = await pipeline.acquire();
		pipeline.submit(second.frame);
		expect(pipeline.inFlight).toBe(2);

		let thirdAcquired = false;
		const thirdPromise = pipeline.acquire().then((acquisition) => {
			thirdAcquired = true;
			return acquisition;
		});
		await Promise.resolve();
		expect(thirdAcquired).toBe(false);

		writes[0].resolve({ success: true });
		const third = await thirdPromise;
		expect(third.frame).toBe(first.frame);
		expect(pipeline.inFlight).toBe(1);

		writes.push(deferredResult());
		writes[1].resolve({ success: true });
		pipeline.submit(third.frame);
		writes[2].resolve({ success: true });
		await pipeline.flush();
		expect(pipeline.inFlight).toBe(0);
	});

	it("fails loudly when an acknowledged write fails", async () => {
		const pipeline = new NativeNvencFramePipeline([createFrame(1)], async () => ({
			success: false,
			message: "ffmpeg stdin failed",
		}));
		const acquisition = await pipeline.acquire();
		pipeline.submit(acquisition.frame);

		await expect(pipeline.flush()).rejects.toThrow("ffmpeg stdin failed");
	});

	it("reports acknowledgement latency", async () => {
		const acknowledgements: number[] = [];
		const pipeline = new NativeNvencFramePipeline(
			[createFrame(1)],
			async () => ({ success: true }),
			({ acknowledgementMs }) => acknowledgements.push(acknowledgementMs),
		);
		const acquisition = await pipeline.acquire();
		pipeline.submit(acquisition.frame);
		await pipeline.flush();

		expect(acknowledgements).toHaveLength(1);
		expect(acknowledgements[0]).toBeGreaterThanOrEqual(0);
	});
});
