const SOFT_SYNC_THRESHOLD_SECONDS = 0.015;
const HARD_SYNC_THRESHOLD_SECONDS = 0.075;
const MAX_PLAYBACK_RATE_CORRECTION = 0.05;

type MediaClock = Pick<HTMLMediaElement, "currentTime" | "duration" | "playbackRate"> & {
	seeking?: boolean;
};
type PlaybackMediaFollower = MediaClock &
	Pick<HTMLMediaElement, "paused" | "ended" | "pause" | "play">;

export type OffsetMediaBoundary = "start" | "end" | null;
export type MediaSyncResult = "aligned" | "rate-adjusted" | "seeked" | "seeking" | "unavailable";
export type MediaPlaybackSyncResult = MediaSyncResult | "held";

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

export function getOffsetMediaPosition(
	masterTimeSeconds: number,
	offsetMs: number,
	followerDurationSeconds: number,
): { timeSeconds: number; boundary: OffsetMediaBoundary } {
	const requestedTime = masterTimeSeconds + offsetMs / 1000;
	const lastPlayableTime = Number.isFinite(followerDurationSeconds)
		? Math.max(0, followerDurationSeconds - 0.001)
		: Number.POSITIVE_INFINITY;
	const boundary =
		requestedTime < 0
			? "start"
			: Number.isFinite(lastPlayableTime) && requestedTime > lastPlayableTime
				? "end"
				: null;
	return {
		timeSeconds: clamp(requestedTime, 0, lastPlayableTime),
		boundary,
	};
}

export function getOffsetMediaTime(
	masterTimeSeconds: number,
	offsetMs: number,
	followerDurationSeconds: number,
) {
	return getOffsetMediaPosition(masterTimeSeconds, offsetMs, followerDurationSeconds).timeSeconds;
}

/**
 * Keeps a muted sidecar on the primary media clock. Small differences are corrected
 * smoothly through playbackRate; larger differences seek immediately so fullscreen
 * rendering load cannot leave the camera visibly behind the audio.
 */
export function synchronizeMediaFollower(
	master: MediaClock,
	follower: MediaClock,
	offsetMs: number,
): MediaSyncResult {
	if (
		!Number.isFinite(master.currentTime) ||
		!Number.isFinite(follower.currentTime) ||
		!Number.isFinite(offsetMs)
	) {
		return "unavailable";
	}

	const targetTime = getOffsetMediaTime(master.currentTime, offsetMs, follower.duration);
	const driftSeconds = targetTime - follower.currentTime;
	const masterPlaybackRate =
		Number.isFinite(master.playbackRate) && master.playbackRate > 0 ? master.playbackRate : 1;
	if (follower.seeking) {
		if (follower.playbackRate !== masterPlaybackRate) {
			follower.playbackRate = masterPlaybackRate;
		}
		return "seeking";
	}

	if (Math.abs(driftSeconds) >= HARD_SYNC_THRESHOLD_SECONDS) {
		follower.currentTime = targetTime;
		if (follower.playbackRate !== masterPlaybackRate) {
			follower.playbackRate = masterPlaybackRate;
		}
		return "seeked";
	}

	const correction =
		Math.abs(driftSeconds) > SOFT_SYNC_THRESHOLD_SECONDS
			? clamp(driftSeconds, -MAX_PLAYBACK_RATE_CORRECTION, MAX_PLAYBACK_RATE_CORRECTION)
			: 0;
	const desiredPlaybackRate = masterPlaybackRate * (1 + correction);
	if (Math.abs(follower.playbackRate - desiredPlaybackRate) > 0.001) {
		follower.playbackRate = desiredPlaybackRate;
	}

	return correction === 0 ? "aligned" : "rate-adjusted";
}

/**
 * Preserves playback intent while synchronizing a muted sidecar. During rapid
 * scrubbing and clamped offset boundaries the current frame is held; offset
 * changes during normal playback never pause the follower.
 */
export function synchronizeMediaFollowerPlayback(
	master: MediaClock,
	follower: PlaybackMediaFollower,
	offsetMs: number,
	options: {
		playing: boolean;
		scrubbing: boolean;
		heldPlaybackRate?: number;
	},
): MediaPlaybackSyncResult {
	const position = getOffsetMediaPosition(master.currentTime, offsetMs, follower.duration);
	const shouldHoldFrame = !options.playing || options.scrubbing || position.boundary !== null;

	if (shouldHoldFrame) {
		if (!follower.paused) {
			follower.pause();
		}
		const heldPlaybackRate =
			options.heldPlaybackRate &&
			Number.isFinite(options.heldPlaybackRate) &&
			options.heldPlaybackRate > 0
				? options.heldPlaybackRate
				: 1;
		if (follower.playbackRate !== heldPlaybackRate) {
			follower.playbackRate = heldPlaybackRate;
		}
		if (
			!options.scrubbing &&
			!follower.seeking &&
			Math.abs(follower.currentTime - position.timeSeconds) > SOFT_SYNC_THRESHOLD_SECONDS
		) {
			follower.currentTime = position.timeSeconds;
		}
		return "held";
	}

	if (follower.ended) {
		if (follower.seeking) {
			return "seeking";
		}
		follower.currentTime = position.timeSeconds;
		return "seeked";
	}

	const syncResult = synchronizeMediaFollower(master, follower, offsetMs);
	if (syncResult !== "seeked" && syncResult !== "seeking" && follower.paused) {
		void follower.play().catch(() => {
			// The primary media remains authoritative if a muted sidecar cannot resume.
		});
	}
	return syncResult;
}
