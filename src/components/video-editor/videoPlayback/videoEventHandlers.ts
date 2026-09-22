import type React from "react";
import { resolvePreviewPlaybackRate } from "../previewSpeed";
import type { SpeedRegion, TrimRegion } from "../types";

// Keep "scrub mode" on for a brief tail after `seeked`: rapid drag-scrubbing fires
// `seeking`/`seeked` dozens of times a second and toggling effects each time would flicker.
const SCRUB_END_DEBOUNCE_MS = 150;
const PLAYBACK_UI_UPDATE_INTERVAL_MS = 1000 / 30;

/** `play()` interrupted by a deliberate pause/load is a superseded request, not a failure. */
function isAbortError(error: unknown) {
	return (
		typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
	);
}

interface VideoEventHandlersParams {
	video: HTMLVideoElement;
	isSeekingRef: React.MutableRefObject<boolean>;
	isPlayingRef: React.MutableRefObject<boolean>;
	allowPlaybackRef: React.MutableRefObject<boolean>;
	currentTimeRef: React.MutableRefObject<number>;
	timeUpdateAnimationRef: React.MutableRefObject<number | null>;
	onPlayStateChange: (playing: boolean) => void;
	onTimeUpdate: (time: number) => void;
	onTerminalTrim?: () => boolean | void;
	onPlaybackError?: (message: string) => void;
	trimRegionsRef: React.MutableRefObject<TrimRegion[]>;
	speedRegionsRef: React.MutableRefObject<SpeedRegion[]>;
	previewSpeedRef: React.MutableRefObject<number>;
	isScrubbingRef?: React.MutableRefObject<boolean>;
	scrubEndTimerRef?: React.MutableRefObject<number | null>;
	onScrubChange?: (scrubbing: boolean) => void;
}

