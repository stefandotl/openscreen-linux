const MEDIA_TIME_EPSILON_SECONDS = 0.001;
const MEDIA_SEEK_TIMEOUT_MS = 10_000;

function clampMediaTime(video: HTMLVideoElement, timeSeconds: number) {
	const upperBound =
		Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
	return Math.max(0, Math.min(timeSeconds, upperBound));
}

export function seekMediaElement(video: HTMLVideoElement, timeSeconds: number): Promise<void> {
	const targetTime = clampMediaTime(video, timeSeconds);
	if (!video.seeking && Math.abs(video.currentTime - targetTime) <= MEDIA_TIME_EPSILON_SECONDS) {
		return Promise.resolve();
	}

	return new Promise((resolve, reject) => {
		let settled = false;
		const timeout = window.setTimeout(() => {
			finish(() => reject(new Error(`Timed out while seeking video to ${targetTime.toFixed(3)}s`)));
		}, MEDIA_SEEK_TIMEOUT_MS);

		const finish = (complete: () => void) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeout);
			video.removeEventListener("seeked", handleSeeked);
			video.removeEventListener("error", handleError);
			complete();
		};
		const handleSeeked = () => finish(resolve);
		const handleError = () => finish(() => reject(new Error("Video failed while seeking")));

		video.addEventListener("seeked", handleSeeked);
		video.addEventListener("error", handleError);
		try {
			video.currentTime = targetTime;
		} catch (error) {
			finish(() => reject(error));
			return;
		}

		queueMicrotask(() => {
			if (
				!video.seeking &&
				Math.abs(video.currentTime - targetTime) <= MEDIA_TIME_EPSILON_SECONDS
			) {
				finish(resolve);
			}
		});
	});
}
