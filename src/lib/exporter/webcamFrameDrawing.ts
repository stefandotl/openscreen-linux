import type { WebcamRotation } from "@/components/video-editor/types";

interface WebcamFrameCrop {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type WebcamCanvasContext = Pick<
	CanvasRenderingContext2D,
	"drawImage" | "restore" | "rotate" | "save" | "scale" | "translate"
>;

export function drawWebcamFrameImage(
	ctx: WebcamCanvasContext,
	image: CanvasImageSource,
	crop: WebcamFrameCrop,
	dest: WebcamFrameCrop,
	mirrored = false,
	rotation: WebcamRotation = 0,
) {
	if (mirrored || rotation !== 0) {
		ctx.save();
		try {
			ctx.translate(dest.x + dest.width / 2, dest.y + dest.height / 2);
			ctx.rotate((rotation * Math.PI) / 180);
			if (mirrored) {
				ctx.scale(-1, 1);
			}
			const swapsAxes = rotation === 90 || rotation === 270;
			const drawWidth = swapsAxes ? dest.height : dest.width;
			const drawHeight = swapsAxes ? dest.width : dest.height;
			ctx.drawImage(
				image,
				crop.x,
				crop.y,
				crop.width,
				crop.height,
				-drawWidth / 2,
				-drawHeight / 2,
				drawWidth,
				drawHeight,
			);
		} finally {
			ctx.restore();
		}
		return;
	}

	ctx.drawImage(
		image,
		crop.x,
		crop.y,
		crop.width,
		crop.height,
		dest.x,
		dest.y,
		dest.width,
		dest.height,
	);
}
