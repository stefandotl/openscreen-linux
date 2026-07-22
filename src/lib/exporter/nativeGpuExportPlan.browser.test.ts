import { describe, expect, it } from "vitest";
import type { AnnotationRegion } from "@/components/video-editor/types";
import { createNativeGpuExportAssets } from "./nativeGpuExportPlan";
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
});
