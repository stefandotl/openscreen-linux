// Google Fonts loading and management

export interface CustomFont {
	id: string;
	name: string;
	fontFamily: string;
	importUrl: string; // Google Fonts @import URL
}

export function isCustomFont(value: unknown): value is CustomFont {
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
