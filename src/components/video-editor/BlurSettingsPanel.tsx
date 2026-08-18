import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useScopedT } from "@/contexts/I18nContext";
import { getBlurOverlayColor } from "@/lib/blurEffects";
import { cn } from "@/lib/utils";
import {
	type AnnotationRegion,
	type BlurColor,
	type BlurData,
	type BlurShape,
	type BlurType,
	DEFAULT_BLUR_BLOCK_SIZE,
	DEFAULT_BLUR_DATA,
	DEFAULT_BLUR_INTENSITY,
	MAX_BLUR_BLOCK_SIZE,
	MAX_BLUR_INTENSITY,
	MIN_BLUR_BLOCK_SIZE,
	MIN_BLUR_INTENSITY,
} from "./types";

interface BlurSettingsPanelProps {
	blurRegion: AnnotationRegion;
	onBlurDataChange: (blurData: BlurData) => void;
	onBlurDataCommit?: () => void;
	onDelete: () => void;
}

export function BlurSettingsPanel({
	blurRegion,
	onBlurDataChange,
	onBlurDataCommit,
	onDelete,
}: BlurSettingsPanelProps) {
	const t = useScopedT("settings");

	const blurShapeOptions: Array<{ value: BlurShape; labelKey: string }> = [
		{ value: "rectangle", labelKey: "blurShapeRectangle" },
		{ value: "oval", labelKey: "blurShapeOval" },
	];
	const blurTypeOptions: Array<{ value: BlurType; labelKey: string }> = [
		{ value: "blur", labelKey: "blurTypeBlur" },
		{ value: "mosaic", labelKey: "blurTypeMosaic" },
	];
	const blurColorOptions: Array<{ value: BlurColor; labelKey: string }> = [
		{ value: "white", labelKey: "blurColorWhite" },
		{ value: "black", labelKey: "blurColorBlack" },
	];
	const activeBlurType = blurRegion.blurData?.type ?? DEFAULT_BLUR_DATA.type;

	return (
		<div className="min-w-0 p-4 flex flex-col h-full overflow-y-auto custom-scrollbar">
			<div className="mb-3">
				<div className="mb-4">
					<span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
						{t("annotation.blurType")}
					</span>
					<div className="mt-1 text-xl font-semibold text-slate-100">
						{t("annotation.typeBlur")}
					</div>
				</div>

				<div className="grid grid-cols-2 gap-2 mb-4">
					{blurTypeOptions.map((option) => {
						const isActive = activeBlurType === option.value;
						return (
							<button
								key={option.value}
								onClick={() => {
									onBlurDataChange({
										...DEFAULT_BLUR_DATA,
										...blurRegion.blurData,
										type: option.value,
									});
									requestAnimationFrame(() => onBlurDataCommit?.());
								}}
								className={cn(
									"h-10 rounded-lg border text-xs font-medium transition-all",
									isActive
										? "bg-[#34B27B] border-[#34B27B] text-white"
										: "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:border-white/20",
								)}
							>
								{t(`annotation.${option.labelKey}`)}
							</button>
						);
					})}
				</div>

				<div className="grid grid-cols-2 gap-2">
					{blurShapeOptions.map((shape) => {
						const activeShape = blurRegion.blurData?.shape || DEFAULT_BLUR_DATA.shape;
						const isActive = activeShape === shape.value;
						return (
							<button
								key={shape.value}
								onClick={() => {
									const nextBlurData: BlurData = {
										...DEFAULT_BLUR_DATA,
										...blurRegion.blurData,
										shape: shape.value,
									};
									onBlurDataChange(nextBlurData);
									requestAnimationFrame(() => {
										onBlurDataCommit?.();
									});
								}}
								className={cn(
									"h-12 rounded-lg border flex items-center justify-center transition-all p-2 gap-2",
									isActive
										? "bg-[#34B27B] border-[#34B27B]"
										: "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20",
								)}
							>
								{shape.value === "rectangle" && (
									<div
										className={cn(
											"w-8 h-5 border-2 rounded-sm",
											isActive ? "border-white" : "border-slate-400",
										)}
									/>
								)}
								{shape.value === "oval" && (
									<div
										className={cn(
											"w-8 h-5 border-2 rounded-full",
											isActive ? "border-white" : "border-slate-400",
										)}
									/>
								)}
								<span className="text-[10px] leading-none font-medium">
									{t(`annotation.${shape.labelKey}`)}
								</span>
							</button>
						);
					})}
				</div>

				<div className="mt-4">
					<label className="text-xs font-medium text-slate-300 mb-2 block">
						{t("annotation.blurColor")}
					</label>
					<div className="grid grid-cols-2 gap-2">
						{blurColorOptions.map((option) => {
							const activeColor = blurRegion.blurData?.color ?? DEFAULT_BLUR_DATA.color;
							const isActive = activeColor === option.value;
							return (
								<button
									key={option.value}
									onClick={() => {
										const nextBlurData: BlurData = {
											...DEFAULT_BLUR_DATA,
											...blurRegion.blurData,
											color: option.value,
										};
										onBlurDataChange(nextBlurData);
										requestAnimationFrame(() => {
											onBlurDataCommit?.();
										});
									}}
									className={cn(
										"h-10 rounded-lg border flex items-center gap-2 px-3 transition-all",
										isActive
											? "bg-[#34B27B] border-[#34B27B]"
											: "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20",
									)}
								>
									<div
										className="w-4 h-4 rounded-full border border-white/20"
										style={{
											backgroundColor: getBlurOverlayColor({
												...DEFAULT_BLUR_DATA,
												...blurRegion.blurData,
												color: option.value,
											}),
										}}
									/>
									<span className="text-xs text-slate-200">
										{t(`annotation.${option.labelKey}`)}
									</span>
								</button>
							);
						})}
					</div>
				</div>

				<div className="mt-4 p-3 rounded-lg editor-control-surface">
					<div className="flex items-center justify-between mb-2">
						<span className="text-xs font-medium text-slate-300">
							{t(
								activeBlurType === "mosaic"
									? "annotation.mosaicBlockSize"
									: "annotation.blurIntensity",
							)}
						</span>
						<span className="text-[10px] text-slate-400 font-mono">
							{Math.round(
								activeBlurType === "mosaic"
									? (blurRegion.blurData?.blockSize ?? DEFAULT_BLUR_BLOCK_SIZE)
									: (blurRegion.blurData?.intensity ?? DEFAULT_BLUR_INTENSITY),
							)}
							px
						</span>
					</div>
					<Slider
						value={[
							activeBlurType === "mosaic"
								? (blurRegion.blurData?.blockSize ?? DEFAULT_BLUR_BLOCK_SIZE)
								: (blurRegion.blurData?.intensity ?? DEFAULT_BLUR_INTENSITY),
						]}
						onValueChange={(values) => {
							onBlurDataChange({
								...DEFAULT_BLUR_DATA,
								...blurRegion.blurData,
								type: activeBlurType,
								...(activeBlurType === "mosaic"
									? { blockSize: values[0] }
									: { intensity: values[0] }),
							});
						}}
						onValueCommit={() => onBlurDataCommit?.()}
						min={activeBlurType === "mosaic" ? MIN_BLUR_BLOCK_SIZE : MIN_BLUR_INTENSITY}
						max={activeBlurType === "mosaic" ? MAX_BLUR_BLOCK_SIZE : MAX_BLUR_INTENSITY}
						step={1}
						className="w-full [&_[role=slider]]:bg-[#34B27B] [&_[role=slider]]:border-[#34B27B] [&_[role=slider]]:h-3 [&_[role=slider]]:w-3"
					/>
				</div>

				<Button
					onClick={onDelete}
					variant="destructive"
					size="sm"
					className="w-full gap-2 bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:border-red-500/30 transition-all mt-4"
				>
					<Trash2 className="w-4 h-4" />
					{t("annotation.deleteAnnotation")}
				</Button>
			</div>
		</div>
	);
}