export function createVideoEventHandlers(params: VideoEventHandlersParams) {
	const {
		video,
		isSeekingRef,
		isPlayingRef,
		allowPlaybackRef,
		currentTimeRef,
		timeUpdateAnimationRef,
		onPlayStateChange,
		onTimeUpdate,
		onTerminalTrim,
		onPlaybackError,
		trimRegionsRef,
		speedRegionsRef,
		previewSpeedRef,
		isScrubbingRef,
		scrubEndTimerRef,
		onScrubChange,
	} = params;
	let pendingTrimSkipEndSeconds: number | null = null;
	let continuingPastTerminalTrim = false;
	let lastPlaybackUiUpdateMs = Number.NEGATIVE_INFINITY;

	const clearScrubEndTimer = () => {
		if (scrubEndTimerRef && scrubEndTimerRef.current !== null) {
			window.clearTimeout(scrubEndTimerRef.current);
			scrubEndTimerRef.current = null;
		}
	};

	const emitTime = (timeValue: number, frameTimestampMs?: number) => {
		currentTimeRef.current = timeValue * 1000;
		if (
			frameTimestampMs !== undefined &&
			frameTimestampMs - lastPlaybackUiUpdateMs < PLAYBACK_UI_UPDATE_INTERVAL_MS
		) {
			return;
		}
		if (frameTimestampMs !== undefined) {
			lastPlaybackUiUpdateMs = frameTimestampMs;
		}
		onTimeUpdate(timeValue);
	};

	const resolveTrimSkipEndSeconds = (currentTimeMs: number): number | null => {
		const trimRegions = trimRegionsRef.current;
		let skipEndMs: number | null = null;

		for (const region of trimRegions) {
			if (currentTimeMs >= region.startMs && currentTimeMs < region.endMs) {
				skipEndMs = Math.max(skipEndMs ?? region.endMs, region.endMs);
			}
		}

		if (skipEndMs === null) {
			return null;
		}

		// Collapse touching and overlapping trims into one seek. Multiple immediate
		// media seeks can leave Chromium's audio decoder stalled while video continues.
		let extended = true;
		while (extended) {
			extended = false;
			for (const region of trimRegions) {
				if (region.startMs <= skipEndMs && region.endMs > skipEndMs) {
					skipEndMs = region.endMs;
					extended = true;
				}
			}
		}

		return skipEndMs / 1000;
	};

	const findActiveSpeedRegion = (currentTimeMs: number): SpeedRegion | null => {
		return (
			speedRegionsRef.current.find(
				(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
			) || null
		);
	};

	const seekPastTrim = (skipToTime: number) => {
		pendingTrimSkipEndSeconds =
			allowPlaybackRef.current && isPlayingRef.current ? skipToTime : null;
		// Seeking a playing MediaRecorder WebM can leave Chromium's audio decoder on
		// the pre-cut timestamp after several nearby trims. Pause the media clock first;
		// handleSeeked resumes the same playback intent once audio and video have both
		// landed on the cut boundary.
		if (!video.paused) {
			video.pause();
		}
		video.currentTime = skipToTime;
		emitTime(skipToTime);
	};

	const resumeAfterTrimSeek = () => {
		if (pendingTrimSkipEndSeconds === null) {
			return;
		}

		pendingTrimSkipEndSeconds = null;
		if (!allowPlaybackRef.current || !video.paused) {
			return;
		}

		void video.play().catch((error) => {
			// A scene handoff or a newer trim seek may deliberately pause/load this
			// element while Chromium is still resolving play(). That AbortError is a
			// superseded request, not a playback failure for the project.
			if (isAbortError(error)) {
				return;
			}
			allowPlaybackRef.current = false;
			isPlayingRef.current = false;
			onPlayStateChange(false);
			const detail = error instanceof Error ? error.message : String(error);
			onPlaybackError?.(`Video playback failed after skipping a trim: ${detail}`);
		});
	};

	function updateTime(frameTimestampMs: number, scheduleNextFrame = true) {
		if (!video) return;

		const currentTimeMs = video.currentTime * 1000;
		const trimSkipEndSeconds = resolveTrimSkipEndSeconds(currentTimeMs);

		// In a trim region during playback: skip to its end
		if (trimSkipEndSeconds !== null && !video.paused && !video.ended) {
			// Pause if the skip would run past the end
			if (trimSkipEndSeconds >= video.duration) {
				if (continuingPastTerminalTrim || onTerminalTrim?.() === true) {
					continuingPastTerminalTrim = true;
					emitTime(video.currentTime);
				} else {
					video.pause();
				}
			} else {
				seekPastTrim(trimSkipEndSeconds);
			}
		} else {
			continuingPastTerminalTrim = false;
			const activeSpeedRegion = findActiveSpeedRegion(currentTimeMs);
			video.playbackRate = resolvePreviewPlaybackRate(
				activeSpeedRegion?.speed ?? null,
				previewSpeedRef.current,
			);
			emitTime(video.currentTime, frameTimestampMs);
		}

		if (scheduleNextFrame && !video.paused && !video.ended) {
			timeUpdateAnimationRef.current = requestAnimationFrame(updateTime);
		}
	}

	const handleTimeUpdate = () => {
		// Keep trim boundaries reliable even if rendering load delays requestAnimationFrame
		// until the media element is already close to its native end.
		updateTime(performance.now(), false);
	};

	const startTimeUpdates = () => {
		if (timeUpdateAnimationRef.current) {
			cancelAnimationFrame(timeUpdateAnimationRef.current);
		}
		timeUpdateAnimationRef.current = requestAnimationFrame(updateTime);
	};

	const handlePlay = () => {
		if (!allowPlaybackRef.current) {
			video.pause();
			return;
		}

		isPlayingRef.current = true;
		onPlayStateChange(true);
		if (isSeekingRef.current) {
			return;
		}
		startTimeUpdates();
	};

	const handlePause = () => {
		// Chromium can deliver a queued pause event from the previous source after a
		// retained media element has already started the next source. Treat the
		// element's current state as authoritative so that stale event cannot turn a
		// following seek into a real pause.
		if (!video.paused && !video.ended) {
			return;
		}
		if (pendingTrimSkipEndSeconds !== null && allowPlaybackRef.current) {
			emitTime(video.currentTime);
			return;
		}
		if (isSeekingRef.current && allowPlaybackRef.current && isPlayingRef.current) {
			if (timeUpdateAnimationRef.current) {
				cancelAnimationFrame(timeUpdateAnimationRef.current);
				timeUpdateAnimationRef.current = null;
			}
			emitTime(video.currentTime);
			return;
		}
		pendingTrimSkipEndSeconds = null;
		continuingPastTerminalTrim = false;

		isPlayingRef.current = false;
		onPlayStateChange(false);
		if (timeUpdateAnimationRef.current) {
			cancelAnimationFrame(timeUpdateAnimationRef.current);
			timeUpdateAnimationRef.current = null;
		}
		emitTime(video.currentTime);
	};

	const handleSeeked = () => {
		isSeekingRef.current = false;
		let issuedFollowupSeek = false;
		const isAutomaticTrimSeek = pendingTrimSkipEndSeconds !== null;

		if (!isAutomaticTrimSeek && isScrubbingRef && scrubEndTimerRef) {
			clearScrubEndTimer();
			scrubEndTimerRef.current = window.setTimeout(() => {
				isScrubbingRef.current = false;
				scrubEndTimerRef.current = null;
				onScrubChange?.(false);
			}, SCRUB_END_DEBOUNCE_MS);
		}

		const currentTimeMs = video.currentTime * 1000;
		const completedTrimSkip =
			pendingTrimSkipEndSeconds !== null && video.currentTime >= pendingTrimSkipEndSeconds - 0.05;
		const trimSkipEndSeconds = completedTrimSkip ? null : resolveTrimSkipEndSeconds(currentTimeMs);

		// Seeked into a trim region while playing: skip to the end
		if (trimSkipEndSeconds !== null && isPlayingRef.current && !video.paused) {
			if (trimSkipEndSeconds >= video.duration) {
				if (onTerminalTrim?.() === true) {
					continuingPastTerminalTrim = true;
					emitTime(video.currentTime);
				} else {
					video.pause();
				}
			} else {
				seekPastTrim(trimSkipEndSeconds);
				issuedFollowupSeek = true;
			}
		} else {
			// A seek promise can resolve before Chromium dispatches the matching seeked
			// listener. If play was requested in that microtask, allowPlayback is already
			// true even though the later play event has not set isPlaying yet.
			if (!isPlayingRef.current && !allowPlaybackRef.current && !video.paused) {
				video.pause();
			}
			emitTime(video.currentTime);
			if (completedTrimSkip) {
				resumeAfterTrimSeek();
			} else if (allowPlaybackRef.current && isPlayingRef.current && video.paused) {
				void video.play().catch((error) => {
					// A scene handoff can pause or reload this element while a user seek is still
					// resolving play(). That superseded request must not surface as a project error.
					if (isAbortError(error)) {
						return;
					}
					allowPlaybackRef.current = false;
					isPlayingRef.current = false;
					onPlayStateChange(false);
					const detail = error instanceof Error ? error.message : String(error);
					onPlaybackError?.(`Video playback failed after seeking: ${detail}`);
				});
			}
		}

		if (!issuedFollowupSeek && isPlayingRef.current && !video.paused) {
			startTimeUpdates();
		}
	};

	const handleSeeking = () => {
		isSeekingRef.current = true;

		if (isScrubbingRef && pendingTrimSkipEndSeconds === null) {
			clearScrubEndTimer();
			if (!isScrubbingRef.current) {
				isScrubbingRef.current = true;
				onScrubChange?.(true);
			}
		}

		if (!isPlayingRef.current && !allowPlaybackRef.current && !video.paused) {
			video.pause();
		}
		emitTime(video.currentTime);
	};

	return {
		handlePlay,
		handlePause,
		handleTimeUpdate,
		handleSeeked,
		handleSeeking,
	};
}
