import {
	type CustomFont,
	isCustomFont,
	normalizeGoogleFontsImportUrl,
} from "./customFontDefinitions";

export {
	type CustomFont,
	isValidGoogleFontsUrl,
	normalizeGoogleFontsImportUrl,
	parseFontFamilyFromImport,
} from "./customFontDefinitions";

const STORAGE_KEY = "videtio_custom_fonts";
export const CUSTOM_FONTS_CHANGED = "videtio-custom-fonts-changed";
let fonts: CustomFont[] = [];
let operation: Promise<unknown> = Promise.resolve();
const loadedFonts = new Map<string, { url: string; promise: Promise<void> }>();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const result = operation.then(task, task);
	operation = result;
	return result;
}

export function getCustomFonts(): CustomFont[] {
	return fonts.map((font) => ({ ...font }));
}

function publish(next: CustomFont[]): void {
	fonts = next;
	window.dispatchEvent(new Event(CUSTOM_FONTS_CHANGED));
}

async function readSharedFonts(): Promise<CustomFont[]> {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored !== null) {
		const legacy: unknown = JSON.parse(stored);
		if (!Array.isArray(legacy)) throw new Error("Invalid legacy custom font storage");
		const next = await window.electronAPI.mergeCustomFonts(legacy.filter(isCustomFont));
		// Only retire the origin-specific copy after the shared write succeeds.
		localStorage.removeItem(STORAGE_KEY);
		return next;
	}
	return window.electronAPI.listCustomFonts();
}

export function loadAllCustomFonts(): Promise<void> {
	return enqueue(async () => {
		const next = await readSharedFonts();
		// Keep definitions available for project saves even if the network is offline.
		publish(next);
		await Promise.all(next.map(loadFont));
	});
}

export function restoreProjectFonts(value: unknown): Promise<void> {
	return enqueue(async () => {
		const shared = await readSharedFonts();
		if (value !== undefined && (!Array.isArray(value) || !value.every(isCustomFont))) {
			throw new Error("Project contains invalid custom font definitions");
		}
		const projectFonts = (value ?? []) as CustomFont[];
		await Promise.all(projectFonts.map(loadFont));
		const next = projectFonts.length
			? await window.electronAPI.mergeCustomFonts(projectFonts)
			: shared;
		await Promise.all(next.map(loadFont));
		publish(next);
	});
}

export function addCustomFont(font: CustomFont): Promise<CustomFont[]> {
	return enqueue(async () => {
		if (!isCustomFont(font)) throw new Error("Invalid custom font definition");
		await readSharedFonts();
		await loadFont(font);
		const next = await window.electronAPI.mergeCustomFonts([font]);
		publish(next);
		return getCustomFonts();
	});
}

export function loadFont(font: CustomFont): Promise<void> {
	if (!isCustomFont(font)) return Promise.reject(new Error("Invalid custom font definition"));
	const url = normalizeGoogleFontsImportUrl(font.importUrl)!;
	const existing = loadedFonts.get(font.fontFamily);
	if (existing?.url === url) return existing.promise;
	const styleId = `custom-font-${encodeURIComponent(font.fontFamily)}`;
	document.getElementById(styleId)?.remove();
	const link = document.createElement("link");
	link.id = styleId;
	link.rel = "stylesheet";
	link.href = url;
	const promise = new Promise<void>((resolve, reject) => {
		const finish = (error?: Error) => {
			clearTimeout(timeout);
			link.onload = null;
			link.onerror = null;
			if (error) {
				link.remove();
				reject(error);
			} else resolve();
		};
		const timeout = setTimeout(
			() => finish(new Error(`Font load timeout: ${font.fontFamily}`)),
			10000,
		);
		link.onerror = () => finish(new Error(`Could not load font stylesheet: ${font.fontFamily}`));
		link.onload = async () => {
			try {
				// Wait for the CSS before querying FontFaceSet; an undeclared family
				// otherwise "loads" successfully as an empty array and uses a fallback.
				const faces = await document.fonts.load(`16px ${JSON.stringify(font.fontFamily)}`);
				if (faces.length === 0)
					throw new Error(`Font is missing from stylesheet: ${font.fontFamily}`);
				finish();
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		};
		document.head.appendChild(link);
	}).catch((error) => {
		if (loadedFonts.get(font.fontFamily)?.promise === promise) loadedFonts.delete(font.fontFamily);
		throw error;
	});
	loadedFonts.set(font.fontFamily, { url, promise });
	return promise;
}

export function generateFontId(name: string): string {
	return `${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
}
