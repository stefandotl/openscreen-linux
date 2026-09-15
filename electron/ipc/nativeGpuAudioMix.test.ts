// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildNativeGpuAudioMuxArgs } from "./nativeGpuAudioMux";

describe("native audio clip mixing with FFmpeg", () => {
	it("mixes overlapping external clips on a silent video and preserves cuts, speeds and fades", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-audio-mix-"));
		const ffmpeg = process.env.VIDETIO_FFMPEG_PATH ?? "/usr/bin/ffmpeg";
		const run = (args: string[]) =>
			execFileSync(ffmpeg, ["-v", "error", ...args], { stdio: ["ignore", "pipe", "pipe"] });
		try {
			const video = path.join(directory, "video.mp4");
			const tone = path.join(directory, "tone.wav");
			const output = path.join(directory, "output.mp4");
			run([
				"-f",
				"lavfi",
				"-i",
				"color=black:s=32x32:r=30:d=4",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				video,
			]);
			run(["-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=3", tone]);
			const first = {
				id: "one",
				name: "tone",
				sourcePath: tone,
				sourceStartMs: 500,
				sourceDurationMs: 3000,
				startMs: 2000,
				endMs: 4000,
				volume: 0.5,
				fadeInMs: 500,
				fadeOutMs: 0,
			};
			const args = buildNativeGpuAudioMuxArgs(
				{
					videoOnlyPath: video,
					outputPath: output,
					totalFrames: 120,
					frameRate: 30,
					sourceDurationSec: 6,
					audioRegions: [first, { ...first, id: "two", startMs: 3000, volume: 0.25, fadeInMs: 0 }],
				},
				{
					filter:
						"[1:a]atrim=start=1:end=2,asetpts=PTS-STARTPTS[a0];[1:a]atrim=start=2:end=4,asetpts=PTS-STARTPTS,atempo=2[a1];[1:a]atrim=start=4:end=6,asetpts=PTS-STARTPTS[a2];[a0][a1][a2]concat=n=3:v=0:a=1[aout]",
					outputLabel: "[aout]",
				},
			);
			run(args);
			const pcm = run(["-i", output, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
			const rms = (start: number, end: number) => {
				let sum = 0;
				for (let i = Math.round(start * 48000); i < Math.round(end * 48000); i++)
					sum += pcm.readFloatLE(i * 4) ** 2;
				return Math.sqrt(sum / ((end - start) * 48000));
			};
			expect(pcm.length / 4 / 48000).toBeCloseTo(4, 1);
			expect(rms(0.2, 0.8)).toBeLessThan(0.001);
			expect(rms(1.3, 1.4)).toBeGreaterThan(0.025);
			expect(rms(1.03, 1.08)).toBeLessThan(rms(1.3, 1.4) * 0.6);
			expect(rms(1.7, 1.8)).toBeGreaterThan(rms(1.3, 1.4) * 1.25);
			expect(rms(2.2, 3.8)).toBeLessThan(0.001);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
