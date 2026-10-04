// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENROUTER_CAPTION_MODELS } from "../../src/lib/openRouter";
import {
	openRouterWords,
	pcmToWav,
	requestTimedTranscription,
	transcribeOpenRouterVideo,
} from "./openRouterTranscription";

afterEach(() => vi.unstubAllGlobals());
describe("OpenRouter word timing", () => {
	it.each(OPENROUTER_CAPTION_MODELS)("requests actual word timestamps from $id", async ({ id }) => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ text: "Hello", words: [{ word: "Hello", start: 0.1, end: 0.5 }] }),
				),
			);
		const pcm = Buffer.alloc(32000);
		expect(
			await requestTimedTranscription(
				{ model: id, apiKey: "test-key", pcm, signal: new AbortController().signal },
				fetcher,
			),
		).toEqual([{ text: "Hello", startSec: 0.1, endSec: 0.5 }]);
		const [url, request] = fetcher.mock.calls[0];
		expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
		const body = JSON.parse(request.body);
		expect(body).toMatchObject({
			model: id,
			response_format: "verbose_json",
			timestamp_granularities: ["word"],
			input_audio: { format: "wav" },
		});
		const wav = Buffer.from(body.input_audio.data, "base64");
		expect(wav.subarray(0, 4).toString()).toBe("RIFF");
		expect(wav.readUInt16LE(34)).toBe(16);
		expect(wav.readUInt32LE(24)).toBe(16000);
		expect(wav.subarray(44)).toEqual(pcm);
	});
	it("rejects missing, partial, invalid and unordered timestamps without inventing timing", () => {
		for (const response of [
			{ text: "Hello" },
			{ text: "Hello", words: [] },
			{ words: [{ word: "Hello", start: 0 }] },
			{ words: [{ word: "Hello", start: -1, end: 1 }] },
			{ words: [{ word: "Hello", start: 0, end: 0 }] },
			{ words: [{ word: "Hello", start: 0, end: 3 }] },
			{ words: [{ word: "Hello", start: 2.01, end: 2.02 }] },
			{
				words: [
					{ word: "Hello", start: 1, end: 1.3 },
					{ word: "world", start: 0.3, end: 0.8 },
				],
			},
		])
			expect(() => openRouterWords(response, 2)).toThrow(/timestamps/);
		expect(openRouterWords({ text: "", words: [] }, 2)).toEqual([]);
	});
	it("surfaces provider errors without exposing the provider body or changing models", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response("secret-key private-transcript", { status: 503 }));
		await expect(
			requestTimedTranscription(
				{
					model: OPENROUTER_CAPTION_MODELS[0].id,
					apiKey: "secret-key",
					pcm: Buffer.alloc(32000),
					signal: new AbortController().signal,
				},
				fetcher,
			),
		).rejects.toThrow("HTTP 503");
		expect(fetcher).toHaveBeenCalledOnce();
		for (const model of ["openai/gpt-transcribe", "qwen/qwen3-asr-flash-2026-02-10"]) {
			await expect(
				requestTimedTranscription(
					{ model, apiKey: "key", pcm: Buffer.alloc(32), signal: new AbortController().signal },
					fetcher,
				),
			).rejects.toThrow("not supported");
		}
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it("uses overlap windows, offsets the final short chunk and filters cuts after merging", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "videtio-cloud-caption-test-"));
		try {
			const source = path.join(directory, "source.mp4");
			const ffmpeg = process.env.VIDETIO_FFMPEG_PATH ?? "/usr/bin/ffmpeg";
			execFileSync(ffmpeg, [
				"-v",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=500:sample_rate=16000:duration=65",
				"-c:a",
				"aac",
				source,
			]);
			const fetcher = vi
				.fn()
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							words: [
								{ word: "Before", start: 59.4, end: 59.8 },
								{ word: "After", start: 60.4, end: 60.8 },
							],
						}),
					),
				)
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							words: [
								{ word: "Before", start: 1.4, end: 1.8 },
								{ word: "After", start: 2.4, end: 2.8 },
								{ word: "Last", start: 6, end: 6.5 },
							],
						}),
					),
				);
			vi.stubGlobal("fetch", fetcher);
			const progress = vi.fn();
			const result = await transcribeOpenRouterVideo({
				ffmpegBinary: ffmpeg,
				videoPath: source,
				model: "assemblyai/universal-3-5-pro",
				apiKey: "test-only",
				signal: new AbortController().signal,
				sourceDurationSec: 65,
				trimRegions: [{ id: "cut", startMs: 60300, endMs: 61000 }],
				onProgress: progress,
			});
			expect(result).toEqual({
				granularity: "word",
				truncated: false,
				segments: [
					{ text: "Before", startSec: 59.4, endSec: 59.8 },
					{ text: "Last", startSec: 64, endSec: 64.5 },
				],
			});
			expect(fetcher).toHaveBeenCalledTimes(2);
			const lengths = fetcher.mock.calls.map(
				([, request]) =>
					(Buffer.from(JSON.parse(request.body).input_audio.data, "base64").length - 44) / 32000,
			);
			expect(lengths[0]).toBe(62);
			expect(lengths[1]).toBeLessThan(8);
			expect(progress.mock.calls).toEqual([[50], [100]]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	it("writes a self-contained WAV file and honours cancellation before network access", async () => {
		expect(pcmToWav(Buffer.alloc(100)).readUInt32LE(40)).toBe(100);
		const controller = new AbortController();
		controller.abort();
		const fetcher = vi.fn();
		await expect(
			requestTimedTranscription(
				{
					model: OPENROUTER_CAPTION_MODELS[0].id,
					apiKey: "key",
					pcm: Buffer.alloc(100),
					signal: controller.signal,
				},
				fetcher,
			),
		).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
});
