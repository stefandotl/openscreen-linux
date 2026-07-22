import { describe, expect, it } from "vitest";
import { createPackedI420FrameBuffer } from "./i420Frame";

describe("createPackedI420FrameBuffer", () => {
	it("creates tightly packed planes for a portrait 1080p frame", () => {
		const frame = createPackedI420FrameBuffer(1080, 1920);

		expect(frame.data.byteLength).toBe(3_110_400);
	});

	it("rejects dimensions that I420 cannot represent", () => {
		expect(() => createPackedI420FrameBuffer(1079, 1920)).toThrow(
			"I420 frame dimensions must be even",
		);
		expect(() => createPackedI420FrameBuffer(1080, 0)).toThrow("Invalid I420 frame dimensions");
	});
});
