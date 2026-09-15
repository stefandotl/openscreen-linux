// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CustomFontStore } from "./customFontStore";

const font = (family: string) => ({
	id: family,
	name: family,
	fontFamily: family,
	importUrl: `https://fonts.googleapis.com/css2?family=${family}`,
});
let directory: string;
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "videtio-font-test-"));
});
afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

describe("shared custom font store", () => {
	it("preserves simultaneous additions from Dev and installed instances across restarts", async () => {
		const dev = new CustomFontStore(directory);
		const installed = new CustomFontStore(directory);
		await Promise.all([dev.merge([font("Roboto")]), installed.merge([font("Lora")])]);
		expect(await new CustomFontStore(directory).list()).toEqual(
			expect.arrayContaining([font("Roboto"), font("Lora")]),
		);
		await installed.merge([{ ...font("Roboto"), id: "another-id" }]);
		expect(await dev.list()).toHaveLength(2);
	});
	it("rejects untrusted definitions and never uses ids as file paths", async () => {
		const store = new CustomFontStore(directory);
		await expect(
			store.merge([{ ...font("Roboto"), importUrl: "file:///etc/passwd" }]),
		).rejects.toThrow("Invalid");
		await store.merge([{ ...font("Roboto"), id: "../../outside" }]);
		expect(await fs.readdir(directory)).toEqual([expect.stringMatching(/^[a-f0-9]{64}\.json$/)]);
	});
	it("reports corrupt persistent data instead of discarding it", async () => {
		await fs.writeFile(path.join(directory, "broken.json"), "{}");
		await expect(new CustomFontStore(directory).list()).rejects.toThrow("Invalid custom font file");
	});
});
