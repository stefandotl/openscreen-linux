// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fixWebmDuration, patchWebmDuration } from "./webmDuration";

const segmentId = [0x18, 0x53, 0x80, 0x67];
const clusterId = [0x1f, 0x43, 0xb6, 0x75];
const unknownSize = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const scale = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40];
const clusters = [
	...clusterId,
	...unknownSize,
	0xe7,
	0x81,
	0,
	...clusterId,
	...unknownSize,
	0xe7,
	0x82,
	0x03,
	0xe8,
];

function recording(infoData = scale, finite = false): Uint8Array {
	const content = [0x15, 0x49, 0xa9, 0x66, 0x80 | infoData.length, ...infoData, ...clusters];
	return new Uint8Array([
		...segmentId,
		...(finite ? [0x80 | content.length] : unknownSize),
		...content,
	]);
}

function patched(bytes: Uint8Array, duration = 2000): Uint8Array {
	const result = patchWebmDuration(bytes, duration);
	expect(result.patched).toBe(true);
	if (!result.patched) throw new Error("Expected duration patch");
	return result.bytes;
}

function durationValue(bytes: Uint8Array): number {
	const offset = bytes.findIndex((byte, i) => byte === 0x44 && bytes[i + 1] === 0x89);
	return new DataView(bytes.buffer, bytes.byteOffset + offset + 3, 8).getFloat64(0);
}

describe("WebM recording duration", () => {
	it("patches the buffered recording path and preserves its media type", async () => {
		const blob = new Blob([recording() as Uint8Array<ArrayBuffer>], {
			type: "video/webm;codecs=h264",
		});
		const fixed = await fixWebmDuration(blob, 2000);
		expect(fixed.type).toBe(blob.type);
		const bytes = new Uint8Array(await fixed.arrayBuffer());
		expect(durationValue(bytes)).toBe(2000);
		expect(bytes.slice(-clusters.length)).toEqual(new Uint8Array(clusters));
		expect(await fixWebmDuration(fixed, 3000)).toBe(fixed);
	});
	it("preserves multiple unknown-size clusters and all media bytes", () => {
		const original = recording();
		const snapshot = original.slice();
		const result = patched(original);
		expect(result.slice(-clusters.length)).toEqual(new Uint8Array(clusters));
		expect(result.slice(4, 12)).toEqual(new Uint8Array(unknownSize));
		expect(durationValue(result)).toBe(2000);
		expect(original).toEqual(snapshot);
		expect(patchWebmDuration(result, 3000)).toEqual({ patched: false, reason: "already-valid" });
	});

	it("updates a finite segment size without changing cluster sizes", () => {
		const original = recording(scale, true);
		const result = patched(original);
		expect(result[4]).toBe(original[4] + 11);
		expect(result.slice(-clusters.length)).toEqual(new Uint8Array(clusters));
	});

	it("expands the Info size field at the VINT boundary", () => {
		const padding = [0xec, 0xeb, ...new Array(107).fill(0)];
		const infoData = [...scale, ...padding];
		const original = recording(infoData);
		const result = patched(original);
		expect(result.length - original.length).toBe(12);
		expect(result[16]).toBe(0x40);
		expect(result[17]).toBe(infoData.length + 11);
		expect(result.slice(-clusters.length)).toEqual(new Uint8Array(clusters));
	});

	it("expands a finite Segment size field at the VINT boundary", () => {
		const original = recording([...scale, 0xec, 0xcb, ...new Array(75).fill(0)], true);
		const result = patched(original);
		expect(result.length - original.length).toBe(12);
		expect(result[4]).toBe(0x40);
		expect(result[5]).toBe((original[4] & 0x7f) + 11);
		expect(result.slice(-clusters.length)).toEqual(new Uint8Array(clusters));
	});

	it("preserves a non-default timestamp scale", () => {
		const result = patched(recording([0x2a, 0xd7, 0xb1, 0x83, 0x1e, 0x84, 0x80]));
		expect(durationValue(result)).toBe(1000);
	});

	it.each([4, 8])("replaces a zero %i-byte duration without moving any other bytes", (width) => {
		const original = recording([...scale, 0x44, 0x89, 0x80 | width, ...new Array(width).fill(0)]);
		const result = patched(original);
		expect(result.length).toBe(original.length);
		const offset = 12 + 5 + scale.length + 3;
		const view = new DataView(result.buffer, offset, width);
		expect(width === 4 ? view.getFloat32(0) : view.getFloat64(0)).toBe(2000);
		expect(result.slice(-clusters.length)).toEqual(new Uint8Array(clusters));
	});

	it("rejects truncated headers and invalid durations", () => {
		expect(() => patchWebmDuration(new Uint8Array([0x18]), 2000)).toThrow("Truncated");
		expect(() => patchWebmDuration(recording(), Number.NaN)).toThrow("Invalid WebM duration");
	});

	it("patches a Buffer view without mutating its backing bytes", () => {
		const original = Buffer.from(recording([...scale, 0x44, 0x89, 0x88, ...new Array(8).fill(0)]));
		const backing = Buffer.concat([Buffer.from([1, 2, 3]), original]);
		const snapshot = Buffer.from(backing);
		const result = patched(backing.subarray(3));
		expect(durationValue(result)).toBe(2000);
		expect(backing).toEqual(snapshot);
	});

	it("does not insert metadata ahead of existing seek positions", () => {
		const original = recording();
		const indexed = new Uint8Array([
			...original.slice(0, 12),
			0x11,
			0x4d,
			0x9b,
			0x74,
			0x80,
			...original.slice(12),
		]);
		expect(() => patchWebmDuration(indexed, 2000)).toThrow("indexed recording");
	});
});
