import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useScopedT } from "@/contexts/I18nContext";
import type { CaptionEngine } from "@/lib/captioning/transcribe";
import { type OpenRouterSettings, type OpenRouterSettingsUpdate } from "@/lib/openRouter";
import { OpenRouterSettingsDialog } from "./OpenRouterSettingsDialog";
import { TranscriptionModelSelection } from "./TranscriptionModelSelection";

export function AutoCaptionsDialog({
	onClose,
	onGenerate,
	initialMinWords = 2,
	initialMaxWords = 7,
	onWordLimitsChange,
}: {
	onClose(): void;
	onGenerate(minWords: number, maxWords: number, engine: CaptionEngine, model: string): void;
	initialMinWords?: number;
	initialMaxWords?: number;
	onWordLimitsChange?(minWords: number, maxWords: number): void;
}) {
	const t = useScopedT("editor");
	const [settings, setSettings] = useState<OpenRouterSettings | null>(null);
	const [minWords, setMinWords] = useState(initialMinWords);
	const [maxWords, setMaxWords] = useState(initialMaxWords);
	const [showSettings, setShowSettings] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		window.electronAPI.openRouter
			.getSettings()
			.then((value) => {
				if (mounted.current) setSettings(value);
			})
			.catch((error) => {
				if (mounted.current) setError(String(error));
			});
		return () => {
			mounted.current = false;
		};
	}, []);
	async function select(update: OpenRouterSettingsUpdate) {
		setSaving(true);
		setError("");
		try {
			const value = await window.electronAPI.openRouter.updateSettings(update);
			if (mounted.current) setSettings(value);
		} catch (error) {
			if (mounted.current) setError(String(error));
		} finally {
			if (mounted.current) setSaving(false);
		}
	}
	const cloud = settings?.captionEngine === "openrouter";
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !saving) onClose();
			}}
		>
			<DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto bg-[#151519] text-slate-100 border-white/10">
				<DialogHeader>
					<DialogTitle>{t("autoCaptions.dialogTitle")}</DialogTitle>
					<DialogDescription>{t("autoCaptions.dialogDescription")}</DialogDescription>
				</DialogHeader>
				<fieldset disabled={!settings || saving} className="grid gap-4 py-2">
					<TranscriptionModelSelection
						settings={settings}
						disabled={saving}
						onSelect={(update) => void select(update)}
						onSettings={() => setShowSettings(true)}
					/>
					{(["min", "max"] as const).map((kind) => (
						<div key={kind} className="grid gap-2">
							<Label htmlFor={`caption-${kind}-words`}>
								{t(kind === "min" ? "autoCaptions.minWords" : "autoCaptions.maxWords")}
							</Label>
							<Select
								value={String(kind === "min" ? minWords : maxWords)}
								onValueChange={(value) => {
									const count = Number(value);
									const min = kind === "min" ? count : Math.min(count, minWords);
									const max = kind === "max" ? count : Math.max(count, maxWords);
									setMinWords(min);
									setMaxWords(max);
									onWordLimitsChange?.(min, max);
								}}
							>
								<SelectTrigger id={`caption-${kind}-words`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Array.from({ length: 12 }, (_, index) => index + 1).map((count) => (
										<SelectItem key={count} value={String(count)}>
											{t("autoCaptions.wordsCount", { count: String(count) })}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					))}
				</fieldset>
				{error && (
					<p role="alert" className="text-sm text-red-300">
						{error}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<Button variant="outline" disabled={saving} onClick={onClose}>
						{t("autoCaptions.dialogCancel")}
					</Button>
					<Button
						disabled={!settings || saving || Boolean(error) || (cloud && !settings?.hasApiKey)}
						onClick={() => {
							if (settings)
								onGenerate(minWords, maxWords, settings.captionEngine, settings.transcriptionModel);
						}}
					>
						{t("autoCaptions.generate")}
					</Button>
				</div>
				{showSettings && (
					<OpenRouterSettingsDialog onClose={() => setShowSettings(false)} onSaved={setSettings} />
				)}
			</DialogContent>
		</Dialog>
	);
}
