// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { AiCutRequest } from "../../src/lib/aiCut";
import { listAiCutModels, requestAiCut } from "./openRouter";

const request: AiCutRequest = {
	requestId: "test",
	mode: "tighten",
	instructions: "Keep all steps",
	language: "en",
	durationMs: 3000,
	existingTrims: [],
	units: [
		{ id: 0, kind: "word", text: "um", startMs: 100, endMs: 400 },
		{ id: 1, kind: "word", text: "Hello", startMs: 1000, endMs: 1800 },
	],
};
const credentials = { apiKey: "secret-value", model: "provider/model" };
const completion = {
	choices: [
		{
			finish_reason: "stop",
			message: {
				content: JSON.stringify({ cuts: [{ firstUnitId: 0, lastUnitId: 0, reason: "Filler" }] }),
			},
		},
	],
};
describe("OpenRouter AI Cut", () => {
	it("uses the selected model and strict structured output, and sends only transcript metadata", async () => {
		const fetcher = vi.fn().mockResolvedValue(Response.json(completion));
		const signal = new AbortController().signal;
		expect(await requestAiCut(request, credentials, signal, fetcher)).toEqual([
			expect.objectContaining({ startMs: 100, endMs: 400 }),
		]);
		const [url, options] = fetcher.mock.calls[0];
		expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(options.signal).toBe(signal);
		expect(options.redirect).toBe("error");
		expect(options.headers.Authorization).toBe("Bearer secret-value");
		const body = JSON.parse(options.body);
		expect(body.model).toBe(credentials.model);
		expect(body.provider.require_parameters).toBe(true);
		expect(body.response_format.json_schema.strict).toBe(true);
		expect(options.body).not.toContain(credentials.apiKey);
		expect(JSON.parse(body.messages[1].content)).toEqual({
			mode: "tighten",
			instruction: "Keep all steps",
			durationMs: 3000,
			existingTrims: [],
			units: request.units,
		});
	});
	it("does not expose provider bodies or credentials in errors", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response("secret-value provider diagnostic", { status: 401 }));
		await expect(
			requestAiCut(request, credentials, new AbortController().signal, fetcher),
		).rejects.toThrow("HTTP 401: Invalid API key.");
	});
	it("rejects truncated, malformed and invented plans without fallback", async () => {
		for (const choice of [
			{ ...completion.choices[0], finish_reason: "length" },
			{ finish_reason: "stop", message: { content: "not json" } },
			{
				finish_reason: "stop",
				message: {
					content: JSON.stringify({ cuts: [{ firstUnitId: 20, lastUnitId: 30, reason: "x" }] }),
				},
			},
		]) {
			const fetcher = vi.fn().mockResolvedValue(Response.json({ choices: [choice] }));
			await expect(
				requestAiCut(request, credentials, new AbortController().signal, fetcher),
			).rejects.toThrow();
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
	});
	it("does not send invalid inputs to OpenRouter", async () => {
		const fetcher = vi.fn();
		await expect(
			requestAiCut({ ...request, units: [] }, credentials, new AbortController().signal, fetcher),
		).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("lists only models advertising structured output", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			Response.json({
				data: [
					{ id: "a/model", name: "A", supported_parameters: ["structured_outputs"] },
					{ id: "b/model", name: "B", supported_parameters: ["temperature"] },
				],
			}),
		);
		expect(await listAiCutModels(fetcher)).toEqual([{ id: "a/model", name: "A" }]);
	});
});
