import { buildExportTimelineSegments } from "@/lib/exporter/exportTimeline";
import type { SpeedRegion, TrimRegion } from "./types";

export type ProjectPlaybackControllerState =
	| "scene"
	| "playing"
	| "switching"
	| "paused"
	| "completed";

export function hasProjectPlaybackIntent(
	state: ProjectPlaybackControllerState,
	pendingShouldPlay: boolean | undefined,
) {
	return state === "playing" || (state === "switching" && pendingShouldPlay === true);
}

export interface ProjectPlaybackSourceSegment {
	sourceStartSeconds: number;
	sourceEndSeconds: number;
	speed: number;
	projectStartSeconds: number;
	projectEndSeconds: number;
}

export interface ProjectPlaybackSegment {
	sceneId: string;
	name: string;
	projectStartSeconds: number;
	projectEndSeconds: number;
	sourceStartSeconds: number;
	sourceEndSeconds: number;
	sourceSegments: ProjectPlaybackSourceSegment[];
}

export interface ProjectPlaybackScene {
	id: string;
	name: string;
	sourceDurationSeconds: number;
	trimRegions: TrimRegion[];
	speedRegions: SpeedRegion[];
}

export interface ProjectPlaybackPosition {
	sceneId: string;
	sourceTimeSeconds: number;
	projectTimeSeconds: number;
}

export function getEffectiveSceneDuration(
	sourceDurationSeconds: number,
	trimRegions: TrimRegion[] = [],
	speedRegions: SpeedRegion[] = [],
) {
	if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
		return 0;
	}

	return buildExportTimelineSegments(sourceDurationSeconds, trimRegions, speedRegions).reduce(
		(duration, segment) => duration + (segment.endSec - segment.startSec) / segment.speed,
		0,
	);
}

export function buildProjectPlaybackPlan(
	scenes: readonly ProjectPlaybackScene[],
): ProjectPlaybackSegment[] {
	let projectCursor = 0;
	const plan: ProjectPlaybackSegment[] = [];

	for (const scene of scenes) {
		const timeline = buildExportTimelineSegments(
			scene.sourceDurationSeconds,
			scene.trimRegions,
			scene.speedRegions,
		);
		if (timeline.length === 0) continue;

		const projectStartSeconds = projectCursor;
		const sourceSegments = timeline.map<ProjectPlaybackSourceSegment>((sourceSegment) => {
			const projectStartSeconds = projectCursor;
			projectCursor += (sourceSegment.endSec - sourceSegment.startSec) / sourceSegment.speed;
			return {
				sourceStartSeconds: sourceSegment.startSec,
				sourceEndSeconds: sourceSegment.endSec,
				speed: sourceSegment.speed,
				projectStartSeconds,
				projectEndSeconds: projectCursor,
			};
		});

		plan.push({
			sceneId: scene.id,
			name: scene.name,
			projectStartSeconds,
			projectEndSeconds: projectCursor,
			sourceStartSeconds: sourceSegments[0].sourceStartSeconds,
			sourceEndSeconds: sourceSegments[sourceSegments.length - 1].sourceEndSeconds,
			sourceSegments,
		});
	}

	return plan;
}

export function getProjectPlaybackDuration(plan: readonly ProjectPlaybackSegment[]) {
	return plan.at(-1)?.projectEndSeconds ?? 0;
}

export function projectTimeToSceneSource(
	plan: readonly ProjectPlaybackSegment[],
	projectTimeSeconds: number,
): ProjectPlaybackPosition | null {
	if (plan.length === 0) return null;

	const duration = getProjectPlaybackDuration(plan);
	const clampedProjectTime = Math.max(0, Math.min(projectTimeSeconds, duration));
	const sceneSegment =
		plan.find((segment) => clampedProjectTime < segment.projectEndSeconds) ?? plan.at(-1);
	if (!sceneSegment) return null;

	const sourceSegment =
		sceneSegment.sourceSegments.find((segment) => clampedProjectTime < segment.projectEndSeconds) ??
		sceneSegment.sourceSegments.at(-1);
	if (!sourceSegment) return null;

	const sourceTimeSeconds =
		clampedProjectTime >= duration
			? sourceSegment.sourceEndSeconds
			: sourceSegment.sourceStartSeconds +
				(clampedProjectTime - sourceSegment.projectStartSeconds) * sourceSegment.speed;

	return {
		sceneId: sceneSegment.sceneId,
		sourceTimeSeconds: Math.min(sourceTimeSeconds, sourceSegment.sourceEndSeconds),
		projectTimeSeconds: clampedProjectTime,
	};
}

export function sceneSourceTimeToProjectTime(
	plan: readonly ProjectPlaybackSegment[],
	sceneId: string,
	sourceTimeSeconds: number,
): number | null {
	const sceneSegment = plan.find((segment) => segment.sceneId === sceneId);
	if (!sceneSegment) return null;

	const clampedSourceTime = Math.max(
		sceneSegment.sourceStartSeconds,
		Math.min(sourceTimeSeconds, sceneSegment.sourceEndSeconds),
	);
	const sourceSegment = sceneSegment.sourceSegments.find(
		(segment) =>
			clampedSourceTime >= segment.sourceStartSeconds &&
			clampedSourceTime < segment.sourceEndSeconds,
	);
	if (sourceSegment) {
		return (
			sourceSegment.projectStartSeconds +
			(clampedSourceTime - sourceSegment.sourceStartSeconds) / sourceSegment.speed
		);
	}

	const nextSourceSegment = sceneSegment.sourceSegments.find(
		(segment) => segment.sourceStartSeconds > clampedSourceTime,
	);
	return nextSourceSegment?.projectStartSeconds ?? sceneSegment.projectEndSeconds;
}

export function getNextProjectPlaybackSegment(
	plan: readonly ProjectPlaybackSegment[],
	sceneId: string,
) {
	const sceneIndex = plan.findIndex((segment) => segment.sceneId === sceneId);
	return sceneIndex >= 0 ? (plan[sceneIndex + 1] ?? null) : null;
}
