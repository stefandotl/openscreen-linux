import fs from "node:fs/promises";
import path from "node:path";
import type { CaptionEngine } from "../../src/lib/captioning/transcribe";
import {
	isOpenRouterCaptionModel,
	OPENROUTER_CAPTION_MODELS,
	type OpenRouterSettings,
	type OpenRouterSettingsUpdate,
} from "../../src/lib/openRouter";

export interface SecretStorage {
	isEncryptionAvailable(): boolean;
	getSelectedStorageBackend?(): string;
	encryptString(value: string): Buffer;
	decryptString(value: Buffer): string;
}

export class OpenRouterSettingsStore {
	private sessionKey = "";
	private queue: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly file: string,
		private readonly secrets: SecretStorage,
	) {}
	private canStoreKey() {
		return (
			this.secrets.isEncryptionAvailable() &&
			this.secrets.getSelectedStorageBackend?.() !== "basic_text"
		);
	}
	private async read(): Promise<{
		model: string;
		encryptedKey?: string;
		captionEngine: CaptionEngine;
		transcriptionModel: string;
	}> {
		try {
			const value = JSON.parse(await fs.readFile(this.file, "utf8"));
			if (
				!value ||
				typeof value.model !== "string" ||
				(value.encryptedKey !== undefined && typeof value.encryptedKey !== "string") ||
				(value.captionEngine !== undefined &&
					!["parakeet", "whisper-tiny", "openrouter"].includes(value.captionEngine)) ||
				(value.transcriptionModel !== undefined &&
					!isOpenRouterCaptionModel(value.transcriptionModel))
			)
				throw new Error("Invalid OpenRouter settings file.");
			return {
				...value,
				captionEngine: value.captionEngine ?? "parakeet",
				transcriptionModel: value.transcriptionModel ?? OPENROUTER_CAPTION_MODELS[0].id,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return {
					model: "",
					captionEngine: "parakeet",
					transcriptionModel: OPENROUTER_CAPTION_MODELS[0].id,
				};
			throw error;
		}
	}
	async getSettings(): Promise<OpenRouterSettings> {
		await this.queue;
		const value = await this.read();
		return {
			model: value.model,
			captionEngine: value.captionEngine,
			transcriptionModel: value.transcriptionModel,
			hasApiKey: Boolean(this.sessionKey || value.encryptedKey),
			keyStorage: this.sessionKey ? "session" : value.encryptedKey ? "encrypted" : "none",
			canStoreKey: this.canStoreKey(),
		};
	}
	update(update: OpenRouterSettingsUpdate): Promise<OpenRouterSettings> {
		const operation = this.queue.then(async () => {
			if (
				!update ||
				(update.model !== undefined &&
					(typeof update.model !== "string" ||
						update.model.length > 200 ||
						(update.model && !/^[\w./:@+-]+$/.test(update.model)))) ||
				(update.captionEngine !== undefined &&
					!["parakeet", "whisper-tiny", "openrouter"].includes(update.captionEngine)) ||
				(update.transcriptionModel !== undefined &&
					!isOpenRouterCaptionModel(update.transcriptionModel)) ||
				(update.apiKey !== undefined &&
					(typeof update.apiKey !== "string" ||
						update.apiKey.length > 512 ||
						/\s/.test(update.apiKey)))
			)
				throw new Error("Invalid OpenRouter settings.");
			const value = await this.read();
			if (update.model !== undefined) value.model = update.model;
			if (update.captionEngine !== undefined) value.captionEngine = update.captionEngine;
			if (update.transcriptionModel !== undefined)
				value.transcriptionModel = update.transcriptionModel;
			let sessionKey = this.sessionKey;
			if (update.apiKey !== undefined) {
				delete value.encryptedKey;
				sessionKey = "";
				if (update.apiKey) {
					if (this.canStoreKey())
						value.encryptedKey = this.secrets.encryptString(update.apiKey).toString("base64");
					else sessionKey = update.apiKey;
				}
			}
			await fs.mkdir(path.dirname(this.file), { recursive: true });
			const temporary = `${this.file}.tmp`;
			await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
			await fs.rename(temporary, this.file);
			this.sessionKey = sessionKey;
		});
		// Keep later saves usable after a failure; the caller still receives the rejection.
		this.queue = operation.catch(() => undefined);
		return operation.then(() => this.getSettings());
	}
	async apiKey(): Promise<string> {
		await this.queue;
		const value = await this.read();
		let apiKey = this.sessionKey;
		if (!apiKey && value.encryptedKey) {
			if (!this.canStoreKey())
				throw new Error(
					"Unlock your system keyring or enter your OpenRouter key again for this session.",
				);
			try {
				apiKey = this.secrets.decryptString(Buffer.from(value.encryptedKey, "base64"));
			} catch {
				throw new Error(
					"Cannot decrypt the OpenRouter key. Enter it again in OpenRouter settings.",
				);
			}
		}
		if (!apiKey) throw new Error("Set your API key in OpenRouter settings first.");
		return apiKey;
	}
	async credentials() {
		const apiKey = await this.apiKey();
		const value = await this.getSettings();
		if (!value.model) throw new Error("Select an OpenRouter model in AI Cut first.");
		return { apiKey, model: value.model };
	}
}
