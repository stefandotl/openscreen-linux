export interface PackedI420FrameBuffer {
	data: ArrayBuffer;
	layout: PlaneLayout[];
}

export function createPackedI420FrameBuffer(width: number, height: number): PackedI420FrameBuffer {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
		throw new Error(`Invalid I420 frame dimensions: ${width}x${height}`);
	}
	if (width % 2 !== 0 || height % 2 !== 0) {
		throw new Error(`I420 frame dimensions must be even: ${width}x${height}`);
	}

	const yBytes = width * height;
	const chromaStride = width / 2;
	const chromaBytes = chromaStride * (height / 2);
	return {
		data: new ArrayBuffer(yBytes + chromaBytes * 2),
		layout: [
			{ offset: 0, stride: width },
			{ offset: yBytes, stride: chromaStride },
			{ offset: yBytes + chromaBytes, stride: chromaStride },
		],
	};
}

export async function copyCanvasToPackedI420(
	canvas: HTMLCanvasElement,
	target: PackedI420FrameBuffer,
	timestamp: number,
	duration: number,
) {
	const frame = new VideoFrame(canvas, { timestamp, duration, alpha: "discard" });
	try {
		const options: VideoFrameCopyToOptions = {
			format: "I420",
			layout: target.layout,
		};
		const requiredBytes = frame.allocationSize(options);
		if (requiredBytes !== target.data.byteLength) {
			throw new Error(
				`Unexpected I420 allocation size: ${requiredBytes} (expected ${target.data.byteLength})`,
			);
		}
		await frame.copyTo(target.data, options);
	} finally {
		frame.close();
	}
}
