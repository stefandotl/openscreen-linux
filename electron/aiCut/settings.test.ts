// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiCutSettingsStore, type SecretStorage } from "./settings";

let directory: string;
const secrets: SecretStorage = {
	isEncryptionAvailable: () => true,
	getSelectedStorageBackend: () => "gnome_libsecret",
	encryptString: (value) => Buffer.from([...value].reverse().join("")),
	decryptString: (value) => [...value.toString()].reverse().join(""),
};
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "videtio-ai-cut-test-"));
});
afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});
describe("OpenRouter settings", () => {
	it("stores an encrypted key with restricted permissions and never returns it to the renderer", async () => {
		const file = path.join(directory, "settings.json");
		const store = new AiCutSettingsStore(file, secrets);
		const settings = await store.update({ model: "provider/model", apiKey: "secret-value" });
		expect(settings).toMatchObject({ hasApiKey: true, keyStorage: "encrypted" });
		expect(JSON.stringify(settings)).not.toContain("secret-value");
		expect(await fs.readFile(file, "utf8")).not.toContain("secret-value");
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		expect(await new AiCutSettingsStore(file, secrets).credentials()).toEqual({
			model: "provider/model",
			apiKey: "secret-value",
		});
		await store.update({ model: "provider/new" });
		expect(await store.credentials()).toEqual({ model: "provider/new", apiKey: "secret-value" });
		await store.update({ model: "provider/new", apiKey: "" });
		expect((await store.getSettings()).hasApiKey).toBe(false);
	});
	it("keeps Linux basic_text keys only in memory and survives concurrent settings updates", async () => {
		const file = path.join(directory, "settings.json");
		const storage = { ...secrets, getSelectedStorageBackend: () => "basic_text" };
		const store = new AiCutSettingsStore(file, storage);
		await Promise.all([
			store.update({ model: "a/one", apiKey: "session-secret" }),
			store.update({ model: "a/two" }),
		]);
		expect(await store.getSettings()).toMatchObject({
			model: "a/two",
			keyStorage: "session",
			canStoreKey: false,
		});
		expect(await fs.readFile(file, "utf8")).not.toContain("session-secret");
		expect((await new AiCutSettingsStore(file, storage).getSettings()).hasApiKey).toBe(false);
	});
	it("reports corruption and encryption failures, but accepts correcting rejected input", async () => {
		const file = path.join(directory, "settings.json");
		const store = new AiCutSettingsStore(file, secrets);
		await expect(store.update({ model: "https://bad url", apiKey: "x" })).rejects.toThrow(
			"Invalid",
		);
		await store.update({ model: "a/model", apiKey: "key" });
		await expect(
			new AiCutSettingsStore(file, {
				...secrets,
				decryptString: () => {
					throw new Error("secret-key");
				},
			}).credentials(),
		).rejects.toThrow("Cannot decrypt");
		await fs.writeFile(file, "broken");
		await expect(store.getSettings()).rejects.toThrow();
	});
});
