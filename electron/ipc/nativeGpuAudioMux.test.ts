import { describe, expect, it } from "vitest";
import { buildNativeGpuAudioMuxArgs } from "./nativeGpuAudioMux";

const input = {
	videoOnlyPath: "/tmp/video.mp4",
	audioPath: "/tmp/source.mp4",
	outputPath: "/tmp/output.mp4",
	totalFrames: 5736,
	frameRate: 30,
};

describe("buildNativeGpuAudioMuxArgs", () => {
	it("preserves every video frame and pads unedited audio to the CFR duration", () => {
		const args = buildNativeGpuAudioMuxArgs(input, null);

		expect(args).not.toContain("-shortest");
		expect(args).toContain("apad=whole_dur=191.200000");
		expect(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2)).toEqual(["-t", "191.200000"]);
	});

	it("pads the output of an edited audio filter graph", () => {
		const args = buildNativeGpuAudioMuxArgs(input, {
			filter: "[1:a]atrim=start=1:end=2[aout]",
			outputLabel: "[aout]",
		});
		const filter = args[args.indexOf("-filter_complex") + 1];

		expect(filter).toBe(
			"[1:a]atrim=start=1:end=2[aout];[aout]apad=whole_dur=191.200000[native_audio]",
		);
		expect(args).toContain("[native_audio]");
	});
});
