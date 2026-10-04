import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractMono16kFromVideoUrl } from "./extractMono16k";
import { trimLeadingSilenceMono16k } from "./leadingSilence";
import { transcribeVideoToSegments, transcribeWhisperMono16kToSegments } from "./transcribe";
import { transcribeSourceVideo } from "./transcribeSourceVideo";

vi.mock("./extractMono16k", () => ({ extractMono16kFromVideoUrl: vi.fn() }));
vi.mock("./leadingSilence", () => ({ trimLeadingSilenceMono16k: vi.fn() }));
vi.mock("./transcribe", () => ({
	transcribeVideoToSegments: vi.fn(),
	transcribeWhisperMono16kToSegments: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());

describe("source transcription shared by captions and AI Cut", () => {
	it("uses the chosen cloud model and retains a full untrimmed source transcript", async () => {
		vi.mocked(transcribeVideoToSegments).mockResolvedValue({
			segments: [{ text: "speech", startSec: 1, endSec: 2 }],
			granularity: "word",
			truncated: false,
		});
		const result = await transcribeSourceVideo("file:///source.mp4", {
			engine: "openrouter",
			model: "fish-audio/transcribe-1",
			sourceDurationSec: 5,
		});
		expect(transcribeVideoToSegments).toHaveBeenCalledWith("file:///source.mp4", {
			engine: "openrouter",
			model: "fish-audio/transcribe-1",
			sourceDurationSec: 5,
		});
		expect(result).toMatchObject({
			sourcePath: "/source.mp4",
			engine: "openrouter",
			model: "fish-audio/transcribe-1",
			sourceDurationSec: 5,
		});
	});
	it("keeps Whisper segment and word offsets aligned after removing leading silence", async () => {
		vi.mocked(extractMono16kFromVideoUrl).mockResolvedValue({
			samples: new Float32Array(48000),
			durationSec: 3,
			truncated: false,
		});
		vi.mocked(trimLeadingSilenceMono16k).mockReturnValue({
			samples: new Float32Array(16000),
			trimSec: 2,
		});
		vi.mocked(transcribeWhisperMono16kToSegments).mockResolvedValue({
			segments: [
				{
					text: "Hello",
					startSec: 0.1,
					endSec: 0.5,
					words: [{ text: "Hello", startSec: 0.1, endSec: 0.5 }],
				},
			],
			granularity: "word",
		});
		const result = await transcribeSourceVideo("file:///source.mp4", {
			engine: "whisper-tiny",
			sourceDurationSec: 3,
		});
		expect(result.segments[0]).toMatchObject({
			startSec: 2.1,
			endSec: 2.5,
			words: [{ text: "Hello", startSec: 2.1, endSec: 2.5 }],
		});
		expect(transcribeVideoToSegments).not.toHaveBeenCalled();
	});
	it("does not switch engines when a provider fails or publish an aborted result", async () => {
		vi.mocked(transcribeVideoToSegments).mockRejectedValueOnce(new Error("Provider unavailable"));
		await expect(
			transcribeSourceVideo("file:///source.mp4", {
				engine: "openrouter",
				model: "fish-audio/transcribe-1",
				sourceDurationSec: 5,
			}),
		).rejects.toThrow("Provider unavailable");
		expect(transcribeWhisperMono16kToSegments).not.toHaveBeenCalled();
		const controller = new AbortController();
		vi.mocked(transcribeVideoToSegments).mockImplementation(async () => {
			controller.abort();
			return { segments: [], granularity: "word", truncated: false };
		});
		await expect(
			transcribeSourceVideo("file:///source.mp4", {
				engine: "parakeet",
				sourceDurationSec: 5,
				signal: controller.signal,
			}),
		).rejects.toThrow();
	});
});
