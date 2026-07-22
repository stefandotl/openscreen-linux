import { describe, expect, it } from "vitest";
import { createNativeNvdecVideoFrame } from "./nativeNvdecFramePort";

describe("native NVDEC frame", () => {
	it("wraps a packed NV12 frame as a WebCodecs VideoFrame", () => {
		const frame = createNativeNvdecVideoFrame(
			new ArrayBuffer(12),
			{
				width: 4,
				height: 2,
				frameRate: 30,
			},
			3,
		);

		try {
			expect(frame.format).toBe("NV12");
			expect(frame.codedWidth).toBe(4);
			expect(frame.codedHeight).toBe(2);
			expect(frame.timestamp).toBe(100_000);
			expect(frame.allocationSize()).toBe(12);
		} finally {
			frame.close();
		}
	});
});
