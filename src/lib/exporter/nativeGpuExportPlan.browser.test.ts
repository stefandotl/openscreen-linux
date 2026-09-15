import { describe, expect, it } from "vitest";
import type { AnnotationRegion } from "@/components/video-editor/types";
import { renderAnnotations } from "./annotationRenderer";
import { createNativeGpuExportAssets, getNativeGpuExportBlockers } from "./nativeGpuExportPlan";
import type { VideoExporterConfig } from "./videoExporter";

function createConfig(showBlur: boolean): VideoExporterConfig {
	return {
		videoUrl: "/tmp/source.mp4",
		width: 320,
		height: 180,
		frameRate: 30,
		bitrate: 4_000_000,
		wallpaper: "linear-gradient(90deg, #000 0%, #000 50%, #fff 50%, #fff 100%)",
		zoomRegions: [],
		trimRegions: [],
		speedRegions: [],
		annotationRegions: [],
		showShadow: false,
		shadowIntensity: 0,
		showBlur,
		motionBlurAmount: 0,
		borderRadius: 0,
		padding: 14,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
	};
}

function caption(id: string, startMs: number, endMs: number, zIndex: number): AnnotationRegion {
	return {
		id,
		startMs,
		endMs,
		type: "text",
		content: id,
		position: { x: 10, y: 60 },
		size: { width: 80, height: 20 },
		style: {
			color: "#ffffff",
			backgroundColor: "#000000",
			fontSize: 24,
			fontFamily: "sans-serif",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
			textAnimation: "none",
		},
		zIndex,
	};
}

async function pngSize(png: ArrayBuffer) {
	const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
	const size = { width: bitmap.width, height: bitmap.height };
	bitmap.close();
	return size;
}

async function pngContainsColor(
	png: ArrayBuffer,
	matches: (red: number, green: number, blue: number, alpha: number) => boolean,
) {
	const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
	const canvas = document.createElement("canvas");
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Could not inspect rendered overlay PNG");
	context.drawImage(bitmap, 0, 0);
	bitmap.close();
	const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
	for (let index = 0; index < pixels.length; index += 4) {
		if (matches(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!, pixels[index + 3]!)) {
			return true;
		}
	}
	return false;
}

describe("native GPU export assets", () => {
	it("bakes background blur into the static wallpaper asset", async () => {
		const sharp = await createNativeGpuExportAssets(createConfig(false));
		const blurred = await createNativeGpuExportAssets(createConfig(true));

		expect(sharp.wallpaperPng.byteLength).toBeGreaterThan(100);
		expect(blurred.wallpaperPng.byteLength).toBeGreaterThan(100);
		expect(new Uint8Array(blurred.wallpaperPng)).not.toEqual(new Uint8Array(sharp.wallpaperPng));
	});

	it("creates one cropped PNG per annotation in z-order", async () => {
		const assets = await createNativeGpuExportAssets({
			...createConfig(false),
			annotationRegions: [
				caption("top", 200, 700, 20),
				caption("bottom", 0, 500, 2),
				caption("middle", 500, 900, 10),
			],
		});

		expect(assets.overlayPngs).toHaveLength(3);
		expect(assets.overlayPngs.every((png) => png.byteLength > 100)).toBe(true);
		expect(await Promise.all(assets.overlayPngs.map(pngSize))).toEqual([
			{ width: 256, height: 36 },
			{ width: 256, height: 36 },
			{ width: 256, height: 36 },
		]);
		expect(assets.overlays.map((overlay) => overlay.zIndex)).toEqual([2, 10, 20]);
	});

	it("keeps mosaic regions out of the static text-overlay assets", async () => {
		const mosaic: AnnotationRegion = {
			...caption("mosaic", 100, 800, 10),
			type: "blur",
			blurData: {
				type: "mosaic",
				shape: "rectangle",
				color: "black",
				intensity: 12,
				blockSize: 16,
			},
		};
		const assets = await createNativeGpuExportAssets({
			...createConfig(false),
			annotationRegions: [caption("caption", 0, 900, 2), mosaic],
		});

		expect(assets.overlayPngs).toHaveLength(1);
		expect(assets.overlays).toHaveLength(1);
		expect(assets.overlays[0]?.zIndex).toBe(2);
	});

	it("creates a static caption plus tightly cropped timed word highlights", async () => {
		const highlighted = caption("caption", 100, 900, 5);
		highlighted.content = "one two";
		highlighted.style.backgroundColor = "transparent";
		highlighted.style.wordHighlight = true;
		highlighted.style.wordHighlightColor = "#34B27B";
		highlighted.captionWords = [
			{ text: "one", startOffsetMs: 0, endOffsetMs: 300 },
			{ text: "two", startOffsetMs: 400, endOffsetMs: 800 },
		];

		const assets = await createNativeGpuExportAssets({
			...createConfig(false),
			annotationRegions: [highlighted],
		});

		expect(assets.overlayPngs).toHaveLength(3);
		expect(assets.overlays).toEqual([
			{ startMs: 100, endMs: 900, x: 32, y: 108, width: 256, height: 36, zIndex: 5 },
			expect.objectContaining({ startMs: 100, endMs: 400, zIndex: 5 }),
			expect.objectContaining({ startMs: 500, endMs: 900, zIndex: 5 }),
		]);
		const sizes = await Promise.all(assets.overlayPngs.map(pngSize));
		expect(sizes[1]!.width).toBeLessThan(sizes[0]!.width);
		expect(sizes[2]!.width).toBeLessThan(sizes[0]!.width);
	});

	it("renders text-color word highlights with the selected color", async () => {
		const highlighted = caption("caption", 100, 900, 5);
		highlighted.content = "one two";
		highlighted.style.backgroundColor = "transparent";
		highlighted.style.wordHighlight = true;
		highlighted.style.wordHighlightMode = "text";
		highlighted.style.wordHighlightColor = "#ff0066";
		highlighted.captionWords = [
			{ text: "one", startOffsetMs: 0, endOffsetMs: 300 },
			{ text: "two", startOffsetMs: 400, endOffsetMs: 800 },
		];

		const assets = await createNativeGpuExportAssets({
			...createConfig(false),
			annotationRegions: [highlighted],
		});

		expect(assets.overlayPngs).toHaveLength(3);
		expect(
			await pngContainsColor(
				assets.overlayPngs[1]!,
				(red, green, blue, alpha) => red > 240 && green < 20 && blue > 80 && alpha > 200,
			),
		).toBe(true);
	});

	it("renders text outlines with the configured outline color", async () => {
		const outlined = caption("outlined", 100, 900, 5);
		outlined.style.backgroundColor = "transparent";
		outlined.style.textStrokeWidth = 2;
		outlined.style.textStrokeColor = "#000000";
		outlined.style.color = "#ffffff";

		const assets = await createNativeGpuExportAssets({
			...createConfig(false),
			annotationRegions: [outlined],
		});

		expect(assets.overlayPngs).toHaveLength(1);
		expect(
			await pngContainsColor(
				assets.overlayPngs[0]!,
				(red, green, blue, alpha) => red < 20 && green < 20 && blue < 20 && alpha > 120,
			),
		).toBe(true);
	});
});

