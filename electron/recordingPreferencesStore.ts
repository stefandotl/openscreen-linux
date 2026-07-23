import fs from "node:fs/promises";
import path from "node:path";
import {
	DEFAULT_RECORDING_PREFS,
	normalizeRecordingPreferences,
	type RecordingPreferences,
} from "../src/lib/recordingPreferences";

export interface LoadedRecordingPreferences {
	preferences: RecordingPreferences;
	exists: boolean;
}

function clonePreferences(preferences: RecordingPreferences): RecordingPreferences {
	return {
		...preferences,
		captureSource: preferences.captureSource ? { ...preferences.captureSource } : null,
	};
}

export class RecordingPreferencesStore {
	private cached: LoadedRecordingPreferences | null = null;
	private operation: Promise<void> = Promise.resolve();

	constructor(private readonly filePath: string) {}

	async load(): Promise<LoadedRecordingPreferences> {
		return this.enqueue(() => this.loadFromDisk());
	}

	async initialize(fallback: unknown): Promise<LoadedRecordingPreferences> {
		return this.enqueue(async () => {
			const loaded = await this.loadFromDisk();
			if (loaded.exists) return loaded;

			const preferences = normalizeRecordingPreferences(fallback);
			await this.writeToDisk(preferences);
			return { preferences, exists: true };
		});
	}

	async update(partial: unknown): Promise<RecordingPreferences> {
		return this.enqueue(async () => {
			const loaded = await this.loadFromDisk();
			const rawPartial = partial && typeof partial === "object" ? partial : {};
			const preferences = normalizeRecordingPreferences({
				...loaded.preferences,
				...rawPartial,
			});
			await this.writeToDisk(preferences);
			return preferences;
		});
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.operation.then(task, task);
		this.operation = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async loadFromDisk(): Promise<LoadedRecordingPreferences> {
		if (this.cached) {
			return {
				preferences: clonePreferences(this.cached.preferences),
				exists: this.cached.exists,
			};
		}

		try {
			const raw = JSON.parse(await fs.readFile(this.filePath, "utf8"));
			const loaded = {
				preferences: normalizeRecordingPreferences(raw),
				exists: true,
			};
			this.cached = loaded;
			return {
				preferences: clonePreferences(loaded.preferences),
				exists: true,
			};
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code !== "ENOENT") {
				console.error("Failed to load recording preferences:", error);
			}
			return {
				preferences: clonePreferences(DEFAULT_RECORDING_PREFS),
				exists: false,
			};
		}
	}

	private async writeToDisk(preferences: RecordingPreferences): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
		try {
			await fs.writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
			await fs.rename(temporaryPath, this.filePath);
		} catch (error) {
			await fs.unlink(temporaryPath).catch(() => undefined);
			throw error;
		}
		this.cached = {
			preferences: clonePreferences(preferences),
			exists: true,
		};
	}
}
