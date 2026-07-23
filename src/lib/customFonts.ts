// Google Fonts loading and management

export interface CustomFont {
	id: string;
	name: string;
	fontFamily: string;
	importUrl: string; // Google Fonts @import URL
}

const STORAGE_KEY = "openscreen_custom_fonts";
const loadedFonts = new Set<string>();

function isCustomFont(value: unknown): value is CustomFont {
	if (!value || typeof value !== "object") return false;
	const font = value as Partial<CustomFont>;
	return (
		typeof font.id === "string" &&
		Boolean(font.id) &&
		typeof font.name === "string" &&
		Boolean(font.name.trim()) &&
		typeof font.fontFamily === "string" &&
		Boolean(font.fontFamily.trim()) &&
		typeof font.importUrl === "string" &&
		isValidGoogleFontsUrl(font.importUrl)
	);
}

export function getCustomFonts(): CustomFont[] {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) return [];
		const parsed: unknown = JSON.parse(stored);
		return Array.isArray(parsed) ? parsed.filter(isCustomFont) : [];
	} catch (error) {
		console.error("Failed to load custom fonts from storage:", error);
		return [];
	}
}

export function saveCustomFonts(fonts: CustomFont[]): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(fonts));
}

// Throws if the font fails to load
export async function addCustomFont(font: CustomFont): Promise<CustomFont[]> {
	const fonts = getCustomFonts();
	const exists = fonts.some((f) => f.id === font.id || f.fontFamily === font.fontFamily);

	if (exists) {
		return fonts;
	}

	// Load first so a failure throws before we persist it
	await loadFont(font);

	fonts.push(font);
	saveCustomFonts(fonts);

	return fonts;
}

export function removeCustomFont(fontId: string): CustomFont[] {
	const fonts = getCustomFonts();
	const filtered = fonts.filter((f) => f.id !== fontId);
	saveCustomFonts(filtered);

	const styleEl = document.getElementById(`custom-font-${fontId}`);
	if (styleEl) {
		styleEl.remove();
	}

	loadedFonts.delete(fontId);
	return filtered;
}

// Load a Google Font into the document
export function loadFont(font: CustomFont): Promise<void> {
	return new Promise((resolve, reject) => {
		if (loadedFonts.has(font.id)) {
			resolve();
			return;
		}

		try {
			const styleId = `custom-font-${font.id}`;

			const existing = document.getElementById(styleId);
			if (existing) {
				existing.remove();
			}

			const style = document.createElement("style");
			style.id = styleId;
			style.textContent = `@import url('${font.importUrl}');`;
			document.head.appendChild(style);

			waitForFont(font.fontFamily)
				.then(() => {
					loadedFonts.add(font.id);
					resolve();
				})
				.catch(reject);
		} catch (error) {
			console.error("Failed to load font:", font, error);
			reject(error);
		}
	});
}

// Wait for a font to load and verify it's actually available
function waitForFont(fontFamily: string, timeout = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		if ("fonts" in document) {
			Promise.race([
				document.fonts.load(`16px "${fontFamily}"`),
				new Promise((_, rej) => setTimeout(() => rej(new Error("Font load timeout")), timeout)),
			])
				.then(() => {
					const isAvailable = document.fonts.check(`16px "${fontFamily}"`);
					if (isAvailable) {
						resolve();
					} else {
						reject(new Error(`Font "${fontFamily}" failed to load`));
					}
				})
				.catch((error) => {
					reject(error);
				});
		} else {
			// No Font Loading API: wait a bit and hope for the best
			setTimeout(() => resolve(), 1000);
		}
	});
}

// Load all stored custom fonts on app init
export function loadAllCustomFonts(): Promise<void[]> {
	const fonts = getCustomFonts();
	return Promise.all(
		fonts.map((font) =>
			loadFont(font).catch((err) => {
				console.error("Failed to load custom font:", font.name, err);
			}),
		),
	);
}

export function generateFontId(name: string): string {
	return `${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
}

// Extract the font family from a Google Fonts @import URL
export function parseFontFamilyFromImport(importUrl: string): string | null {
	try {
		// e.g. https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap
		const normalizedUrl = normalizeGoogleFontsImportUrl(importUrl);
		if (!normalizedUrl) return null;
		const url = new URL(normalizedUrl);
		const familyParam = url.searchParams.get("family");

		if (familyParam) {
			// "Roboto:wght@400;700" -> "Roboto"
			const fontName = familyParam.split(":")[0];
			// "Open+Sans" -> "Open Sans"
			return fontName.replace(/\+/g, " ");
		}

		return null;
	} catch (error) {
		console.error("Failed to parse font family from import URL:", error);
		return null;
	}
}

/** Accept either the bare Google Fonts URL or the complete CSS `@import` snippet. */
export function normalizeGoogleFontsImportUrl(value: string): string | null {
	const trimmed = value.trim();
	const quotedImportMatch =
		/^@import\s+url\(\s*(["'])(https:\/\/fonts\.googleapis\.com\/.+)\1\s*\)\s*;?$/i.exec(trimmed);
	const unquotedImportMatch =
		/^@import\s+url\(\s*(https:\/\/fonts\.googleapis\.com\/.+)\s*\)\s*;?$/i.exec(trimmed);
	const candidate = quotedImportMatch?.[2] ?? unquotedImportMatch?.[1] ?? trimmed;

	try {
		const url = new URL(candidate);
		return url.protocol === "https:" &&
			url.hostname === "fonts.googleapis.com" &&
			url.searchParams.has("family")
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

// Does this look like a Google Fonts import URL?
export function isValidGoogleFontsUrl(url: string): boolean {
	return normalizeGoogleFontsImportUrl(url) !== null;
}
