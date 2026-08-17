import { describe, expect, it, vi } from "vitest";
import { openRecordingsFolder } from "./recordingsFolder";

describe("openRecordingsFolder", () => {
	it("ensures and opens the configured recordings directory", async () => {
		const ensureDirectory = vi.fn().mockResolvedValue(undefined);
		const openPath = vi.fn().mockResolvedValue("");

		await expect(
			openRecordingsFolder("/app-data/recordings", { ensureDirectory, openPath }),
		).resolves.toEqual({ success: true });
		expect(ensureDirectory).toHaveBeenCalledWith("/app-data/recordings");
		expect(openPath).toHaveBeenCalledWith("/app-data/recordings");
	});

	it("reports the shell error instead of claiming the folder opened", async () => {
		const ensureDirectory = vi.fn().mockResolvedValue(undefined);
		const openPath = vi.fn().mockResolvedValue("No application is registered for directories");

		await expect(
			openRecordingsFolder("/app-data/recordings", { ensureDirectory, openPath }),
		).resolves.toEqual({
			success: false,
			error: "No application is registered for directories",
		});
	});

	it("does not open the folder when creating it fails", async () => {
		const ensureDirectory = vi.fn().mockRejectedValue(new Error("Permission denied"));
		const openPath = vi.fn();

		await expect(
			openRecordingsFolder("/app-data/recordings", { ensureDirectory, openPath }),
		).resolves.toEqual({ success: false, error: "Permission denied" });
		expect(openPath).not.toHaveBeenCalled();
	});
});
