import type { TrimRegion } from "./types";

interface MergeTrimRegionOptions {
	/** Keep this ID when its region becomes part of a merged range. */
	preferredId?: string;
	/** Explicitly dragging one trim into another also joins exact edge contact. */
	mergeTouching?: boolean;
}

/**
 * Merges overlapping user trims. Exact edge contact remains independently editable
 * until the user explicitly drags one trim into its neighbours. Scene-split trims
 * stay independent because their locked ranges encode scene ownership.
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
		if (
			!previous ||
			(region.startMs >= previous.endMs &&
				!(
					options.mergeTouching &&
					region.startMs === previous.endMs &&
					(previous.id === options.preferredId || region.id === options.preferredId)
				))
		) {
			merged.push(region);
			continue;
		}

		previous.endMs = Math.max(previous.endMs, region.endMs);
		if (region.id === options.preferredId) {
			previous.id = region.id;
		}
		while (
			options.mergeTouching &&
			merged.length > 1 &&
			merged.at(-1)?.id === options.preferredId &&
			merged[merged.length - 2]!.endMs >= merged.at(-1)!.startMs
		) {
			const joined = merged.pop()!;
			const earlier = merged.at(-1)!;
			earlier.endMs = Math.max(earlier.endMs, joined.endMs);
			earlier.id = joined.id;
		}
	}

	return [...merged, ...lockedRegions].sort(
		(a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id),
	);
}
