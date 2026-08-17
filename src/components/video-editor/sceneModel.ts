import type { EditorState } from "@/hooks/useEditorHistory";
import type { ProjectMedia } from "@/lib/recordingSession";
import type { TrimRegion } from "./types";

export interface EditorScene {
	id: string;
	name: string;
	media: ProjectMedia | null;
	editor: EditorState;
}

export const MAX_SCENE_NAME_LENGTH = 80;
export const MIN_SPLIT_SCENE_DURATION_MS = 100;

export function createSceneId() {
	return `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createSceneName(existingScenes: readonly Pick<EditorScene, "name">[]) {
	const existingNames = new Set(
		existingScenes.map((scene) => scene.name.trim().toLocaleLowerCase()),
	);
	let sceneNumber = 1;
	while (existingNames.has(`scene ${sceneNumber}`)) {
		sceneNumber += 1;
	}
	return `Scene ${sceneNumber}`;
}

export function normalizeSceneName(value: string) {
	const trimmedName = value.trim();
	return trimmedName ? trimmedName.slice(0, MAX_SCENE_NAME_LENGTH) : null;
}

export function shouldPersistScenes(scenes: readonly Pick<EditorScene, "name">[]) {
	return scenes.length > 1 || (scenes.length === 1 && scenes[0].name !== "Scene 1");
}

export function createScenePlaybackKey(
	sceneId: string | null,
	videoPath: string,
	webcamVideoPath: string | null,
) {
	return JSON.stringify([sceneId, videoPath, webcamVideoPath]);
}

export function reorderScenes<T extends { id: string }>(
	scenes: T[],
	sceneId: string,
	targetIndex: number,
): T[] {
	const sourceIndex = scenes.findIndex((scene) => scene.id === sceneId);
	if (sourceIndex < 0) return scenes;

	const boundedTargetIndex = Math.max(0, Math.min(targetIndex, scenes.length));
	const insertionIndex =
		sourceIndex < boundedTargetIndex ? boundedTargetIndex - 1 : boundedTargetIndex;
	if (sourceIndex === insertionIndex) return scenes;

	const reordered = [...scenes];
	const [scene] = reordered.splice(sourceIndex, 1);
	reordered.splice(insertionIndex, 0, scene);
	return reordered;
}

function normalizeTrimRegions(
	regions: readonly TrimRegion[],
	durationMs: number,
	idPrefix: string,
): TrimRegion[] {
	const sorted = regions
		.map((region) => ({
			startMs: Math.max(0, Math.min(durationMs, Math.round(region.startMs))),
			endMs: Math.max(0, Math.min(durationMs, Math.round(region.endMs))),
			source: region.source,
		}))
		.filter((region) => region.endMs > region.startMs)
		.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	const merged: Array<{ startMs: number; endMs: number; source?: "scene-split" }> = [];

	for (const region of sorted) {
		const previous = merged.at(-1);
		if (previous && region.startMs < previous.endMs) {
			previous.endMs = Math.max(previous.endMs, region.endMs);
			if (region.source === "scene-split") previous.source = "scene-split";
			continue;
		}
		merged.push({ ...region });
	}

	return merged.map((region, index) => ({
		id: `${idPrefix}-${index + 1}`,
		startMs: region.startMs,
		endMs: region.endMs,
		...(region.source === "scene-split" ? { source: "scene-split" as const } : {}),
	}));
}

function getPlayableDurationMs(startMs: number, endMs: number, trimRegions: readonly TrimRegion[]) {
	let removedMs = 0;
	for (const region of normalizeTrimRegions(trimRegions, endMs, "playable")) {
		removedMs += Math.max(0, Math.min(endMs, region.endMs) - Math.max(startMs, region.startMs));
	}
	return Math.max(0, endMs - startMs - removedMs);
}

export function canSplitSceneAtSourceTime(
	editor: Pick<EditorState, "trimRegions">,
	splitTimeMs: number,
	durationMs: number,
) {
	const roundedDurationMs = Math.max(0, Math.round(durationMs));
	const roundedSplitTimeMs = Math.round(splitTimeMs);
	if (
		!Number.isFinite(splitTimeMs) ||
		!Number.isFinite(durationMs) ||
		roundedSplitTimeMs <= 0 ||
		roundedSplitTimeMs >= roundedDurationMs
	) {
		return false;
	}

	const splitInsideTrim = editor.trimRegions.some(
		(region) => roundedSplitTimeMs > region.startMs && roundedSplitTimeMs < region.endMs,
	);
	if (splitInsideTrim) return false;

	return (
		getPlayableDurationMs(0, roundedSplitTimeMs, editor.trimRegions) >=
			MIN_SPLIT_SCENE_DURATION_MS &&
		getPlayableDurationMs(roundedSplitTimeMs, roundedDurationMs, editor.trimRegions) >=
			MIN_SPLIT_SCENE_DURATION_MS
	);
}

function keepRegionsOverlappingRange<T extends { startMs: number; endMs: number }>(
	regions: readonly T[],
	startMs: number,
	endMs: number,
) {
	return regions.filter((region) => region.startMs < endMs && region.endMs > startMs);
}

function editorForSplitRange(
	editor: EditorState,
	startMs: number,
	endMs: number,
	durationMs: number,
	trimIdPrefix: string,
): EditorState {
	const copy = structuredClone(editor);
	const outsideRangeTrims: TrimRegion[] = [];
	if (startMs > 0) {
		outsideRangeTrims.push({
			id: `${trimIdPrefix}-before`,
			startMs: 0,
			endMs: startMs,
			source: "scene-split",
		});
	}
	if (endMs < durationMs) {
		outsideRangeTrims.push({
			id: `${trimIdPrefix}-after`,
			startMs: endMs,
			endMs: durationMs,
			source: "scene-split",
		});
	}

	return {
		...copy,
		zoomRegions: keepRegionsOverlappingRange(copy.zoomRegions, startMs, endMs),
		trimRegions: normalizeTrimRegions(
			[...copy.trimRegions, ...outsideRangeTrims],
			durationMs,
			trimIdPrefix,
		),
		speedRegions: keepRegionsOverlappingRange(copy.speedRegions, startMs, endMs),
		annotationRegions: keepRegionsOverlappingRange(copy.annotationRegions, startMs, endMs),
	};
}

export interface SplitSceneOptions {
	scene: EditorScene;
	splitTimeMs: number;
	durationMs: number;
	secondSceneId: string;
	secondSceneName: string;
}

export interface SplitSceneResult {
	firstScene: EditorScene;
	secondScene: EditorScene;
}

export function splitSceneAtSourceTime({
	scene,
	splitTimeMs,
	durationMs,
	secondSceneId,
	secondSceneName,
}: SplitSceneOptions): SplitSceneResult | null {
	if (!canSplitSceneAtSourceTime(scene.editor, splitTimeMs, durationMs)) return null;

	const roundedDurationMs = Math.round(durationMs);
	const roundedSplitTimeMs = Math.round(splitTimeMs);
	return {
		firstScene: {
			...scene,
			editor: editorForSplitRange(
				scene.editor,
				0,
				roundedSplitTimeMs,
				roundedDurationMs,
				`trim-split-${scene.id}`,
			),
		},
		secondScene: {
			...scene,
			id: secondSceneId,
			name: secondSceneName,
			editor: editorForSplitRange(
				scene.editor,
				roundedSplitTimeMs,
				roundedDurationMs,
				roundedDurationMs,
				`trim-split-${secondSceneId}`,
			),
		},
	};
}
