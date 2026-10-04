import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { OpenRouterSettings, OpenRouterSettingsUpdate } from "@/lib/openRouter";
import { AutoCaptionsDialog } from "./AutoCaptionsDialog";
import { OpenRouterSettingsDialog } from "./OpenRouterSettingsDialog";

vi.mock("@/components/ui/select", () => ({
	Select: ({
		value,
		onValueChange,
		children,
		disabled,
	}: PropsWithChildren<{
		value: string;
		disabled?: boolean;
		onValueChange(value: string): void;
	}>) => (
		<select
			aria-label={value}
			value={value}
			disabled={disabled}
			onChange={(event) => onValueChange(event.target.value)}
		>
			{children}
		</select>
	),
	SelectTrigger: () => null,
	SelectValue: () => null,
	SelectContent: ({ children }: PropsWithChildren) => children,
	SelectItem: ({
		value,
		disabled,
		children,
	}: PropsWithChildren<{ value: string; disabled?: boolean }>) => (
		<option value={value} disabled={disabled}>
			{children}
		</option>
	),
}));
let settings: OpenRouterSettings;
let update: ReturnType<typeof vi.fn>;
beforeEach(() => {
	localStorage.clear();
	settings = {
		model: "cut/model",
		captionEngine: "openrouter",
		transcriptionModel: "fish-audio/transcribe-1-pro",
		hasApiKey: true,
		keyStorage: "encrypted",
		canStoreKey: true,
	};
	update = vi.fn(async (value: OpenRouterSettingsUpdate) => {
		settings = {
			...settings,
			...value,
			hasApiKey: value.apiKey === undefined ? settings.hasApiKey : Boolean(value.apiKey),
		};
		return settings;
	});
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: {
			openRouter: { getSettings: vi.fn(async () => settings), updateSettings: update },
			setLocale: vi.fn(),
		},
	});
});
afterEach(cleanup);
function mount(generate = vi.fn()) {
	return render(
		<I18nProvider>
			<AutoCaptionsDialog onClose={vi.fn()} onGenerate={generate} />
		</I18nProvider>,
	);
}
describe("shared OpenRouter settings and captions", () => {
	it("loads the saved speech selection and saves it without overwriting the AI Cut model", async () => {
		const generate = vi.fn();
		const view = mount(generate);
		await screen.findByRole("combobox", { name: "fish-audio/transcribe-1-pro" });
		fireEvent.change(screen.getByRole("combobox", { name: "fish-audio/transcribe-1-pro" }), {
			target: { value: "assemblyai/universal-3-5-pro" },
		});
		await waitFor(() =>
			expect(update).toHaveBeenCalledWith({ transcriptionModel: "assemblyai/universal-3-5-pro" }),
		);
		await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Generate" }));
		expect(generate).toHaveBeenCalledWith(2, 7, "openrouter", "assemblyai/universal-3-5-pro");
		expect(settings.model).toBe("cut/model");
		view.unmount();
		mount();
		await screen.findByRole("combobox", { name: "assemblyai/universal-3-5-pro" });
		expect(screen.getByRole("option", { name: /GPT Transcribe/ })).toBeDisabled();
		expect(screen.getByRole("option", { name: /Qwen3 ASR Flash/ })).toBeDisabled();
	});
	it("blocks cloud generation until a shared key exists and preserves selection after a failed save", async () => {
		settings.hasApiKey = false;
		mount();
		await screen.findByRole("combobox", { name: "fish-audio/transcribe-1-pro" });
		expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
		update.mockRejectedValueOnce(new Error("Cannot save"));
		fireEvent.change(screen.getByRole("combobox", { name: "openrouter" }), {
			target: { value: "parakeet" },
		});
		await screen.findByRole("alert");
		expect(screen.getByRole("combobox", { name: "openrouter" })).toHaveValue("openrouter");
	});
	it("changes only the shared credential and clears the password after saving", async () => {
		const close = vi.fn();
		const saved = vi.fn();
		render(
			<I18nProvider>
				<OpenRouterSettingsDialog onClose={close} onSaved={saved} />
			</I18nProvider>,
		);
		const input = await screen.findByLabelText("API key");
		await waitFor(() => expect(input).toBeEnabled());
		fireEvent.change(input, { target: { value: "new-test-key" } });
		fireEvent.click(screen.getByRole("button", { name: "Save key" }));
		await waitFor(() => expect(close).toHaveBeenCalledOnce());
		expect(update).toHaveBeenCalledWith({ apiKey: "new-test-key" });
		expect(input).toHaveValue("");
		expect(settings).toMatchObject({
			model: "cut/model",
			transcriptionModel: "fish-audio/transcribe-1-pro",
		});
	});
});
