import { Trash2 } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import type { AudioRegion } from "./audioRegions";

export function AudioClipSettings({
	clip,
	onChange,
	onDelete,
}: {
	clip: AudioRegion;
	onChange: (update: Partial<Pick<AudioRegion, "volume" | "fadeInMs" | "fadeOutMs">>) => void;
	onDelete: () => void;
}) {
	const t = useScopedT("timeline");
	return (
		<div
			className="flex flex-wrap items-center gap-4 px-3 py-2 border-b border-white/10 text-xs bg-[#15161c]"
			aria-label={t("tracks.audio")}
		>
			<span className="max-w-40 truncate" title={clip.name}>
				{clip.name}
			</span>
			<label className="flex items-center gap-2">
				{t("audio.volume")}
				<input
					type="range"
					min="0"
					max="100"
					value={Math.round(clip.volume * 100)}
					onChange={(event) => onChange({ volume: Number(event.target.value) / 100 })}
				/>
				<span>{Math.round(clip.volume * 100)}%</span>
			</label>
			{(["fadeInMs", "fadeOutMs"] as const).map((key) => (
				<label key={key} className="flex items-center gap-2">
					{t(`audio.${key}`)}
					<input
						className="w-16 bg-white/10 rounded px-2 py-1"
						type="number"
						min="0"
						max={(clip.endMs - clip.startMs) / 1000}
						step="0.1"
						value={clip[key] / 1000}
						onChange={(event) => {
							const value = event.target.valueAsNumber;
							if (Number.isFinite(value))
								onChange({ [key]: Math.max(0, Math.min(clip.endMs - clip.startMs, value * 1000)) });
						}}
					/>
					s
				</label>
			))}
			<button
				type="button"
				onClick={onDelete}
				title={t("audio.remove")}
				aria-label={t("audio.remove")}
				className="p-1 text-red-400"
			>
				<Trash2 className="w-4 h-4" />
			</button>
		</div>
	);
}
