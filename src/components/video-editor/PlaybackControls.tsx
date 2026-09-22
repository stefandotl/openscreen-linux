import { Gauge, Maximize, Minimize, Pause, Play } from "lucide-react";
import { useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { formatPreviewSpeedLabel } from "./previewSpeed";
import { DEFAULT_PREVIEW_SPEED, type PlaybackSpeed, PREVIEW_SPEED_OPTIONS } from "./types";

interface PlaybackControlsProps {
	isPlaying: boolean;
	currentTime: number;
	duration: number;
	scope?: "scene" | "project";
	showScopeSwitch?: boolean;
	projectSegments?: ProjectPlaybackRailSegment[];
	projectSceneMarkers?: ProjectPlaybackRailMarker[];
	onScopeChange?: (scope: "scene" | "project") => void;
	previewSpeed?: PlaybackSpeed;
	onPreviewSpeedChange?: (speed: PlaybackSpeed) => void;
	isFullscreen?: boolean;
	onToggleFullscreen?: () => void;
	onTogglePlayPause: () => void;
	onSeek: (time: number) => void;
}

export interface ProjectPlaybackRailSegment {
	sceneId: string;
	name: string;
	projectStartSeconds: number;
	projectEndSeconds: number;
}

export interface ProjectPlaybackRailMarker {
	sceneId: string;
	name: string;
	projectTimeSeconds: number;
	isPlayable: boolean;
}

export default function PlaybackControls({
	isPlaying,
	currentTime,
	duration,
	scope = "scene",
	showScopeSwitch = false,
	projectSegments = [],
	projectSceneMarkers = [],
	onScopeChange,
	previewSpeed = DEFAULT_PREVIEW_SPEED,
	onPreviewSpeedChange,
	isFullscreen = false,
	onToggleFullscreen,
	onTogglePlayPause,
	onSeek,
}: PlaybackControlsProps) {
	const t = useScopedT("common");
	const [isSpeedMenuOpen, setIsSpeedMenuOpen] = useState(false);

	function formatTime(seconds: number) {
		if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) return "0:00";
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${mins}:${secs.toString().padStart(2, "0")}`;
	}

	function handleSeekChange(e: React.ChangeEvent<HTMLInputElement>) {
		onSeek(parseFloat(e.target.value));
	}

	const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

	return (
		<div className="flex items-center gap-2 px-1 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 shadow-xl transition-all duration-300 hover:bg-black/70 hover:border-white/20">
			{showScopeSwitch && onScopeChange && (
				<div
					className="ml-0.5 flex rounded-full bg-white/[0.08] p-0.5"
					aria-label={t("playback.scope")}
				>
					{(["scene", "project"] as const).map((candidateScope) => (
						<button
							key={candidateScope}
							type="button"
							onClick={() => onScopeChange(candidateScope)}
							aria-pressed={scope === candidateScope}
							className={cn(
								"rounded-full px-2 py-1 text-[9px] font-semibold transition-colors",
								scope === candidateScope ? "bg-white text-black" : "text-white/50 hover:text-white",
							)}
						>
							{t(`playback.${candidateScope}`)}
						</button>
					))}
				</div>
			)}

			<Button
				onClick={onTogglePlayPause}
				size="icon"
				className={cn(
					"w-8 h-8 rounded-full transition-all duration-200 border border-white/10",
					isPlaying
						? "bg-white/10 text-white hover:bg-white/20"
						: "bg-white text-black hover:bg-white/90 hover:scale-105 shadow-[0_0_15px_rgba(255,255,255,0.3)]",
				)}
				aria-label={isPlaying ? t("playback.pause") : t("playback.play")}
			>
				{isPlaying ? (
					<Pause className="w-3.5 h-3.5 fill-current" />
				) : (
					<Play className="w-3.5 h-3.5 fill-current ml-0.5" />
				)}
			</Button>

			<span className="text-[9px] font-medium text-slate-300 tabular-nums w-[30px] text-right">
				{formatTime(currentTime)}
			</span>

			<div className="flex-1 relative h-6 flex items-center group">
				{/* Custom Track Background */}
				<div className="absolute left-0 right-0 h-0.5 bg-white/10 rounded-full overflow-hidden">
					<div className="h-full bg-[#34B27B] rounded-full" style={{ width: `${progress}%` }} />
				</div>

				{scope === "project" &&
					duration > 0 &&
					projectSegments.map((segment, index) => {
						const left = (segment.projectStartSeconds / duration) * 100;
						const width =
							((segment.projectEndSeconds - segment.projectStartSeconds) / duration) * 100;
						return (
							<div
								key={segment.sceneId}
								role="img"
								aria-label={t("playback.sceneSegment", { name: segment.name })}
								title={segment.name}
								className="absolute h-2.5 border-x border-white/25 bg-white/[0.035]"
								style={{ left: `${left}%`, width: `${width}%` }}
							>
								{index > 0 && (
									<span className="absolute -left-px top-[-3px] h-4 w-px bg-white/55" />
								)}
							</div>
						);
					})}

				{scope === "project" &&
					duration > 0 &&
					projectSceneMarkers
						.filter((marker) => !marker.isPlayable)
						.map((marker) => (
							<span
								key={marker.sceneId}
								role="img"
								aria-label={t("playback.emptyScene", { name: marker.name })}
								title={t("playback.emptyScene", { name: marker.name })}
								className="absolute top-1/2 h-3 w-1 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white/25 bg-black"
								style={{
									left: `${Math.max(
										0,
										Math.min(100, (marker.projectTimeSeconds / duration) * 100),
									)}%`,
								}}
							/>
						))}

				{/* Interactive Input */}
				<input
					type="range"
					min="0"
					max={duration || 100}
					value={currentTime}
					onChange={handleSeekChange}
					step="0.01"
					aria-label={
						scope === "project" ? t("playback.projectTimeline") : t("playback.sceneTimeline")
					}
					className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
				/>

				{/* Custom Thumb (visual only, follows progress) */}
				<div
					className="absolute w-2.5 h-2.5 bg-white rounded-full shadow-lg pointer-events-none group-hover:scale-125 transition-transform duration-100"
					style={{
						left: `${progress}%`,
						transform: "translateX(-50%)",
					}}
				/>
			</div>

			<span className="text-[9px] font-medium text-slate-500 tabular-nums w-[30px]">
				{formatTime(duration)}
			</span>

			{onToggleFullscreen && (
				<Button
					onClick={onToggleFullscreen}
					size="icon"
					variant="ghost"
					className="w-7 h-7 rounded-full transition-all duration-200 border border-transparent bg-transparent hover:bg-white/10 text-white hover:text-white hover:border-white/10 shrink-0 shadow-none ml-0.5"
					aria-label={isFullscreen ? t("playback.exitFullscreen") : t("playback.fullscreen")}
				>
					{isFullscreen ? (
						<Minimize className="w-3.5 h-3.5" />
					) : (
						<Maximize className="w-3.5 h-3.5" />
					)}
				</Button>
			)}

			{onPreviewSpeedChange && (
				<Popover open={isSpeedMenuOpen} onOpenChange={setIsSpeedMenuOpen}>
					<PopoverTrigger asChild>
						<Button
							size="icon"
							variant="ghost"
							className="h-7 w-auto min-w-7 px-1.5 gap-1 rounded-full transition-all duration-200 border border-transparent bg-transparent hover:bg-white/10 text-white hover:text-white hover:border-white/10 shrink-0 shadow-none ml-0.5"
							aria-label={t("playback.speed")}
							title={t("playback.speed")}
						>
							<Gauge className="w-3.5 h-3.5" />
							<span className="text-[9px] font-semibold tabular-nums">
								{formatPreviewSpeedLabel(previewSpeed)}
							</span>
						</Button>
					</PopoverTrigger>
					<PopoverContent
						side="top"
						align="end"
						sideOffset={8}
						className="w-auto min-w-[60px] rounded-xl border border-white/10 bg-[#1a1a1c] p-1 shadow-xl"
					>
						{PREVIEW_SPEED_OPTIONS.map((option) => (
							<button
								key={option}
								type="button"
								onClick={() => {
									onPreviewSpeedChange(option);
									setIsSpeedMenuOpen(false);
								}}
								aria-pressed={option === previewSpeed}
								className={cn(
									"block w-full rounded-md px-3 py-1 text-left text-[11px] font-semibold tabular-nums transition-colors",
									option === previewSpeed
										? "bg-white text-black"
										: "text-white/70 hover:bg-white/10 hover:text-white",
								)}
							>
								{formatPreviewSpeedLabel(option)}
							</button>
						))}
					</PopoverContent>
				</Popover>
			)}
		</div>
	);
}
