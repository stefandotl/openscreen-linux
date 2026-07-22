import { describe, expect, it } from "vitest";
import type { AnnotationRegion } from "@/components/video-editor/types";
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
