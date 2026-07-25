import { describe, expect, it } from "vitest";
import { resolveMacScreenAccessProbe } from "./macScreenAccess";

describe("resolveMacScreenAccessProbe", () => {
	it("accepts an explicit macOS grant without requiring enumerated sources", () => {
		expect(resolveMacScreenAccessProbe("granted", 0)).toEqual({
			granted: true,
			status: "granted",
		});
	});

	it("accepts usable screen sources when the reported TCC status is stale", () => {
		expect(resolveMacScreenAccessProbe("denied", 1)).toEqual({
			granted: true,
			status: "granted",
		});
	});

	it.each([
		"denied",
		"restricted",
		"unknown",
	])("preserves the %s status when no screen source is available", (status) => {
		expect(resolveMacScreenAccessProbe(status, 0)).toEqual({
			granted: false,
			status,
		});
	});
});
