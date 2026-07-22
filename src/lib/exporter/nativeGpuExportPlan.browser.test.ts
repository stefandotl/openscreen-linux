import { describe, expect, it } from "vitest";
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

describe("native GPU export assets", () => {
	it("bakes background blur into the static wallpaper asset", async () => {
		const sharp = await createNativeGpuExportAssets(createConfig(false));
		const blurred = await createNativeGpuExportAssets(createConfig(true));

		expect(sharp.wallpaperPng.byteLength).toBeGreaterThan(100);
		expect(blurred.wallpaperPng.byteLength).toBeGreaterThan(100);
		expect(new Uint8Array(blurred.wallpaperPng)).not.toEqual(new Uint8Array(sharp.wallpaperPng));
	});
});
