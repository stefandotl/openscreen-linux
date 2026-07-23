import { beforeEach, describe, expect, it } from "vitest";
import {
	getCustomFonts,
	isValidGoogleFontsUrl,
	normalizeGoogleFontsImportUrl,
	parseFontFamilyFromImport,
	saveCustomFonts,
} from "./customFonts";

describe("custom Google Fonts persistence", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("round-trips saved fonts across module consumers", () => {
		const fonts = [
			{
				id: "roboto-1",
				name: "Roboto",
				fontFamily: "Roboto",
				importUrl:
					"https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,400;0,700;1,400&display=swap",
			},
		];

		saveCustomFonts(fonts);

		expect(getCustomFonts()).toEqual(fonts);
	});

	it("accepts and normalizes the complete Google Fonts @import snippet", () => {
		const snippet =
			"@import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap');";

		expect(isValidGoogleFontsUrl(snippet)).toBe(true);
		expect(normalizeGoogleFontsImportUrl(snippet)).toBe(
			"https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap",
		);
		expect(parseFontFamilyFromImport(snippet)).toBe("Open Sans");
	});

	it("ignores malformed persisted entries without discarding valid fonts", () => {
		localStorage.setItem(
			"openscreen_custom_fonts",
			JSON.stringify([
				{
					id: "valid-1",
					name: "Valid",
					fontFamily: "Valid",
					importUrl: "https://fonts.googleapis.com/css2?family=Valid&display=swap",
				},
				{ id: "broken", name: "Broken" },
			]),
		);

		expect(getCustomFonts()).toHaveLength(1);
		expect(getCustomFonts()[0]?.id).toBe("valid-1");
	});
});
