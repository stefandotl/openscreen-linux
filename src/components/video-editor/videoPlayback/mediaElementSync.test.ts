import { describe, expect, it, vi } from "vitest";
import {
	getOffsetMediaPosition,
	getOffsetMediaTime,
	synchronizeMediaFollower,
	synchronizeMediaFollowerPlayback,
} from "./mediaElementSync";

function mediaClock(currentTime: number, duration = 10, playbackRate = 1) {
	return { currentTime, duration, playbackRate };
}

function playbackFollower(currentTime: number, paused = false) {
	let isPaused = paused;
	const pause = vi.fn(() => {
		isPaused = true;
	});
	const play = vi.fn(() => {
		isPaused = false;
		return Promise.resolve();
	});
	return {
		follower: {
			currentTime,
			duration: 10,
			playbackRate: 1,
			seeking: false,
			ended: false,
			get paused() {
				return isPaused;
			},
			pause,
			play,
		},
		pause,
		play,
	};
}

describe("mediaElementSync", () => {
	it("advances the webcam by the configured offset", () => {
		const master = mediaClock(2);
		const follower = mediaClock(2);

		expect(synchronizeMediaFollower(master, follower, 200)).toBe("seeked");
		expect(follower.currentTime).toBeCloseTo(2.2);
	});

	it("uses a small playback-rate correction instead of repeatedly seeking", () => {
		const master = mediaClock(3);
		const follower = mediaClock(2.96);

		expect(synchronizeMediaFollower(master, follower, 0)).toBe("rate-adjusted");
		expect(follower.currentTime).toBe(2.96);
		expect(follower.playbackRate).toBeCloseTo(1.04);
	});

	it("inherits the primary playback rate when the clocks are aligned", () => {
		const master = mediaClock(4, 10, 2);
		const follower = mediaClock(4.005, 10, 1);

		expect(synchronizeMediaFollower(master, follower, 0)).toBe("aligned");
		expect(follower.playbackRate).toBe(2);
	});

	it("repositions the webcam after rewinding and changing the offset", () => {
		const master = mediaClock(6, 10, 1);
		const follower = mediaClock(6.2, 10, 1.04);

		master.currentTime = 2;

		expect(synchronizeMediaFollower(master, follower, 350)).toBe("seeked");
		expect(follower.currentTime).toBeCloseTo(2.35);
		expect(follower.playbackRate).toBe(1);
	});

	it("does not restart an in-flight webcam seek on every primary frame", () => {
		const master = mediaClock(2);
		const follower = { ...mediaClock(6, 10, 1.04), seeking: true };

		expect(synchronizeMediaFollower(master, follower, 350)).toBe("seeking");
		expect(follower.currentTime).toBe(6);
		expect(follower.playbackRate).toBe(1);
	});

	it("identifies offset boundaries where the webcam frame must be held", () => {
		expect(getOffsetMediaPosition(0.1, -200, 10)).toEqual({
			timeSeconds: 0,
			boundary: "start",
		});
		expect(getOffsetMediaPosition(9.9, 200, 10)).toEqual({
			timeSeconds: 9.999,
			boundary: "end",
		});
		expect(getOffsetMediaPosition(0.2, -200, 10)).toEqual({
			timeSeconds: 0,
			boundary: null,
		});
	});

	it("does not pause a playing webcam when the offset changes", () => {
		const master = mediaClock(2);
		const { follower, pause } = playbackFollower(2);

		expect(
			synchronizeMediaFollowerPlayback(master, follower, 200, {
				playing: true,
				scrubbing: false,
			}),
		).toBe("seeked");
		expect(follower.currentTime).toBeCloseTo(2.2);
		expect(pause).not.toHaveBeenCalled();
	});

	it("holds during rapid scrubbing and resumes only after the final seek settles", () => {
		const master = mediaClock(2);
		const { follower, pause, play } = playbackFollower(6);

		expect(
			synchronizeMediaFollowerPlayback(master, follower, 200, {
				playing: true,
				scrubbing: true,
			}),
		).toBe("held");
		expect(pause).toHaveBeenCalledOnce();
		expect(follower.currentTime).toBe(6);

		expect(
			synchronizeMediaFollowerPlayback(master, follower, 200, {
				playing: true,
				scrubbing: false,
			}),
		).toBe("seeked");
		expect(follower.currentTime).toBeCloseTo(2.2);
		expect(play).not.toHaveBeenCalled();

		expect(
			synchronizeMediaFollowerPlayback(master, follower, 200, {
				playing: true,
				scrubbing: false,
			}),
		).toBe("aligned");
		expect(play).toHaveBeenCalledOnce();
	});

	it("holds a negative offset at the first frame instead of repeatedly seeking", () => {
		const master = mediaClock(0.1);
		const { follower, pause } = playbackFollower(0.3);

		expect(
			synchronizeMediaFollowerPlayback(master, follower, -200, {
				playing: true,
				scrubbing: false,
			}),
		).toBe("held");
		expect(follower.currentTime).toBe(0);
		expect(pause).toHaveBeenCalledOnce();
	});

	it("clamps offset sampling to the webcam duration", () => {
		expect(getOffsetMediaTime(9.95, 200, 10)).toBeCloseTo(9.999);
		expect(getOffsetMediaTime(0.05, -200, 10)).toBe(0);
	});
});
