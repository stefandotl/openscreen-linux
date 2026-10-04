interface ElementHeader {
	id: number;
	sizeOffset: number;
	sizeWidth: number;
	dataOffset: number;
	end: number;
	unknownSize: boolean;
}

function readElement(bytes: Uint8Array, offset: number, limit: number): ElementHeader {
	const widthAt = (position: number, max: number) => {
		const first = bytes[position];
		if (!first) throw new Error("Invalid WebM element header");
		const width = Math.clz32(first) - 23;
		if (width > max || position + width > limit) throw new Error("Truncated WebM header");
		return width;
	};
	const idWidth = widthAt(offset, 4);
	let id = 0;
	for (let i = 0; i < idWidth; i++) id = id * 256 + bytes[offset + i];
	const sizeOffset = offset + idWidth;
	const sizeWidth = widthAt(sizeOffset, 8);
	let size = BigInt(bytes[sizeOffset] & (0xff >> sizeWidth));
	for (let i = 1; i < sizeWidth; i++) size = size * 256n + BigInt(bytes[sizeOffset + i]);
	const unknownSize = size === (1n << BigInt(sizeWidth * 7)) - 1n;
	const dataOffset = sizeOffset + sizeWidth;
	const end = unknownSize ? limit : dataOffset + Number(size);
	if (!Number.isSafeInteger(end) || end > limit) throw new Error("Invalid WebM element size");
	return { id, sizeOffset, sizeWidth, dataOffset, end, unknownSize };
}

function encodeSize(size: number, minimumWidth: number): Uint8Array {
	let width = minimumWidth;
	while (BigInt(size) >= (1n << BigInt(width * 7)) - 1n && width < 8) width++;
	let value = BigInt(size) | (1n << BigInt(width * 7));
	const result = new Uint8Array(width);
	for (let i = width - 1; i >= 0; i--) {
		result[i] = Number(value & 255n);
		value >>= 8n;
	}
	return result;
}

function concatenate(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

export type WebmDurationPatch =
	| { patched: true; bytes: Uint8Array<ArrayBuffer> }
	| { patched: false; reason: "no-section" | "already-valid" };

/**
 * Patch only recording metadata. Reserializing an unknown-size Cluster as a finite
 * binary element incorrectly nests subsequent sibling Clusters inside it.
 */
export function patchWebmDuration(bytes: Uint8Array, durationMs: number): WebmDurationPatch {
	if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Invalid WebM duration");
	let segment: ElementHeader | undefined;
	for (let offset = 0; offset < bytes.length; ) {
		const element = readElement(bytes, offset, bytes.length);
		if (element.id === 0x18538067) {
			segment = element;
			break;
		}
		offset = element.end;
	}
	if (!segment) return { patched: false, reason: "no-section" };
	let info: ElementHeader | undefined;
	let indexed = false;
	for (let offset = segment.dataOffset; offset < segment.end; ) {
		const element = readElement(bytes, offset, segment.end);
		if (element.id === 0x1f43b675) break;
		if (element.id === 0x114d9b74 || element.id === 0x1c53bb6b) indexed = true;
		if (element.id === 0x1549a966) info = element;
		offset = element.end;
	}
	if (!info || info.unknownSize) return { patched: false, reason: "no-section" };
	let scaleNs = 1_000_000;
	let duration: ElementHeader | undefined;
	for (let offset = info.dataOffset; offset < info.end; ) {
		const element = readElement(bytes, offset, info.end);
		if (element.id === 0x2ad7b1) {
			scaleNs = 0;
			for (const byte of bytes.subarray(element.dataOffset, element.end))
				scaleNs = scaleNs * 256 + byte;
		}
		if (element.id === 0x4489) duration = element;
		offset = element.end;
	}
	if (!Number.isSafeInteger(scaleNs) || scaleNs <= 0)
		throw new Error("Invalid WebM timestamp scale");
	if (duration) {
		const width = duration.end - duration.dataOffset;
		if (width !== 4 && width !== 8) throw new Error("Invalid WebM duration element");
		const view = new DataView(bytes.buffer, bytes.byteOffset + duration.dataOffset, width);
		const existing = width === 4 ? view.getFloat32(0) : view.getFloat64(0);
		if (Number.isFinite(existing) && existing > 0) {
			return { patched: false, reason: "already-valid" };
		}
		const result = new Uint8Array(bytes);
		const output = new DataView(result.buffer, duration.dataOffset, width);
		if (width === 4) output.setFloat32(0, (durationMs * 1_000_000) / scaleNs);
		else output.setFloat64(0, (durationMs * 1_000_000) / scaleNs);
		return { patched: true, bytes: result };
	}
	// Inserting metadata would invalidate stored cue/seek positions in an indexed file.
	if (indexed) throw new Error("Cannot insert WebM duration into an indexed recording");
	const addition = new Uint8Array(11);
	addition.set([0x44, 0x89, 0x88]);
	new DataView(addition.buffer).setFloat64(3, (durationMs * 1_000_000) / scaleNs);
	const infoSize = encodeSize(info.end - info.dataOffset + addition.length, info.sizeWidth);
	const growth = addition.length + infoSize.length - info.sizeWidth;
	const segmentSize = segment.unknownSize
		? bytes.subarray(segment.sizeOffset, segment.dataOffset)
		: encodeSize(segment.end - segment.dataOffset + growth, segment.sizeWidth);
	return {
		patched: true,
		bytes: concatenate(
			bytes.subarray(0, segment.sizeOffset),
			segmentSize,
			bytes.subarray(segment.dataOffset, info.sizeOffset),
			infoSize,
			bytes.subarray(info.dataOffset, info.end),
			addition,
			bytes.subarray(info.end),
		),
	};
}

export async function fixWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
	const result = patchWebmDuration(new Uint8Array(await blob.arrayBuffer()), durationMs);
	return result.patched ? new Blob([result.bytes], { type: blob.type }) : blob;
}
