import { describe, expect, it } from "vitest";
import { buildNativeNvdecArgs, buildNativeNvdecVideoFilter } from "./nativeNvdec";

describe("buildNativeNvdecArgs", () => {
	it("applies the export timeline on CUDA frames before downloading packed NV12", () => {
		const args = buildNativeNvdecArgs({
			inputPath: "/recordings/source.webm",
			frameRate: 30,
			timelineSegments: [
				{ startSec: 0, endSec: 2, speed: 1 },
				{ startSec: 4, endSec: 6, speed: 2 },
			],
			totalFrames: 90,
		});

		expect(args).toContain("cuda");
		expect(args).toContain("0:v:0");
		expect(args).toContain("6");
		expect(args).toContain("90");
		expect(args.join(" ")).toContain("select='gte(t,0)*lt(t,2)+gte(t,4)*lt(t,6)'");
		expect(args.join(" ")).toContain("fps=30:start_time=0:round=near");
		expect(args.join(" ")).toContain("tpad=stop_mode=clone:stop=-1,hwdownload,format=nv12");
		expect(args).toContain("nv12");
		expect(args.at(-1)).toBe("pipe:1");
	});

	it("starts each segment on the next frame boundary", () => {
		const filter = buildNativeNvdecVideoFilter(
			[
				{ startSec: 0, endSec: 0.05, speed: 1 },
				{ startSec: 1, endSec: 1.05, speed: 1 },
			],
			30,
		);

		expect(filter).toContain("(0.066667+(PTS*TB-1)/1)/TB");
	});
});
