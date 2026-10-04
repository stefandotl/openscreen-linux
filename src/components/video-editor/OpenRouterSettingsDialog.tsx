import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useScopedT } from "@/contexts/I18nContext";
import type { OpenRouterSettings } from "@/lib/openRouter";

export function OpenRouterSettingsDialog({
	onClose,
	onSaved,
}: {
	onClose(): void;
	onSaved?(settings: OpenRouterSettings): void;
}) {
	const t = useScopedT("editor");
	const [settings, setSettings] = useState<OpenRouterSettings | null>(null);
	const [apiKey, setApiKey] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		let mounted = true;
		window.electronAPI.openRouter
			.getSettings()
			.then((value) => {
				if (mounted) setSettings(value);
			})
			.catch((error) => {
				if (mounted) setError(String(error));
			});
		return () => {
			mounted = false;
		};
	}, []);
	async function save(clear = false) {
		setSaving(true);
		setError("");
		try {
			const value = await window.electronAPI.openRouter.updateSettings({
				apiKey: clear ? "" : apiKey.trim(),
			});
			setSettings(value);
			setApiKey("");
			onSaved?.(value);
			if (!clear) onClose();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !saving) onClose();
			}}
		>
			<DialogContent className="max-w-lg bg-[#151519] text-slate-100 border-white/10">
				<DialogHeader>
					<DialogTitle>{t("openRouter.title")}</DialogTitle>
					<DialogDescription>{t("openRouter.description")}</DialogDescription>
				</DialogHeader>
				<fieldset disabled={!settings || saving} className="space-y-3">
					<label className="block text-sm space-y-1">
						<span>{t("aiCut.apiKey")}</span>
						<input
							type="password"
							autoComplete="off"
							spellCheck={false}
							value={apiKey}
							placeholder={settings?.hasApiKey ? t("aiCut.keyPresent") : "sk-or-…"}
							className="w-full rounded-md border border-white/15 bg-black/20 px-3 py-2 text-sm"
							onChange={(event) => setApiKey(event.target.value)}
						/>
					</label>
					<p className="text-xs text-slate-400">
						{t(
							settings?.keyStorage === "session" || settings?.canStoreKey === false
								? "aiCut.sessionKey"
								: "aiCut.encryptedKey",
						)}
					</p>
					<div className="flex gap-2">
						<Button disabled={!apiKey.trim()} onClick={() => void save()}>
							{t("openRouter.save")}
						</Button>
						{settings?.hasApiKey && (
							<Button variant="ghost" onClick={() => void save(true)}>
								{t("aiCut.removeKey")}
							</Button>
						)}
					</div>
				</fieldset>
				{error && (
					<p role="alert" className="text-sm text-red-300">
						{error}
					</p>
				)}
				<Button variant="outline" disabled={saving} onClick={onClose}>
					{t("openRouter.close")}
				</Button>
			</DialogContent>
		</Dialog>
	);
}
