import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	isValidGoogleFontsUrl,
	normalizeGoogleFontsImportUrl,
	parseFontFamilyFromImport,
} from "./customFontDefinitions";

const font = {
	id: "roboto",
	name: "Roboto",
	fontFamily: "Roboto",
	importUrl: "https://fonts.googleapis.com/css2?family=Roboto",
};
beforeEach(() => {
	vi.resetModules();
	localStorage.clear();
	document.querySelectorAll('link[id^="custom-font-"]').forEach((element) => element.remove());
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			listCustomFonts: vi.fn().mockResolvedValue([]),
			mergeCustomFonts: vi.fn().mockResolvedValue([]),
		},
	});
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: { load: vi.fn().mockResolvedValue([{}]) },
	});
});

async function completeStylesheet() {
	await vi.waitFor(() => expect(document.querySelector('link[id^="custom-font-"]')).not.toBeNull());
	document.querySelector('link[id^="custom-font-"]')!.dispatchEvent(new Event("load"));
}

describe("custom Google Fonts", () => {
	it("migrates legacy origin storage once after a successful shared write", async () => {
		localStorage.setItem("videtio_custom_fonts", JSON.stringify([font, { id: "broken" }]));
		const api = await import("./customFonts");
		await api.loadAllCustomFonts();
		expect(window.electronAPI.mergeCustomFonts).toHaveBeenCalledWith([font]);
		expect(localStorage.getItem("videtio_custom_fonts")).toBeNull();
		await api.loadAllCustomFonts();
		expect(window.electronAPI.mergeCustomFonts).toHaveBeenCalledTimes(1);
		expect(window.electronAPI.listCustomFonts).toHaveBeenCalledOnce();
	});
	it("keeps legacy data if migration cannot be written", async () => {
		localStorage.setItem("videtio_custom_fonts", JSON.stringify([font]));
		vi.mocked(window.electronAPI.mergeCustomFonts).mockRejectedValue(new Error("disk full"));
		const api = await import("./customFonts");
		await expect(api.loadAllCustomFonts()).rejects.toThrow("disk full");
		expect(localStorage.getItem("videtio_custom_fonts")).not.toBeNull();
	});
	it("waits for the stylesheet and publishes fonts added by another app instance", async () => {
		const api = await import("./customFonts");
		await api.loadAllCustomFonts();
		vi.mocked(window.electronAPI.listCustomFonts).mockResolvedValue([font]);
		const loading = api.loadAllCustomFonts();
		await vi.waitFor(() =>
			expect(document.querySelector('link[id^="custom-font-"]')).not.toBeNull(),
		);
		expect(document.fonts.load).not.toHaveBeenCalled();
		await completeStylesheet();
		await loading;
		expect(api.getCustomFonts()).toEqual([font]);
	});
	it("rejects a missing face and does not save a falsely loaded font", async () => {
		vi.mocked(document.fonts.load).mockResolvedValue([]);
		const api = await import("./customFonts");
		const loading = api.addCustomFont(font);
		const rejected = expect(loading).rejects.toThrow("Font is missing");
		await completeStylesheet();
		await rejected;
		expect(window.electronAPI.mergeCustomFonts).not.toHaveBeenCalled();
	});
	it("restores and loads embedded project definitions before returning", async () => {
		vi.mocked(window.electronAPI.mergeCustomFonts).mockResolvedValue([font]);
		const api = await import("./customFonts");
		const loading = api.restoreProjectFonts([font]);
		await completeStylesheet();
		await loading;
		expect(api.getCustomFonts()).toEqual([font]);
		await expect(
			api.restoreProjectFonts([{ ...font, importUrl: "https://evil.example/font" }]),
		).rejects.toThrow("invalid custom font");
	});
	it("accepts and normalizes complete Google Fonts import snippets", () => {
		const snippet =
			"@import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap');";
		expect(isValidGoogleFontsUrl(snippet)).toBe(true);
		expect(normalizeGoogleFontsImportUrl(snippet)).toBe(
			"https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap",
		);
		expect(parseFontFamilyFromImport(snippet)).toBe("Open Sans");
	});
});
