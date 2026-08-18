import type React from "react";
import type { SpeedRegion, TrimRegion } from "../types";

// Keep "scrub mode" on for a brief tail after `seeked`: rapid drag-scrubbing fires
// `seeking`/`seeked` dozens of times a second and toggling effects each time would flicker.
const SCRUB_END_DEBOUNCE_MS = 150;

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
		isScrubbingRef,
		scrubEndTimerRef,
		onScrubChange,
	} = params;
	let pendingTrimSkipEndSeconds: number | null = null;
	let continuingPastTerminalTrim = false;

	const clearScrubEndTimer = () => {
		if (scrubEndTimerRef && scrubEndTimerRef.current !== null) {
			window.clearTimeout(scrubEndTimerRef.current);
			scrubEndTimerRef.current = null;
		}
	};

	const emitTime = (timeValue: number) => {
		currentTimeRef.current = timeValue * 1000;
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
			allowPlaybackRef.current = false;
			isPlayingRef.current = false;
			onPlayStateChange(false);
			const detail = error instanceof Error ? error.message : String(error);
			onPlaybackError?.(`Video playback failed after skipping a trim: ${detail}`);
		});
	};

	function updateTime() {
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
			video.playbackRate = activeSpeedRegion ? activeSpeedRegion.speed : 1;
			emitTime(video.currentTime);
		}

		if (!video.paused && !video.ended) {
			timeUpdateAnimationRef.current = requestAnimationFrame(updateTime);
		}
	}

	const handlePlay = () => {
		if (isSeekingRef.current) {
			video.pause();
			return;
		}

		if (!allowPlaybackRef.current) {
			video.pause();
			return;
		}

		isPlayingRef.current = true;
		onPlayStateChange(true);
		if (timeUpdateAnimationRef.current) {
			cancelAnimationFrame(timeUpdateAnimationRef.current);
		}
		timeUpdateAnimationRef.current = requestAnimationFrame(updateTime);
	};

	const handlePause = () => {
		if (pendingTrimSkipEndSeconds !== null && allowPlaybackRef.current) {
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

		if (isScrubbingRef && scrubEndTimerRef) {
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
			}
		} else {
			if (!isPlayingRef.current && !video.paused) {
				video.pause();
			}
			emitTime(video.currentTime);
			if (completedTrimSkip) {
				resumeAfterTrimSeek();
			}
		}
	};

	const handleSeeking = () => {
		isSeekingRef.current = true;

		if (isScrubbingRef) {
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
		handleSeeked,
		handleSeeking,
	};
}
