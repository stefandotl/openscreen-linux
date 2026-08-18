import type { TrimRegion } from "./types";

interface MergeTrimRegionOptions {
	/** Keep this ID when its region becomes part of a merged range. */
	preferredId?: string;
}

/**
 * Merges user-created trims that overlap or touch exactly. Scene-split trims stay
 * independent because their IDs and locked ranges encode scene ownership.
 */
export function mergeConnectedTrimRegions(
	regions: readonly TrimRegion[],
	options: MergeTrimRegionOptions = {},
): TrimRegion[] {
	const lockedRegions = regions
		.filter((region) => region.source === "scene-split")
		.map((region) => ({ ...region }));
	const editableRegions = regions
		.filter((region) => region.source !== "scene-split")
		.map((region) => ({ ...region }))
		.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
	const merged: TrimRegion[] = [];

	for (const region of editableRegions) {
		const previous = merged.at(-1);
		if (!previous || region.startMs > previous.endMs) {
			merged.push(region);
			continue;
		}

		previous.endMs = Math.max(previous.endMs, region.endMs);
		if (region.id === options.preferredId) {
			previous.id = region.id;
		}
	}

	return [...merged, ...lockedRegions].sort(
		(a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id),
	);
}
