import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import {
	type AiCutMode,
	type AiCutModel,
	type AiCutSuggestion,
	type AiCutUnit,
	buildAiCutUnits,
} from "@/lib/aiCut";
import { reusableSourceTranscript, type SourceTranscript } from "@/lib/captioning/sourceTranscript";
import { transcribeSourceVideo } from "@/lib/captioning/transcribeSourceVideo";
import type { OpenRouterSettings, OpenRouterSettingsUpdate } from "@/lib/openRouter";
import { DEFAULT_SILENCE_DETECTION_SETTINGS } from "@/lib/silenceDetection";
import { OpenRouterSettingsDialog } from "./OpenRouterSettingsDialog";
import { TranscriptionModelSelection } from "./TranscriptionModelSelection";
import type { TrimRegion } from "./types";

interface Props {
	videoPath: string;
	durationMs: number;
	trimRegions: TrimRegion[];
	sourceTranscript?: SourceTranscript | null;
	onTranscriptReady?(transcript: SourceTranscript): void;
	onClose(): void;
	onApply(suggestions: AiCutSuggestion[]): void;
}
const inputClass = "w-full rounded-md border border-white/15 bg-black/20 px-3 py-2 text-sm";
const time = (ms: number) =>
	`${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(2).padStart(5, "0")}`;

