import { RotateCcw } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { useScopedT } from "@/contexts/I18nContext";
import { MAX_WEBCAM_ZOOM } from "@/lib/webcamFraming";
import type { WebcamFraming } from "./types";

export function WebcamFramingControls({
	value,
	onChange,
	onCommit,
	onReset,
}: {
	value: WebcamFraming;
	onChange?: (value: WebcamFraming) => void;
	onCommit?: () => void;
	onReset?: () => void;
}) {
	const t = useScopedT("settings");
	return (
		<section
			className="mt-2 space-y-3 rounded-lg p-2 editor-control-surface"
			aria-label={t("layout.webcamFraming")}
		>
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-[10px] font-medium text-slate-300">{t("layout.webcamFraming")}</h3>
				<button
					type="button"
					onClick={onReset}
					className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"
					title={t("layout.resetWebcamFraming")}
					aria-label={t("layout.resetWebcamFraming")}
				>
					<RotateCcw className="h-3 w-3" />
				</button>
			</div>
			{(
				[
					{
						key: "zoom",
						label: t("layout.webcamZoom"),
						min: 1,
						max: MAX_WEBCAM_ZOOM,
						step: 0.05,
						display: `${value.zoom.toFixed(2)}×`,
					},
					{
						key: "x",
						label: t("layout.webcamPanX"),
						min: 0,
						max: 1,
						step: 0.01,
						display: `${Math.round(value.x * 100)}%`,
					},
					{
						key: "y",
						label: t("layout.webcamPanY"),
						min: 0,
						max: 1,
						step: 0.01,
						display: `${Math.round(value.y * 100)}%`,
					},
				] as const
			).map(({ key, label, min, max, step, display }) => (
				<div key={key}>
					<div className="mb-1.5 flex justify-between text-[10px] text-slate-400">
						<span>{label}</span>
						<span className="tabular-nums">{display}</span>
					</div>
					<Slider
						value={[value[key]]}
						onValueChange={([next]) => onChange?.({ ...value, [key]: next })}
						onValueCommit={() => onCommit?.()}
						min={min}
						max={max}
						step={step}
						aria-label={label}
					/>
				</div>
			))}
			<p className="text-[9px] leading-snug text-slate-500">
				{t("layout.webcamFramingDescription")}
			</p>
		</section>
	);
}