it("keeps clipped word highlights as transparent no-ops instead of rejecting normal text boxes", async () => {
	const highlighted = caption("annotation-1", 0, 1000, 5);
	highlighted.content = "first\nsecond\nvisible\nfourth\nlast";
	highlighted.size.height = 20;
	highlighted.style.backgroundColor = "transparent";
	highlighted.style.wordHighlight = true;
	highlighted.style.wordHighlightMode = "text";
	highlighted.style.wordHighlightColor = "#ff0066";
	highlighted.captionWords = highlighted.content
		.split("\n")
		.map((text, index) => ({ text, startOffsetMs: index * 200, endOffsetMs: (index + 1) * 200 }));
	const assets = await createNativeGpuExportAssets({
		...createConfig(false),
		annotationRegions: [highlighted],
	});
	expect(assets.overlays.map(({ startMs, endMs }) => ({ startMs, endMs }))).toEqual([
		{ startMs: 0, endMs: 1000 },
		{ startMs: 400, endMs: 600 },
	]);
	expect(
		await pngContainsColor(
			assets.overlayPngs[1]!,
			(r, g, b, a) => r > 240 && g < 20 && b > 80 && a > 200,
		),
	).toBe(true);
});

describe("separate content tracks in native assets", () => {
	it("matches preview timing and z-order for three captions, two overlapping texts and an image", async () => {
		const config = createConfig(false);
		const image = document.createElement("canvas");
		image.width = 80;
		image.height = 40;
		const imageContext = image.getContext("2d")!;
		imageContext.fillStyle = "#00ff00";
		imageContext.fillRect(0, 0, 80, 40);
		config.annotationRegions = [
			{ ...caption("caption 1", 0, 300, 5), annotationSource: "auto-caption" },
			{ ...caption("caption 2", 300, 600, 5), annotationSource: "auto-caption" },
			{ ...caption("caption 3", 600, 900, 5), annotationSource: "auto-caption" },
			caption("below", 200, 700, 2),
			caption("above", 400, 800, 10),
			{ ...caption("image", 100, 500, 3), type: "image", content: image.toDataURL() },
		];
		expect(getNativeGpuExportBlockers(config, { width: 320, height: 180, duration: 1 })).toEqual(
			[],
		);
		const assets = await createNativeGpuExportAssets(config);
		expect(assets.overlays).toHaveLength(6);
		const bitmaps = await Promise.all(
			assets.overlayPngs.map((png) => createImageBitmap(new Blob([png], { type: "image/png" }))),
		);
		try {
			for (const time of [0, 100, 299, 300, 400, 500, 600, 800, 900]) {
				const preview = document.createElement("canvas");
				const native = document.createElement("canvas");
				for (const canvas of [preview, native]) {
					canvas.width = config.width;
					canvas.height = config.height;
				}
				await renderAnnotations(
					preview.getContext("2d")!,
					config.annotationRegions,
					config.width,
					config.height,
					time,
				);
				const context = native.getContext("2d")!;
				assets.overlays.forEach((overlay, index) => {
					if (time >= overlay.startMs && time < overlay.endMs)
						context.drawImage(bitmaps[index], overlay.x, overlay.y);
				});
				const actual = context.getImageData(0, 0, config.width, config.height).data;
				const expected = preview
					.getContext("2d")!
					.getImageData(0, 0, config.width, config.height).data;
				expect(actual, `composition at ${time}ms`).toEqual(expected);
			}
		} finally {
			bitmaps.forEach((bitmap) => bitmap.close());
		}
	});

	it("fails visibly for an unreadable image rather than exporting an empty overlay", async () => {
		const config = createConfig(false);
		config.annotationRegions = [
			{
				...caption("broken image", 0, 900, 1),
				type: "image",
				content: "data:image/png;base64,broken",
			},
		];
		await expect(createNativeGpuExportAssets(config)).rejects.toThrow("Failed to load image");
	});
});
