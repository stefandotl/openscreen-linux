// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { patchWebmDurationOnDisk } from "./webm-duration";

it("patches a streamed recording atomically while preserving subsequent cluster headers", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "videtio-duration-"));
	try {
		const filePath = path.join(directory, "recording.webm");
		const clusters = Buffer.from(
			"1f43b67501ffffffffffffffe781001f43b67501ffffffffffffffe78101",
			"hex",
		);
		const header = Buffer.from("1853806701ffffffffffffff1549a966872ad7b1830f4240", "hex");
		await writeFile(filePath, Buffer.concat([header, clusters]));
		expect(await patchWebmDurationOnDisk(filePath, 2000)).toEqual({ patched: true });
		const bytes = await readFile(filePath);
		expect(bytes.subarray(-clusters.length)).toEqual(clusters);
		expect(await patchWebmDurationOnDisk(filePath, 2000)).toEqual({
			patched: false,
			reason: "already-valid",
		});
		await expect(readFile(`${filePath}.duration-patch.tmp`)).rejects.toThrow();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
