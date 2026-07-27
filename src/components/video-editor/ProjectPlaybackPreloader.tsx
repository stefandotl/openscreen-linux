import { useEffect, useRef } from "react";
import type { EditorScene } from "./sceneModel";

export const PROJECT_MEDIA_PRELOAD_TIMEOUT_MS = 15_000;

interface ProjectPlaybackPreloaderProps {
	scenes: readonly EditorScene[];
	toVideoUrl: (sourcePath: string) => string;
	onDuration: (sceneId: string, sourcePath: string, durationSeconds: number) => void;
	onReady: (sceneId: string, sourcePath: string) => void;
	onError: (sceneId: string, sourcePath: string, message: string) => void;
}

function reportDuration(
	video: HTMLVideoElement,
	sceneId: string,
	sourcePath: string,
	onDuration: ProjectPlaybackPreloaderProps["onDuration"],
) {
	if (Number.isFinite(video.duration) && video.duration > 0) {
		onDuration(sceneId, sourcePath, Math.round(video.duration * 1000) / 1000);
		return true;
	}

	if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
		try {
			video.currentTime = Number.MAX_SAFE_INTEGER;
		} catch {
			// A subsequent durationchange/canplay event may still expose a finite duration.
		}
	}
	return false;
}

interface PreloadedSceneMediaProps {
	scene: EditorScene;
	toVideoUrl: ProjectPlaybackPreloaderProps["toVideoUrl"];
	onDuration: ProjectPlaybackPreloaderProps["onDuration"];
	onReady: ProjectPlaybackPreloaderProps["onReady"];
	onError: ProjectPlaybackPreloaderProps["onError"];
}

function PreloadedSceneMedia({
	scene,
	toVideoUrl,
	onDuration,
	onReady,
	onError,
}: PreloadedSceneMediaProps) {
	const sourcePath = scene.media?.screenVideoPath;
	const webcamSourcePath = scene.media?.webcamVideoPath;
	const screenReadyRef = useRef(false);
	const webcamReadyRef = useRef(!webcamSourcePath);
	const reportedReadyRef = useRef(false);

	useEffect(() => {
		if (!sourcePath) return;
		const timeout = window.setTimeout(() => {
			if (!screenReadyRef.current) {
				onError(scene.id, sourcePath, `Timed out while preloading media for scene "${scene.name}"`);
			} else if (!webcamReadyRef.current) {
				onError(
					scene.id,
					sourcePath,
					`Timed out while preloading webcam media for scene "${scene.name}"`,
				);
			}
		}, PROJECT_MEDIA_PRELOAD_TIMEOUT_MS);
		return () => window.clearTimeout(timeout);
	}, [onError, scene.id, scene.name, sourcePath]);

	if (!sourcePath) return null;

	const reportReady = () => {
		if (screenReadyRef.current && webcamReadyRef.current && !reportedReadyRef.current) {
			reportedReadyRef.current = true;
			onReady(scene.id, sourcePath);
		}
	};

	const resolveScreenDuration = (video: HTMLVideoElement) => {
		screenReadyRef.current = reportDuration(video, scene.id, sourcePath, onDuration);
		reportReady();
	};

	return (
		<span>
			<video
				src={toVideoUrl(sourcePath)}
				preload="auto"
				muted
				playsInline
				onLoadedMetadata={(event) => resolveScreenDuration(event.currentTarget)}
				onDurationChange={(event) => resolveScreenDuration(event.currentTarget)}
				onCanPlay={(event) => resolveScreenDuration(event.currentTarget)}
				onError={() =>
					onError(scene.id, sourcePath, `Failed to preload media for scene "${scene.name}"`)
				}
			/>
			{webcamSourcePath && (
				<video
					src={toVideoUrl(webcamSourcePath)}
					preload="auto"
					muted
					playsInline
					onLoadedMetadata={() => {
						webcamReadyRef.current = true;
						reportReady();
					}}
					onCanPlay={() => {
						webcamReadyRef.current = true;
						reportReady();
					}}
					onError={() =>
						onError(
							scene.id,
							sourcePath,
							`Failed to preload webcam media for scene "${scene.name}"`,
						)
					}
				/>
			)}
		</span>
	);
}

export default function ProjectPlaybackPreloader({
	scenes,
	toVideoUrl,
	onDuration,
	onReady,
	onError,
}: ProjectPlaybackPreloaderProps) {
	return (
		<div className="hidden" aria-hidden="true">
			{scenes.map((scene) => {
				const sourcePath = scene.media?.screenVideoPath;
				if (!sourcePath) return null;

				return (
					<PreloadedSceneMedia
						key={`${scene.id}:${sourcePath}`}
						scene={scene}
						toVideoUrl={toVideoUrl}
						onDuration={onDuration}
						onReady={onReady}
						onError={onError}
					/>
				);
			})}
		</div>
	);
}