export function AiCutDialog({
	videoPath,
	durationMs,
	trimRegions,
	sourceTranscript,
	onTranscriptReady,
	onClose,
	onApply,
}: Props) {
	const existingTranscript = reusableSourceTranscript(
		sourceTranscript,
		videoPath,
		durationMs / 1000,
	);
	const [useExisting, setUseExisting] = useState(Boolean(existingTranscript));
	const transcriptionAbort = useRef<AbortController | null>(null);
	const t = useScopedT("editor");
	const { locale } = useI18n();
	const [settings, setSettings] = useState<OpenRouterSettings | null>(null);
	const [model, setModel] = useState("");
	const [showSettings, setShowSettings] = useState(false);
	const [models, setModels] = useState<AiCutModel[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [saved, setSaved] = useState(false);
	const [saving, setSaving] = useState(false);
	const [speechSaving, setSpeechSaving] = useState(false);
	const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
	const [mode, setMode] = useState<AiCutMode>("cleanup");
	const [instructions, setInstructions] = useState("");
	const [phase, setPhase] = useState("");
	const [error, setError] = useState("");
	const [suggestions, setSuggestions] = useState<AiCutSuggestion[] | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [preview, setPreview] = useState<AiCutSuggestion | null>(null);
	const video = useRef<HTMLVideoElement>(null);
	const previewCut = useRef(false);
	const mounted = useRef(true);
	const requestId = useRef<string | null>(null);
	const units = useRef<AiCutUnit[] | null>(null);
	const preparedTranscript = useRef<SourceTranscript | null>(null);
	const busy = Boolean(phase);

	useEffect(() => {
		if (!preview) return;
		let frame = 0;
		function tick() {
			const player = video.current;
			if (player && preview && !player.paused && !player.seeking) {
				if (
					previewCut.current &&
					player.currentTime >= preview.startMs / 1000 &&
					player.currentTime < preview.endMs / 1000
				)
					player.currentTime = preview.endMs / 1000;
				if (player.currentTime >= preview.endMs / 1000 + 2) player.pause();
			}
			frame = requestAnimationFrame(tick);
		}
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [preview]);

	useEffect(() => {
		mounted.current = true;
		window.electronAPI.openRouter
			.getSettings()
			.then((value) => {
				if (!mounted.current) return;
				setSettings(value);
				setModel(value.model);
				setModelSettingsOpen(!value.hasApiKey || !value.model);
			})
			.catch((error) => {
				if (mounted.current) setError(String(error));
			});
		return () => {
			mounted.current = false;
			transcriptionAbort.current?.abort();
			if (requestId.current)
				void window.electronAPI.aiCut.cancel(requestId.current).catch(() => {
					// The editor may already have been destroyed during application shutdown.
				});
		};
	}, []);

	async function persist() {
		setSaving(true);
		setSaved(false);
		try {
			const value = await window.electronAPI.openRouter.updateSettings({
				model: model.trim(),
			});
			if (mounted.current) {
				setSettings(value);
				setSaved(true);
			}
			return value;
		} finally {
			if (mounted.current) setSaving(false);
		}
	}
	function saveOnBlur() {
		if (settings && model.trim() !== settings.model)
			void persist().catch((error) => setError(String(error)));
	}
	async function selectTranscription(update: OpenRouterSettingsUpdate) {
		setSpeechSaving(true);
		setError("");
		try {
			const value = await window.electronAPI.openRouter.updateSettings(update);
			if (mounted.current) {
				setSettings(value);
				units.current = null;
				preparedTranscript.current = null;
				setSuggestions(null);
			}
		} catch (error) {
			if (mounted.current) setError(String(error));
		} finally {
			if (mounted.current) setSpeechSaving(false);
		}
	}
	async function analyze() {
		if (requestId.current) return;
		const id = crypto.randomUUID();
		requestId.current = id;
		const controller = new AbortController();
		transcriptionAbort.current = controller;
		setError("");
		setSuggestions(null);
		setPreview(null);
		setPhase(t("aiCut.preparing"));
		try {
			const configured = await persist();
			if (!configured.hasApiKey || !configured.model) throw new Error(t("aiCut.configure"));
			if (!mounted.current || requestId.current !== id) return;
			if (!units.current) {
				const reused = useExisting ? existingTranscript : preparedTranscript.current;
				const transcript =
					reused ??
					(await transcribeSourceVideo(videoPath, {
						engine: configured.captionEngine,
						model: configured.transcriptionModel,
						signal: controller.signal,
						sourceDurationSec: durationMs / 1000,
						onStatus: (status) => {
							if (mounted.current && requestId.current === id)
								setPhase(
									status.phase === "transcribe"
										? t("autoCaptions.transcribing")
										: t(
												configured.captionEngine === "whisper-tiny"
													? "autoCaptions.loadingWhisperModel"
													: "autoCaptions.loadingModel",
											),
								);
						},
					}));
				if (!mounted.current || requestId.current !== id) return;
				if (transcript.truncated) throw new Error(t("aiCut.truncated"));
				if (!transcript.segments.length) throw new Error(t("aiCut.noSpeech"));
				preparedTranscript.current = transcript;
				if (!reused) onTranscriptReady?.(transcript);
				setPhase(t("aiCut.pauses"));
				const silence = await window.electronAPI.detectSilence(
					videoPath,
					DEFAULT_SILENCE_DETECTION_SETTINGS,
					durationMs,
				);
				if (!silence.success) throw new Error(silence.error || silence.message);
				if (!mounted.current || requestId.current !== id) return;
				units.current = buildAiCutUnits(
					transcript.segments,
					silence.regions,
					trimRegions,
					durationMs,
				);
			}
			setPhase(t("aiCut.analyzing"));
			const result = await window.electronAPI.aiCut.analyze({
				requestId: id,
				mode,
				instructions,
				language: locale,
				durationMs,
				existingTrims: trimRegions.map(({ startMs, endMs }) => ({ startMs, endMs })),
				units: units.current,
			});
			if (!mounted.current || requestId.current !== id) return;
			setSuggestions(result);
			setSelected(new Set(result.map((item) => item.id)));
		} catch (error) {
			if (mounted.current && requestId.current === id)
				setError(error instanceof Error ? error.message : String(error));
		} finally {
			if (requestId.current === id) {
				requestId.current = null;
				transcriptionAbort.current = null;
				if (mounted.current) setPhase("");
			}
		}
	}
	async function refreshModels() {
		setLoadingModels(true);
		setError("");
		try {
			const result = await window.electronAPI.openRouter.listAiCutModels();
			if (mounted.current) setModels(result);
		} catch (error) {
			if (mounted.current) setError(String(error));
		} finally {
			if (mounted.current) setLoadingModels(false);
		}
	}
	function play(item: AiCutSuggestion, cut: boolean) {
		setPreview(item);
		previewCut.current = cut;
		const player = video.current;
		if (player) {
			player.currentTime = Math.max(0, item.startMs / 1000 - 2);
			void player.play().catch((error) => setError(String(error)));
		}
	}
	const chosen = suggestions?.filter((item) => selected.has(item.id)) ?? [];
	const removedSeconds = chosen.reduce((sum, item) => sum + item.endMs - item.startMs, 0) / 1000;

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto bg-[#151519] text-slate-100 border-white/10">
				<DialogHeader>
					<DialogTitle>{t("aiCut.title")}</DialogTitle>
					<DialogDescription>{t("aiCut.description")}</DialogDescription>
				</DialogHeader>
				<details
					open={modelSettingsOpen}
					onToggle={(event) => setModelSettingsOpen(event.currentTarget.open)}
					className="rounded-lg border border-white/10 p-3"
				>
					<summary className="cursor-pointer text-sm">AI Cut · {t("aiCut.model")}</summary>
					<fieldset disabled={busy || !settings} className="grid gap-3 mt-3 sm:grid-cols-2">
						<label className="text-sm space-y-1">
							<span>{t("aiCut.model")}</span>
							<input
								list="ai-cut-models"
								className={inputClass}
								value={model}
								placeholder="provider/model"
								onChange={(event) => {
									setModel(event.target.value);
									setSaved(false);
								}}
								onBlur={saveOnBlur}
							/>
							<datalist id="ai-cut-models">
								{models.map((item) => (
									<option key={item.id} value={item.id}>
										{item.name}
									</option>
								))}
							</datalist>
						</label>
						<div className="flex flex-wrap gap-2 sm:col-span-2 items-center">
							<Button
								variant="outline"
								size="sm"
								onClick={() => void refreshModels()}
								disabled={loadingModels}
							>
								{t(loadingModels ? "aiCut.loadingModels" : "aiCut.loadModels")}
							</Button>
							<Button variant="outline" size="sm" onClick={() => setShowSettings(true)}>
								{t("openRouter.title")}
							</Button>
							<span role="status" className="text-xs text-emerald-400">
								{saving ? t("aiCut.preparing") : saved ? t("aiCut.saved") : ""}
							</span>
						</div>
					</fieldset>
				</details>
				<fieldset
					disabled={busy || speechSaving || !settings}
					className="rounded-lg border border-white/10 p-3 space-y-3"
				>
					<p className="text-sm font-medium">{t("aiCut.transcript")}</p>
					{existingTranscript ? (
						<>
							<label className="flex gap-2 items-center text-sm">
								<input
									type="radio"
									name="ai-cut-transcript"
									checked={useExisting}
									onChange={() => {
										setUseExisting(true);
										preparedTranscript.current = null;
										units.current = null;
										setSuggestions(null);
									}}
								/>
								{t("aiCut.reuseTranscript", {
									model:
										existingTranscript.model ??
										(existingTranscript.engine === "parakeet" ? "Parakeet" : "Whisper Tiny"),
								})}
							</label>
							<label className="flex gap-2 items-center text-sm">
								<input
									type="radio"
									name="ai-cut-transcript"
									checked={!useExisting}
									onChange={() => {
										setUseExisting(false);
										preparedTranscript.current = null;
										units.current = null;
										setSuggestions(null);
									}}
								/>
								{t("aiCut.newTranscript")}
							</label>
						</>
					) : (
						<p className="text-xs text-slate-400">{t("aiCut.missingTranscript")}</p>
					)}
					{(!useExisting || !existingTranscript) && (
						<TranscriptionModelSelection
							settings={settings}
							disabled={busy || speechSaving}
							onSelect={(update) => void selectTranscription(update)}
							onSettings={() => setShowSettings(true)}
						/>
					)}
				</fieldset>
				<fieldset disabled={busy} className="space-y-3">
					<div className="flex flex-wrap gap-2">
						{(["cleanup", "tighten", "custom"] as const).map((value) => (
							<Button
								key={value}
								variant={mode === value ? "default" : "outline"}
								size="sm"
								aria-pressed={mode === value}
								onClick={() => setMode(value)}
							>
								{t(`aiCut.${value}`)}
							</Button>
						))}
					</div>
					<p className="text-xs text-slate-400">{t(`aiCut.${mode}Help`)}</p>
					{mode === "custom" && (
						<textarea
							aria-label={t("aiCut.instructions")}
							className={inputClass}
							rows={3}
							maxLength={8000}
							value={instructions}
							onChange={(event) => setInstructions(event.target.value)}
							placeholder={t("aiCut.instructions")}
						/>
					)}
				</fieldset>
				<p className="text-xs text-slate-400">{t("aiCut.privacy")}</p>
				<div className="flex items-center gap-3">
					<Button
						disabled={
							busy ||
							speechSaving ||
							!settings ||
							!model.trim() ||
							!settings.hasApiKey ||
							(mode === "custom" && !instructions.trim())
						}
						onClick={() => void analyze()}
					>
						{t("aiCut.analyze")}
					</Button>
					<span role="status" className="text-sm text-violet-300">
						{phase}
					</span>
				</div>
				{error && (
					<p role="alert" className="rounded-md bg-red-500/10 p-3 text-sm text-red-300 break-words">
						{error}
					</p>
				)}
				{suggestions && (
					<section className="space-y-3" aria-label={t("aiCut.review")}>
						<p className="text-sm">
							{suggestions.length
								? t("aiCut.summary", { count: chosen.length, seconds: removedSeconds.toFixed(1) })
								: t("aiCut.noCuts")}
						</p>
						{suggestions.length > 0 && (
							<>
								<div
									className="relative h-8 rounded bg-white/5 overflow-hidden"
									aria-label={t("aiCut.review")}
								>
									{suggestions.map((item) => (
										<button
											key={item.id}
											type="button"
											title={`${time(item.startMs)} – ${time(item.endMs)}: ${item.reason}`}
											aria-label={`${time(item.startMs)}: ${item.reason}`}
											className={`absolute h-full min-w-[3px] border border-violet-300/30 ${selected.has(item.id) ? "bg-violet-500/70" : "bg-slate-600/40"}`}
											style={{
												left: `${(item.startMs / durationMs) * 100}%`,
												width: `${((item.endMs - item.startMs) / durationMs) * 100}%`,
											}}
											onClick={() => play(item, false)}
										/>
									))}
								</div>
								{/* Source preview intentionally excludes editor effects; the timeline previews the final composition after applying. */}
								<video
									ref={video}
									src={videoPath}
									controls
									preload="metadata"
									className="w-full max-h-52 rounded bg-black"
									aria-label={t("aiCut.sourcePreview")}
								/>
								<p className="text-xs text-slate-400">{t("aiCut.sourcePreview")}</p>
								<div className="flex gap-2">
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setSelected(new Set(suggestions.map((item) => item.id)))}
									>
										{t("aiCut.selectAll")}
									</Button>
									<Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
										{t("aiCut.selectNone")}
									</Button>
								</div>
								<div className="max-h-56 overflow-y-auto space-y-2">
									{suggestions.map((item) => (
										<article
											key={item.id}
											className="rounded border border-violet-400/20 p-3 space-y-1"
										>
											<label className="flex gap-2 items-start text-sm">
												<input
													type="checkbox"
													checked={selected.has(item.id)}
													onChange={(event) =>
														setSelected((previous) => {
															const next = new Set(previous);
															if (event.target.checked) next.add(item.id);
															else next.delete(item.id);
															return next;
														})
													}
												/>
												<span>
													<span className="text-violet-300">
														{time(item.startMs)} – {time(item.endMs)}
													</span>{" "}
													· {item.reason}
												</span>
											</label>
											<p className="text-xs text-slate-400 line-clamp-3">{item.text}</p>
											<div className="flex gap-2">
												<Button variant="ghost" size="sm" onClick={() => play(item, false)}>
													{t("aiCut.original")}
												</Button>
												<Button variant="ghost" size="sm" onClick={() => play(item, true)}>
													{t("aiCut.previewCut")}
												</Button>
											</div>
										</article>
									))}
								</div>
								<div className="flex items-center gap-3">
									<Button disabled={!chosen.length} onClick={() => onApply(chosen)}>
										{t("aiCut.apply")}
									</Button>
									<span className="text-xs text-slate-400">{t("aiCut.undoHint")}</span>
								</div>
							</>
						)}
					</section>
				)}
				{showSettings && (
					<OpenRouterSettingsDialog onClose={() => setShowSettings(false)} onSaved={setSettings} />
				)}
			</DialogContent>
		</Dialog>
	);
}
