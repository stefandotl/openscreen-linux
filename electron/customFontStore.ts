import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
	type CustomFont,
	isCustomFont,
	normalizeGoogleFontsImportUrl,
} from "../src/lib/customFontDefinitions";

// One atomic file per family avoids lost updates when Dev and the installed app
// add different fonts concurrently. The directory is independent of userData.
export class CustomFontStore {
	constructor(private readonly directory: string) {}

	async list(): Promise<CustomFont[]> {
		await fs.mkdir(this.directory, { recursive: true });
		const names = (await fs.readdir(this.directory))
			.filter((name) => name.endsWith(".json"))
			.sort();
		return Promise.all(
			names.map(async (name) => {
				const font: unknown = JSON.parse(
					await fs.readFile(path.join(this.directory, name), "utf8"),
				);
				if (!isCustomFont(font)) throw new Error(`Invalid custom font file: ${name}`);
				return font;
			}),
		);
	}

	async merge(input: unknown): Promise<CustomFont[]> {
		if (!Array.isArray(input) || input.length > 1000 || !input.every(isCustomFont)) {
			throw new Error("Invalid custom font definitions");
		}
		await fs.mkdir(this.directory, { recursive: true });
		for (const font of input) {
			const key = createHash("sha256").update(font.fontFamily.trim().toLowerCase()).digest("hex");
			const destination = path.join(this.directory, `${key}.json`);
			const temporary = path.join(this.directory, `${key}.${randomUUID()}.tmp`);
			try {
				await fs.writeFile(
					temporary,
					JSON.stringify({ ...font, importUrl: normalizeGoogleFontsImportUrl(font.importUrl) }),
					{ mode: 0o600 },
				);
				await fs.rename(temporary, destination);
			} finally {
				await fs.rm(temporary, { force: true });
			}
		}
		return this.list();
	}
}
