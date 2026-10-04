import fs from "node:fs/promises";
import { patchWebmDuration } from "../../src/lib/webmDuration";

export type DurationPatchResult =
	| { patched: true }
	| { patched: false; reason: "no-section" | "already-valid" | "io-error" };

/**
 * Patch the WebM Duration header on a finalized recording file.
 *
 * MediaRecorder writes WebM with no Duration EBML element, and the streaming-to-disk
 * path never holds the blob so the old `fixWebmDuration(blob, durationMs)` can't run.
 * Patching on disk after `WriteStream.end()` gives the editor a real duration instead of `N/A`.
 *
 * Atomic: writes to `<filePath>.duration-patch.tmp` and renames in place, so a mid-rewrite
 * crash leaves the original intact. Best-effort: any read/parse/write failure logs and returns
 * a non-`patched` result rather than throwing; the file still plays without the patch (decoders
 * walk frames sequentially), only the seek bar and timeline break.
 *
 * Reads the whole file into a main-process Buffer, off the renderer so it dodges V8's heap cap.
 */
export async function patchWebmDurationOnDisk(
	filePath: string,
	durationMs: number,
): Promise<DurationPatchResult> {
	try {
		const fileBytes = await fs.readFile(filePath);
		const result = patchWebmDuration(fileBytes, durationMs);
		if (!result.patched) {
			const { reason } = result;
			if (reason === "no-section") {
				console.warn(
					`[webm-duration] no Segment/Info section in ${filePath}; file may be truncated`,
				);
			}
			return { patched: false, reason };
		}

		const tmpPath = `${filePath}.duration-patch.tmp`;
		try {
			await fs.writeFile(tmpPath, result.bytes);
			await fs.rename(tmpPath, filePath);
			return { patched: true };
		} catch (writeError) {
			console.error(`[webm-duration] failed to write patched ${filePath}:`, writeError);
			// Clean up the temp file; the original is untouched since the rename never ran.
			await fs.unlink(tmpPath).catch(() => undefined);
			return { patched: false, reason: "io-error" };
		}
	} catch (error) {
		console.error(`[webm-duration] failed to patch ${filePath}:`, error);
		return { patched: false, reason: "io-error" };
	}
}
