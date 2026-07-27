import { describe, expect, it } from "vitest";
import { uploadedCursorAssets } from "./uploadedCursorAssets";

describe("uploaded cursor assets", () => {
	it("provides a bundled fallback for every explicitly supported preview cursor", () => {
		for (const key of [
			"arrow",
			"text",
			"pointer",
			"crosshair",
			"open-hand",
			"closed-hand",
			"resize-ew",
			"resize-ns",
			"not-allowed",
		] as const) {
			expect(uploadedCursorAssets[key], key).toBeDefined();
		}
	});
});
