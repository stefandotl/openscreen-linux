import { describe, expect, it } from "vitest";
import { isUnexpectedWebcamTrackEnd, type WebcamTrackEndState } from "./webcamTrackLifecycle";

const activeTrackEnd: WebcamTrackEndState = {
	effectCancelled: false,
	acquisitionId: 3,
	currentAcquisitionId: 3,
	streamIsCurrent: true,
	recordingIsFinalizing: false,
	recordingIsRestarting: false,
};

describe("isUnexpectedWebcamTrackEnd", () => {
	it("reports a genuine end of the active webcam track", () => {
		expect(isUnexpectedWebcamTrackEnd(activeTrackEnd)).toBe(true);
	});

	it.each([
		["effect cleanup", { effectCancelled: true }],
		["a stale acquisition", { currentAcquisitionId: 4 }],
		["a replaced stream", { streamIsCurrent: false }],
		["recording finalization", { recordingIsFinalizing: true }],
		["recording restart", { recordingIsRestarting: true }],
	])("ignores an expected track end during %s", (_, state) => {
		expect(isUnexpectedWebcamTrackEnd({ ...activeTrackEnd, ...state })).toBe(false);
	});
});
