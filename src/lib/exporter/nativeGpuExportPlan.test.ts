import { describe, expect, it } from "vitest";
import type { AnnotationRegion } from "@/components/video-editor/types";
import { aiCutSuggestionsToTrims } from "../aiCut";
import { createNativeGpuExportPlan, getNativeGpuExportBlockers } from "./nativeGpuExportPlan";
import type { VideoExporterConfig } from "./videoExporter";

const videoInfo = { width: 1920, height: 1080, duration: 1 };

function createConfig(overrides: Partial<VideoExporterConfig> = {}): VideoExporterConfig {
	return {
		videoUrl: "/tmp/source.mp4",
		width: 1080,
		height: 1920,
		frameRate: 30,
		bitrate: 30_000_000,
		wallpaper: "#111111",
		zoomRegions: [],
		trimRegions: [],
		speedRegions: [],
		showShadow: false,
		shadowIntensity: 0,
		showBlur: false,
		motionBlurAmount: 0,
		borderRadius: 0,
		padding: 14,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		...overrides,
	};
}

function staticTextAnnotation(overrides: Partial<AnnotationRegion> = {}): AnnotationRegion {
	return {
		id: "text",
		startMs: 100,
		endMs: 800,
		type: "text",
		content: "Shortcut",
		position: { x: 20, y: 40 },
		size: { width: 50, height: 10 },
		style: {
			color: "#ffffff",
			backgroundColor: "transparent",
			fontSize: 24,
			fontFamily: "Inter",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
			textAnimation: "none",
		},
		zIndex: 1,
		...overrides,
	};
}

function highlightedCaption(overrides: Partial<AnnotationRegion>): AnnotationRegion {
	const annotation = staticTextAnnotation(overrides);
	return {
		...annotation,
		captionWords: [{ text: annotation.content, startOffsetMs: 0, endOffsetMs: 250 }],
		style: { ...annotation.style, wordHighlight: true, wordHighlightColor: "#34B27B" },
	};
}

function mosaicRegion(overrides: Partial<AnnotationRegion> = {}): AnnotationRegion {
	return {
		...staticTextAnnotation(),
		id: "mosaic",
		type: "blur",
		position: { x: 10, y: 20 },
		size: { width: 30, height: 25 },
		blurData: {
			type: "mosaic",
			shape: "rectangle",
			color: "black",
			intensity: 12,
			blockSize: 16,
		},
		...overrides,
	};
}

