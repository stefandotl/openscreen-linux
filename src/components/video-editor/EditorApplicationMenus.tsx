import { Languages, Settings2 } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/contexts/I18nContext";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import type { Locale } from "@/i18n/config";
import { getAvailableLocales, getLocaleName } from "@/i18n/loader";
import type { EditorWindowAction } from "@/lib/editorWindowActions";

const triggerClass =
	"rounded-lg px-2.5 py-1.5 text-xs font-medium text-white/70 hover:bg-white/[0.08] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#34B27B] disabled:opacity-40";
const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties;

export function isTextEditingTarget(target: unknown): target is HTMLElement {
	return (
		target instanceof HTMLElement &&
		((target instanceof HTMLInputElement &&
			["text", "search", "email", "url", "tel", "password", "number"].includes(target.type)) ||
			target instanceof HTMLTextAreaElement ||
			target.isContentEditable)
	);
}

export function EditorEditViewMenus({
	disabled,
	canUndo,
	canRedo,
	onUndo,
	onRedo,
}: {
	disabled: boolean;
	canUndo: boolean;
	canRedo: boolean;
	onUndo: () => void;
	onRedo: () => void;
}) {
	const { t } = useI18n();
	const { isMac } = useShortcuts();
	const textTarget = useRef<HTMLElement | null>(null);
	const textSelection = useRef<{
		start: number | null;
		end: number | null;
		direction: "forward" | "backward" | "none" | null;
	} | null>(null);
	const pendingAction = useRef<EditorWindowAction | null>(null);
	const [editingText, setEditingText] = useState(false);
	useEffect(() => {
		const rememberTarget = (event: Event) => {
			const target = event.target;
			if (target instanceof Element && target.closest("[data-editor-menu]")) return;
			textTarget.current = isTextEditingTarget(target) ? target : null;
		};
		document.addEventListener("focusin", rememberTarget);
		document.addEventListener("pointerdown", rememberTarget, true);
		return () => {
			document.removeEventListener("focusin", rememberTarget);
			document.removeEventListener("pointerdown", rememberTarget, true);
		};
	}, []);
	const runAction = (action: EditorWindowAction) => {
		void window.electronAPI.editorWindowAction(action).catch((error) => toast.error(String(error)));
	};
	const editItems: [EditorWindowAction, string, boolean][] = [
		["undo", isMac ? "⌘Z" : "Ctrl+Z", !editingText && !canUndo],
		["redo", isMac ? "⇧⌘Z" : "Ctrl+Y", !editingText && !canRedo],
		["cut", isMac ? "⌘X" : "Ctrl+X", !editingText],
		["copy", isMac ? "⌘C" : "Ctrl+C", !editingText],
		["paste", isMac ? "⌘V" : "Ctrl+V", !editingText],
		["selectAll", isMac ? "⌘A" : "Ctrl+A", !editingText],
	];
	return (
		<>
			<DropdownMenu
				onOpenChange={(open) => {
					if (open) {
						setEditingText(Boolean(textTarget.current?.isConnected));
						const target = textTarget.current;
						textSelection.current =
							target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
								? {
										start: target.selectionStart,
										end: target.selectionEnd,
										direction: target.selectionDirection,
									}
								: null;
					}
				}}
			>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						data-editor-menu
						disabled={disabled}
						style={noDrag}
						className={triggerClass}
					>
						{t("common.actions.edit")}
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					data-editor-menu
					align="start"
					className="min-w-56"
					onCloseAutoFocus={(event) => {
						const action = pendingAction.current;
						pendingAction.current = null;
						const target = textTarget.current;
						if (target?.isConnected) {
							event.preventDefault();
							target.focus({ preventScroll: true });
							const selection = textSelection.current;
							if (
								selection?.start != null &&
								selection.end != null &&
								(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
							)
								target.setSelectionRange(
									selection.start,
									selection.end,
									selection.direction ?? undefined,
								);
						}
						if (!action) return;
						if (!target?.isConnected && action === "undo") onUndo();
						else if (!target?.isConnected && action === "redo") onRedo();
						else runAction(action);
					}}
				>
					{editItems.map(([action, shortcut, unavailable], index) => (
						<div key={action}>
							{index === 2 && <DropdownMenuSeparator />}
							<DropdownMenuItem
								disabled={unavailable}
								onSelect={() => {
									pendingAction.current = action;
								}}
							>
								{t(`common.actions.${action}`)}
								<DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>
							</DropdownMenuItem>
						</div>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						data-editor-menu
						disabled={disabled}
						style={noDrag}
						className={triggerClass}
					>
						{t("common.actions.view")}
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent data-editor-menu align="start" className="min-w-56">
					{(["zoomIn", "zoomOut", "resetZoom", "toggleFullScreen"] as const).map(
						(action, index) => (
							<div key={action}>
								{index === 3 && <DropdownMenuSeparator />}
								<DropdownMenuItem onSelect={() => runAction(action)}>
									{t(`common.actions.${action === "resetZoom" ? "actualSize" : action}`)}
								</DropdownMenuItem>
							</div>
						),
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}

export function EditorPreferencesMenu({ disabled }: { disabled: boolean }) {
	const { t, locale, setLocale } = useI18n();
	const { openConfig } = useShortcuts();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					style={noDrag}
					className={triggerClass}
					aria-label={t("common.actions.settings")}
					title={t("common.actions.settings")}
				>
					<Settings2 size={15} />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={openConfig}>{t("shortcuts.title")}</DropdownMenuItem>
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<Languages size={14} />
						{t("settings.language.title")}
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuRadioGroup
							value={locale}
							onValueChange={(value) => setLocale(value as Locale)}
						>
							{getAvailableLocales().map((loc) => (
								<DropdownMenuRadioItem key={loc} value={loc}>
									{getLocaleName(loc)}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
