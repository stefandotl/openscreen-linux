import { afterEach, describe, expect, it } from "vitest";
import { createPackedI420FrameBuffer, GpuI420FrameConverter } from "./i420Frame";

const converters: GpuI420FrameConverter[] = [];

afterEach(() => {
	for (const converter of converters) converter.destroy();
	converters.length = 0;
});

describe("GpuI420FrameConverter (real browser)", () => {
	it("converts canvas pixels to packed top-down BT.709 I420", () => {
		const canvas = document.createElement("canvas");
		canvas.width = 4;
		canvas.height = 4;
		const context = canvas.getContext("2d");
		expect(context).not.toBeNull();

		context!.fillStyle = "rgb(255, 0, 0)";
		context!.fillRect(0, 0, 4, 2);
		context!.fillStyle = "rgb(0, 0, 255)";
		context!.fillRect(0, 2, 4, 2);

		const converter = new GpuI420FrameConverter(4, 4);
		converters.push(converter);
		const target = createPackedI420FrameBuffer(4, 4);
		const converted = converter.convert(canvas, target);
		const bytes = converted.view;

		expect(converted).toBe(target);

		expect([...bytes.subarray(0, 8)]).toEqual(new Array(8).fill(63));
		expect([...bytes.subarray(8, 16)]).toEqual(new Array(8).fill(32));
		expect([...bytes.subarray(16, 18)]).toEqual([102, 102]);
		expect([...bytes.subarray(18, 20)]).toEqual([240, 240]);
		expect([...bytes.subarray(20, 22)]).toEqual([240, 240]);
		expect([...bytes.subarray(22, 24)]).toEqual([118, 118]);
	});

	it("rejects a canvas whose dimensions do not match the export", () => {
		const converter = new GpuI420FrameConverter(4, 4);
		converters.push(converter);
		const canvas = document.createElement("canvas");
		canvas.width = 8;
		canvas.height = 4;

		expect(() => converter.convert(canvas)).toThrow("GPU I420 source dimensions changed");
	});
});
