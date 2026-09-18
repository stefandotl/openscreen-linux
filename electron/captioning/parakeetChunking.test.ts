import { describe, expect, it } from "vitest";
import { createParakeetChunkWindows } from "./parakeetChunking";

describe("createParakeetChunkWindows", () => {
	it("keeps short audio in one inference window", () => {
		expect(createParakeetChunkWindows(45_000, 1_000, 60, 2)).toEqual([
			{
				readStartSample: 0,
				readEndSample: 45_000,
				keepStartSample: 0,
				keepEndSample: 45_000,
				isLast: true,
			},
		]);
	});

	it("adds context without overlapping the owned timestamp ranges", () => {
		expect(createParakeetChunkWindows(125_000, 1_000, 60, 2)).toEqual([
			{
				readStartSample: 0,
				readEndSample: 62_000,
				keepStartSample: 0,
				keepEndSample: 60_000,
				isLast: false,
			},
			{
				readStartSample: 58_000,
				readEndSample: 122_000,
				keepStartSample: 60_000,
				keepEndSample: 120_000,
				isLast: false,
			},
			{
				readStartSample: 118_000,
				readEndSample: 125_000,
				keepStartSample: 120_000,
				keepEndSample: 125_000,
				isLast: true,
			},
		]);
	});
});