describe("native GPU export plan", () => {
	it("creates a deterministic 30 fps plan using the existing timeline and zoom math", () => {
		const config = createConfig({
			zoomRegions: [
				{
					id: "zoom",
					startMs: 100,
					endMs: 900,
					depth: 2,
					focus: { cx: 0.35, cy: 0.55 },
					focusMode: "manual",
				},
			],
			annotationRegions: [staticTextAnnotation()],
		});
		const first = createNativeGpuExportPlan(config, videoInfo);
		const second = createNativeGpuExportPlan(config, videoInfo);

		expect(first.version).toBe(9);
		expect(first.frames).toHaveLength(30);
		expect(first.frames[0].sourceTimestampMs).toBe(0);
		expect(first.frames.at(-1)?.sourceTimestampMs).toBeCloseTo(966.6667, 3);
		expect(first.frames).toEqual(second.frames);
		expect(first.screenRect.width).toBeGreaterThan(1000);
		expect(first.screenRect.height).toBeGreaterThan(560);
		expect(first.overlays).toEqual([
			{
				startMs: 100,
				endMs: 800,
				x: 216,
				y: 768,
				width: 540,
				height: 192,
				zIndex: 1,
			},
		]);
		expect(first.frames.every((frame) => frame.motionBlurX === 0 && frame.motionBlurY === 0)).toBe(
			true,
		);
	});

	it("accepts reviewed AI cuts alongside captions, overlapping annotations and scene boundaries", () => {
		const trimRegions = [
			{ id: "scene-start", startMs: 0, endMs: 1000, source: "scene-split" as const },
			...aiCutSuggestionsToTrims(
				[{ id: "proposal", startMs: 2500, endMs: 3200, text: "um", reason: "Filler" }],
				[],
			),
		];
		const config = createConfig({
			trimRegions,
			annotationRegions: [
				highlightedCaption({ id: "c1", startMs: 1000, endMs: 2000, zIndex: 1 }),
				highlightedCaption({ id: "c2", startMs: 2000, endMs: 3500, zIndex: 2 }),
				highlightedCaption({ id: "c3", startMs: 3500, endMs: 4500, zIndex: 3 }),
				staticTextAnnotation({ id: "overlay1", startMs: 1000, endMs: 4500, zIndex: 4 }),
				staticTextAnnotation({ id: "overlay2", startMs: 2000, endMs: 4000, zIndex: 5 }),
			],
		});
		const info = { ...videoInfo, duration: 5 };
		expect(getNativeGpuExportBlockers(config, info)).toEqual([]);
		const plan = createNativeGpuExportPlan(config, info);
		expect(plan.frames).toHaveLength(99);
		expect(
			plan.frames.every(
				(frame) =>
					frame.sourceTimestampMs >= 1000 &&
					(frame.sourceTimestampMs < 2500 || frame.sourceTimestampMs >= 3200),
			),
		).toBe(true);
	});

	it("accepts silence trims inside scene exclusions and keeps audio-length frame timing", () => {
		const config = createConfig({
			trimRegions: [
				{ id: "scene-start", startMs: 0, endMs: 4000, source: "scene-split" },
				{ id: "silence-before", startMs: 1000, endMs: 2000 },
				{ id: "silence-middle", startMs: 5417, endMs: 5763 },
				{ id: "scene-end", startMs: 8000, endMs: 10000, source: "scene-split" },
			],
		});
		const source = { ...videoInfo, duration: 10 };
		expect(getNativeGpuExportBlockers(config, source)).toEqual([]);
		const plan = createNativeGpuExportPlan(config, source);
		expect(plan.frames).toHaveLength(110);
		for (const [index, frame] of plan.frames.entries()) {
			const sourceMs = frame.sourceTimestampMs;
			expect(sourceMs).toBeGreaterThanOrEqual(4000);
			expect(sourceMs).toBeLessThan(8000);
			const removedMs = sourceMs >= 5763 ? 346 : 0;
			expect(sourceMs - 4000 - removedMs).toBeCloseTo((index * 1000) / 30, 6);
		}
	});

	it("exports webcam framing as a source crop while preserving its layout", () => {
		const webcamInfo = { width: 1920, height: 1080, duration: 1 };
		const base = createConfig({ webcamVideoUrl: "/tmp/webcam.mp4", webcamMaskShape: "circle" });
		const config = { ...base, webcamFraming: { zoom: 2, x: 0, y: 1 } };
		expect(getNativeGpuExportBlockers(config, videoInfo, webcamInfo)).toEqual([]);
		const cropped = createNativeGpuExportPlan(config, videoInfo, webcamInfo);
		const centered = createNativeGpuExportPlan(base, videoInfo, webcamInfo);
		expect(cropped.webcam?.rect).toEqual(centered.webcam?.rect);
		expect(cropped.webcam?.sourceCrop).toEqual({ x: 0, y: 540, width: 540, height: 540 });
		expect(cropped.frames).toEqual(centered.frames);
		expect(
			getNativeGpuExportBlockers(
				{ ...config, webcamFraming: { zoom: NaN, x: 0, y: 0 } },
				videoInfo,
				webcamInfo,
			),
		).toContain("webcam framing is invalid");
	});

	it("accepts and orders sequential and overlapping annotations", () => {
		const annotations = [
			highlightedCaption({ id: "caption-1", startMs: 0, endMs: 300, zIndex: 5 }),
			highlightedCaption({ id: "caption-2", startMs: 300, endMs: 600, zIndex: 5 }),
			highlightedCaption({ id: "caption-3", startMs: 600, endMs: 900, zIndex: 5 }),
			staticTextAnnotation({ id: "overlap-top", startMs: 350, endMs: 550, zIndex: 20 }),
			staticTextAnnotation({ id: "overlap-bottom", startMs: 350, endMs: 550, zIndex: 2 }),
		];
		const config = createConfig({ annotationRegions: annotations });

		expect(getNativeGpuExportBlockers(config, videoInfo)).toEqual([]);
		const plan = createNativeGpuExportPlan(config, videoInfo);
		expect(plan.overlays).toHaveLength(5);
		expect(plan.overlays.map((overlay) => overlay.zIndex)).toEqual([2, 5, 5, 5, 20]);
		expect(plan.overlays.every((overlay) => overlay.width > 0 && overlay.height > 0)).toBe(true);
	});

	it("plans timed soft-blur and mosaic regions for native GPU export", () => {
		const config = createConfig({
			previewWidth: 540,
			previewHeight: 960,
			annotationRegions: [
				mosaicRegion(),
				mosaicRegion({
					id: "oval",
					startMs: 300,
					endMs: 900,
					blurData: {
						type: "mosaic",
						shape: "oval",
						color: "white",
						intensity: 12,
						blockSize: 12,
					},
				}),
				mosaicRegion({
					id: "soft",
					startMs: 400,
					endMs: 1_000,
					blurData: {
						type: "blur",
						shape: "rectangle",
						color: "white",
						intensity: 10,
						blockSize: 12,
					},
				}),
			],
		});

		expect(getNativeGpuExportBlockers(config, videoInfo)).toEqual([]);
		expect(createNativeGpuExportPlan(config, videoInfo).blurRegions).toEqual([
			{
				startMs: 100,
				endMs: 800,
				x: 108,
				y: 384,
				width: 324,
				height: 480,
				type: "mosaic",
				intensity: 24,
				shape: "rectangle",
				blockSize: 32,
				color: "black",
				zIndex: 1,
			},
			{
				startMs: 300,
				endMs: 900,
				x: 108,
				y: 384,
				width: 324,
				height: 480,
				type: "mosaic",
				intensity: 24,
				shape: "oval",
				blockSize: 24,
				color: "white",
				zIndex: 1,
			},
			{
				startMs: 400,
				endMs: 1_000,
				x: 108,
				y: 384,
				width: 324,
				height: 480,
				type: "blur",
				intensity: 20,
				shape: "rectangle",
				blockSize: 24,
				color: "white",
				zIndex: 1,
			},
		]);
	});

	it("keeps unsupported freehand blur regions fail-fast", () => {
		const config = createConfig({
			annotationRegions: [
				mosaicRegion({
					blurData: {
						type: "mosaic",
						shape: "freehand",
						color: "black",
						intensity: 12,
						blockSize: 16,
						freehandPoints: [
							{ x: 0, y: 0 },
							{ x: 100, y: 0 },
							{ x: 50, y: 100 },
						],
					},
				}),
			],
		});

		expect(getNativeGpuExportBlockers(config, videoInfo)).toContain(
			"blur shape freehand is not implemented",
		);
	});

	it("plans directional motion blur only while the camera is moving", () => {
		const plan = createNativeGpuExportPlan(
			createConfig({
				motionBlurAmount: 1,
				zoomRegions: [
					{
						id: "zoom",
						startMs: 100,
						endMs: 900,
						depth: 3,
						focus: { cx: 0.2, cy: 0.7 },
						focusMode: "manual",
					},
				],
			}),
			videoInfo,
		);

		expect(plan.frames[0]).toMatchObject({ motionBlurX: 0, motionBlurY: 0 });
		expect(
			plan.frames.some(
				(frame) => Math.abs(frame.motionBlurX) > 0.5 || Math.abs(frame.motionBlurY) > 0.5,
			),
		).toBe(true);
	});

	it("supports the native GPU plan in landscape orientation", () => {
		const plan = createNativeGpuExportPlan(createConfig({ width: 1920, height: 1080 }), videoInfo);

		expect(plan.width).toBe(1920);
		expect(plan.height).toBe(1080);
		expect(plan.frames).toHaveLength(30);
		expect(plan.screenRect.width).toBeGreaterThan(plan.screenRect.height);
	});

	it("plans a synchronized webcam overlay with editor geometry and reactive zoom", () => {
		const config = createConfig({
			webcamVideoUrl: "/tmp/webcam.webm",
			webcamVideoOffsetMs: 125,
			webcamLayoutPreset: "picture-in-picture",
			webcamMaskShape: "circle",
			webcamMirrored: true,
			webcamRotation: 270,
			webcamReactiveZoom: true,
			webcamSizePreset: 30,
			webcamPosition: { cx: 0.2, cy: 0.8 },
			zoomRegions: [
				{
					id: "zoom",
					startMs: 0,
					endMs: 1_000,
					depth: 2,
					focus: { cx: 0.5, cy: 0.5 },
					focusMode: "manual",
				},
			],
		});
		const webcamInfo = { width: 640, height: 480, duration: 1 };

		expect(getNativeGpuExportBlockers(config, videoInfo)).toEqual([
			"webcam metadata is unavailable",
		]);
		expect(getNativeGpuExportBlockers(config, videoInfo, webcamInfo)).toEqual([]);

		const plan = createNativeGpuExportPlan(config, videoInfo, webcamInfo);
		expect(plan.webcam).toMatchObject({
			inputPath: "/tmp/webcam.webm",
			sourceWidth: 640,
			sourceHeight: 480,
			durationMs: 1000,
			videoOffsetMs: 125,
			maskShape: "circle",
			mirrored: true,
			rotation: 270,
			anchorRight: false,
			anchorBottom: true,
		});
		expect(plan.webcam?.rect.width).toBe(plan.webcam?.rect.height);
		expect(plan.webcam?.shadow).not.toBeNull();
		expect(plan.frames.some((frame) => frame.webcamScale < 1)).toBe(true);
	});

	it("rejects a non-finite webcam video offset", () => {
		const config = createConfig({
			webcamVideoUrl: "/tmp/webcam.webm",
			webcamVideoOffsetMs: Number.NaN,
			webcamLayoutPreset: "picture-in-picture",
		});

		expect(
			getNativeGpuExportBlockers(config, videoInfo, {
				width: 640,
				height: 480,
				duration: 1,
			}),
		).toContain("webcam video offset is invalid");
	});

	it("supports cover-mode webcam layouts in the native plan", () => {
		const plan = createNativeGpuExportPlan(
			createConfig({
				webcamVideoUrl: "/tmp/webcam.webm",
				webcamLayoutPreset: "vertical-stack",
			}),
			videoInfo,
			{ width: 640, height: 480, duration: 1 },
		);

		expect(plan.screenCover).toBe(true);
		expect(plan.webcam?.rect.y).toBe(plan.screenRect.height);
		expect(plan.frames.every((frame) => frame.webcamScale === 1)).toBe(true);
	});

	it("plans a full-canvas webcam-only export and ignores hidden screen-only effects", () => {
		const config = createConfig({
			webcamVideoUrl: "/tmp/webcam.webm",
			webcamLayoutPreset: "only-webcam",
			webcamMaskShape: "circle",
			webcamSizePreset: 10,
			padding: 100,
			cropRegion: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
			showShadow: true,
			shadowIntensity: 1,
			borderRadius: 64,
		});
		const webcamInfo = { width: 640, height: 480, duration: 1 };

		expect(getNativeGpuExportBlockers(config, videoInfo, webcamInfo)).toEqual([]);
		const plan = createNativeGpuExportPlan(config, videoInfo, webcamInfo);
		expect(plan.webcam).toMatchObject({
			rect: { x: 0, y: 0, width: 1080, height: 1920 },
			borderRadius: 0,
			maskShape: "rectangle",
			shadow: null,
		});
		expect(plan.frames.every((frame) => frame.webcamScale === 1)).toBe(true);
	});

	it("rejects webcam-only export when the scene has no webcam recording", () => {
		const config = createConfig({ webcamLayoutPreset: "only-webcam" });

		expect(getNativeGpuExportBlockers(config, videoInfo)).toContain(
			"Webcam-only layout requires a webcam recording",
		);
	});

	it("supports blur effects and still fails loudly for unimplemented effects", () => {
		const blockers = getNativeGpuExportBlockers(
			createConfig({
				borderRadius: 12,
				showBlur: true,
				motionBlurAmount: 0.8,
				zoomRegions: [
					{
						id: "auto",
						startMs: 0,
						endMs: 900,
						depth: 2,
						focus: { cx: 0.5, cy: 0.5 },
						focusMode: "auto",
					},
				],
			}),
			videoInfo,
		);

		expect(blockers).not.toContain("background blur is not implemented");
		expect(blockers).not.toContain("motion blur is not implemented");
		expect(blockers).toContain("recording roundness is not implemented");
		expect(blockers).toContain("automatic cursor-follow zoom is not implemented");
	});

	it("rejects output dimensions that NV12 or the native helper cannot accept", () => {
		const blockers = getNativeGpuExportBlockers(
			createConfig({ width: 1919, height: 5000 }),
			videoInfo,
		);

		expect(blockers).toEqual([
			"output dimensions must be positive, even, and at most 4096px per side; got 1919x5000",
		]);
	});
});
