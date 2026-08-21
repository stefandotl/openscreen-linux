import { describe, expect, it } from "vitest";
import { getOffsetMediaTime, synchronizeMediaFollower } from "./mediaElementSync";

function mediaClock(currentTime: number, duration = 10, playbackRate = 1) {
	return { currentTime, duration, playbackRate };
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

	it("clamps offset sampling to the webcam duration", () => {
		expect(getOffsetMediaTime(9.95, 200, 10)).toBeCloseTo(9.999);
		expect(getOffsetMediaTime(0.05, -200, 10)).toBe(0);
	});
});
