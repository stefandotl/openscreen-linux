const SOFT_SYNC_THRESHOLD_SECONDS = 0.015;
const HARD_SYNC_THRESHOLD_SECONDS = 0.075;
const MAX_PLAYBACK_RATE_CORRECTION = 0.05;

type MediaClock = Pick<HTMLMediaElement, "currentTime" | "duration" | "playbackRate">;

export type MediaSyncResult = "aligned" | "rate-adjusted" | "seeked" | "unavailable";

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

export function getOffsetMediaTime(
	masterTimeSeconds: number,
	offsetMs: number,
	followerDurationSeconds: number,
) {
	const requestedTime = masterTimeSeconds + offsetMs / 1000;
	const lastPlayableTime = Number.isFinite(followerDurationSeconds)
		? Math.max(0, followerDurationSeconds - 0.001)
		: Number.POSITIVE_INFINITY;
	return clamp(requestedTime, 0, lastPlayableTime);
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
