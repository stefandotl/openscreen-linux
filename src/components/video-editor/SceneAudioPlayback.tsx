import { type RefObject, useEffect, useRef } from "react";
import { type AudioRegion, audioGainAt } from "./audioRegions";
import { toFileUrl } from "./projectPersistence";
import type { VideoPlaybackRef } from "./VideoPlayback";

export function SceneAudioPlayback({
	clips,
	videoRef,
	enabled,
	onError,
}: {
	clips: AudioRegion[];
	videoRef: RefObject<VideoPlaybackRef>;
	enabled: boolean;
	onError: (message: string) => void;
}) {
	const clipsRef = useRef(clips);
	clipsRef.current = clips;
	// Gain and trim edits update existing players; only changed media recreates them.
	const sources = JSON.stringify(clips.map(({ id, sourcePath }) => [id, sourcePath]));
	useEffect(() => {
		if (!enabled || sources === "[]") return;
		let disposed = false;
		let failed = false;
		const tracks = clipsRef.current.map((clip) => {
			const audio = new Audio(toFileUrl(clip.sourcePath));
			audio.preload = "auto";
			const fail = (detail: string) => {
				if (disposed || failed) return;
				failed = true;
				videoRef.current?.pause();
				onError(`${clip.name}: ${detail}`);
			};
			audio.onerror = () => fail(audio.error?.message || "Audio could not be loaded");
			return { clip, audio, starting: false, fail };
		});
		let frame = 0;
		const sync = () => {
			const video = videoRef.current?.video;
			for (const track of tracks) {
				const { audio } = track;
				const clip = clipsRef.current.find((item) => item.id === track.clip.id);
				if (!clip) {
					audio.pause();
					continue;
				}
				const timeMs = (video?.currentTime ?? 0) * 1000;
				const active = video && timeMs >= clip.startMs && timeMs < clip.endMs;
				const playing =
					active && !video.paused && !video.seeking && video.readyState >= 2 && !failed;
				if (!playing) audio.pause();
				if (active && audio.readyState >= 1) {
					const target = (clip.sourceStartMs + timeMs - clip.startMs) / 1000;
					if (Math.abs(audio.currentTime - target) > (playing ? 0.08 : 0.001))
						audio.currentTime = target;
					audio.playbackRate = video.playbackRate;
					audio.volume = audioGainAt(clip, timeMs);
				}
				if (playing && audio.paused && !track.starting && audio.readyState >= 2) {
					track.starting = true;
					void audio
						.play()
						.catch((error: Error) => {
							if (error.name !== "AbortError") track.fail(error.message);
						})
						.finally(() => {
							track.starting = false;
						});
				}
			}
			frame = requestAnimationFrame(sync);
		};
		sync();
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			for (const { audio } of tracks) {
				audio.onerror = null;
				audio.pause();
				audio.removeAttribute("src");
				audio.load();
			}
		};
	}, [sources, videoRef, enabled, onError]);
	return null;
}
