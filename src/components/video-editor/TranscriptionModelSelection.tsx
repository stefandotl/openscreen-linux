import { Button } from "@/components/ui/button";
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
import {
	OPENROUTER_CAPTION_MODELS,
	type OpenRouterSettings,
	type OpenRouterSettingsUpdate,
} from "@/lib/openRouter";

export function TranscriptionModelSelection({
	settings,
	disabled = false,
	onSelect,
	onSettings,
}: {
	settings: OpenRouterSettings | null;
	disabled?: boolean;
	onSelect(update: OpenRouterSettingsUpdate): void;
	onSettings(): void;
}) {
	const t = useScopedT("editor");
	const cloud = settings?.captionEngine === "openrouter";
	return (
		<>
			<div className="grid gap-2">
				<Label htmlFor="caption-engine">{t("autoCaptions.model")}</Label>
				<Select
					value={settings?.captionEngine ?? "parakeet"}
					onValueChange={(value) => onSelect({ captionEngine: value as CaptionEngine })}
					disabled={!settings || disabled}
				>
					<SelectTrigger id="caption-engine">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="parakeet">Parakeet TDT 0.6B · ~660 MB</SelectItem>
						<SelectItem value="whisper-tiny">Whisper Tiny · ~75 MB</SelectItem>
						<SelectItem value="openrouter">OpenRouter</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{cloud && settings && (
				<>
					<div className="grid gap-2">
						<Label htmlFor="caption-openrouter-model">{t("autoCaptions.cloudModel")}</Label>
						<Select
							value={settings.transcriptionModel}
							onValueChange={(transcriptionModel) => onSelect({ transcriptionModel })}
							disabled={disabled}
						>
							<SelectTrigger id="caption-openrouter-model">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{OPENROUTER_CAPTION_MODELS.map((model) => (
									<SelectItem key={model.id} value={model.id}>
										{model.name}
									</SelectItem>
								))}
								<SelectItem value="openai/gpt-transcribe" disabled>
									GPT Transcribe · {t("autoCaptions.noWordTimestamps")}
								</SelectItem>
								<SelectItem value="qwen/qwen3-asr-flash-2026-02-10" disabled>
									Qwen3 ASR Flash · {t("autoCaptions.noWordTimestamps")}
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<p className="text-xs text-slate-400">{t("autoCaptions.cloudPrivacy")}</p>
					<Button variant="outline" onClick={() => onSettings()}>
						{t("openRouter.title")}
					</Button>
					{!settings.hasApiKey && (
						<p className="text-sm text-amber-300">{t("autoCaptions.configureCloud")}</p>
					)}
				</>
			)}
		</>
	);
}
