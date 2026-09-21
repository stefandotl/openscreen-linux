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
	type AiCutSettings,
	type AiCutSuggestion,
	type AiCutUnit,
	buildAiCutUnits,
} from "@/lib/aiCut";
import { transcribeVideoToSegments } from "@/lib/captioning/transcribe";
import { DEFAULT_SILENCE_DETECTION_SETTINGS } from "@/lib/silenceDetection";
import type { TrimRegion } from "./types";

interface Props {
	videoPath: string;
	durationMs: number;
	trimRegions: TrimRegion[];
	onClose(): void;
	onApply(suggestions: AiCutSuggestion[]): void;
}
const inputClass = "w-full rounded-md border border-white/15 bg-black/20 px-3 py-2 text-sm";
const time = (ms: number) =>
	`${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(2).padStart(5, "0")}`;

export function AiCutDialog({ videoPath, durationMs, trimRegions, onClose, onApply }: Props) {
	const t = useScopedT("editor");
	const { locale } = useI18n();
	const [settings, setSettings] = useState<AiCutSettings | null>(null);
	const [model, setModel] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [models, setModels] = useState<AiCutModel[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [saved, setSaved] = useState(false);
	const [saving, setSaving] = useState(false);
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
		window.electronAPI.aiCut
			.getSettings()
			.then((value) => {
				if (!mounted.current) return;
				setSettings(value);
				setModel(value.model);
			})
			.catch((error) => {
				if (mounted.current) setError(String(error));
			});
		return () => {
			mounted.current = false;
			if (requestId.current)
				void window.electronAPI.aiCut.cancel(requestId.current).catch(() => {
					// The editor may already have been destroyed during application shutdown.
				});
		};
	}, []);

	async function persist(clearKey = false) {
		const submittedKey = apiKey;
		setSaving(true);
		setSaved(false);
		try {
			const value = await window.electronAPI.aiCut.updateSettings({
				model: model.trim(),
				...(clearKey ? { apiKey: "" } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
			});
			if (mounted.current) {
				setSettings(value);
				setApiKey((current) => (current === submittedKey ? "" : current));
				setSaved(true);
			}
			return value;
		} finally {
			if (mounted.current) setSaving(false);
		}
	}
	function saveOnBlur() {
		if (settings && (apiKey.trim() || model.trim() !== settings.model))
			void persist().catch((error) => setError(String(error)));
	}
	async function analyze() {
		if (requestId.current) return;
		const id = crypto.randomUUID();
		requestId.current = id;
		setError("");
		setSuggestions(null);
		setPreview(null);
		setPhase(t("aiCut.preparing"));
		try {
			const configured = await persist();
			if (!configured.hasApiKey || !configured.model) throw new Error(t("aiCut.configure"));
			if (!mounted.current || requestId.current !== id) return;
			if (!units.current) {
				const transcript = await transcribeVideoToSegments(videoPath, {
					trimRegions,
					sourceDurationSec: durationMs / 1000,
					onStatus: (status) => {
						if (mounted.current && requestId.current === id)
							setPhase(
								status.phase === "transcribe" ? t("aiCut.transcribing") : t("aiCut.loadingSpeech"),
							);
					},
				});
				if (!mounted.current || requestId.current !== id) return;
				if (transcript.truncated) throw new Error(t("aiCut.truncated"));
				if (!transcript.segments.length) throw new Error(t("aiCut.noSpeech"));
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
				if (mounted.current) setPhase("");
			}
		}
	}
	async function refreshModels() {
		setLoadingModels(true);
		setError("");
		try {
			const result = await window.electronAPI.aiCut.listModels();
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
					open={!settings?.hasApiKey || !settings?.model}
					className="rounded-lg border border-white/10 p-3"
				>
					<summary className="cursor-pointer text-sm">{t("aiCut.settings")}</summary>
					<fieldset disabled={busy || !settings} className="grid gap-3 mt-3 sm:grid-cols-2">
						<label className="text-sm space-y-1">
							<span>{t("aiCut.apiKey")}</span>
							<input
								type="password"
								autoComplete="off"
								spellCheck={false}
								className={inputClass}
								value={apiKey}
								placeholder={settings?.hasApiKey ? t("aiCut.keyPresent") : "sk-or-…"}
								onChange={(event) => {
									setApiKey(event.target.value);
									setSaved(false);
								}}
								onBlur={saveOnBlur}
							/>
						</label>
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
							{settings?.hasApiKey && (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => void persist(true).catch((error) => setError(String(error)))}
								>
									{t("aiCut.removeKey")}
								</Button>
							)}
							<span role="status" className="text-xs text-emerald-400">
								{saving ? t("aiCut.preparing") : saved ? t("aiCut.saved") : ""}
							</span>
						</div>
					</fieldset>
					<p className="text-xs text-slate-400 mt-2">
						{t(
							settings?.keyStorage === "session" || settings?.canStoreKey === false
								? "aiCut.sessionKey"
								: "aiCut.encryptedKey",
						)}
					</p>
				</details>
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
							!settings ||
							!model.trim() ||
							(!settings.hasApiKey && !apiKey.trim()) ||
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
			</DialogContent>
		</Dialog>
	);
}
