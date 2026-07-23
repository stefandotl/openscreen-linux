import { describe, expect, it } from "vitest";
import {
	resolvePreferredCaptureSource,
	toPreferredCaptureSource,
} from "./captureSourcePreferences";

const source = (
	id: string,
	name: string,
	displayId = "",
): {
	id: string;
	name: string;
	display_id: string;
	thumbnail: null;
	appIcon: null;
} => ({
	id,
	name,
	display_id: displayId,
	thumbnail: null,
	appIcon: null,
});

describe("capture source preferences", () => {
	it("serializes only the stable source identity", () => {
		expect(toPreferredCaptureSource(source("screen:1:0", "Display 1", "42"))).toEqual({
			id: "screen:1:0",
			name: "Display 1",
			displayId: "42",
			kind: "screen",
		});
	});

	it("restores a screen by display id when its capture id changed", () => {
		const available = [
			source("screen:4:0", "Display 1", "41"),
			source("screen:5:0", "Display 2", "42"),
		];

		expect(
			resolvePreferredCaptureSource(
				{
					id: "screen:1:0",
					name: "Old display name",
					displayId: "42",
					kind: "screen",
				},
				available,
			),
		).toBe(available[1]);
	});

	it("restores a uniquely named window but rejects ambiguous matches", () => {
		const preference = {
			id: "window:old:0",
			name: "Document",
			displayId: null,
			kind: "window" as const,
		};
		const unique = source("window:new:0", "Writer — Document");
		expect(resolvePreferredCaptureSource(preference, [unique])).toBe(unique);
		expect(
			resolvePreferredCaptureSource(preference, [
				unique,
				source("window:other:0", "Editor — Document"),
			]),
		).toBeNull();
	});

	it("does not substitute a different source when the saved one disappeared", () => {
		expect(
			resolvePreferredCaptureSource(
				{
					id: "screen:9:0",
					name: "Projector",
					displayId: "9",
					kind: "screen",
				},
				[source("screen:1:0", "Laptop", "1")],
			),
		).toBeNull();
	});
});
