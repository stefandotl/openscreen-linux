import type { PreferredCaptureSource } from "@/lib/recordingPreferences";

export interface AvailableCaptureSource {
	id: string;
	name: string;
	display_id: string;
	thumbnail?: unknown;
	appIcon?: unknown;
}

function normalizedSourceName(source: Pick<AvailableCaptureSource, "id" | "name">): string {
	const name =
		source.id.startsWith("window:") && source.name.includes(" — ")
			? source.name.split(" — ")[1] || source.name
			: source.name;
	return name.trim().toLocaleLowerCase();
}

export function toPreferredCaptureSource(
	source: Pick<AvailableCaptureSource, "id" | "name" | "display_id">,
): PreferredCaptureSource {
	return {
		id: source.id,
		name: source.name,
		displayId: source.display_id || null,
		kind: source.id.startsWith("window:") ? "window" : "screen",
	};
}

export function resolvePreferredCaptureSource<T extends AvailableCaptureSource>(
	preference: PreferredCaptureSource,
	sources: T[],
): T | null {
	const exact = sources.find((source) => source.id === preference.id);
	if (exact) return exact;

	const sameKind = sources.filter(
		(source) => source.id.startsWith("window:") === (preference.kind === "window"),
	);
	if (preference.kind === "screen" && preference.displayId) {
		const displayMatch = sameKind.find((source) => source.display_id === preference.displayId);
		if (displayMatch) return displayMatch;
	}

	const normalizedPreferenceName = normalizedSourceName({
		id: preference.id,
		name: preference.name,
	});
	const nameMatches = sameKind.filter(
		(source) => normalizedSourceName(source) === normalizedPreferenceName,
	);
	return nameMatches.length === 1 ? nameMatches[0]! : null;
}
