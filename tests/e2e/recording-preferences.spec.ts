import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
	return electron.launch({
		args: [MAIN_JS, "--no-sandbox", "--enable-unsafe-swiftshader", "--lang=en-US"],
		env: {
			...process.env,
			HEADLESS: "true",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			LANGUAGE: "en_US",
			XDG_CONFIG_HOME: userDataDir,
		},
	});
}

async function closeApp(app: ElectronApplication) {
	const child = app.process();
	await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
	if (child.exitCode === null && child.signalCode === null) {
		await Promise.race([
			once(child, "close"),
			new Promise((resolve) => setTimeout(resolve, 5_000)),
		]);
	}
}

async function dismissLanguagePrompt(page: Page) {
	const button = page.getByRole("button", { name: /Keep current language/i });
	if ((await button.count()) > 0) {
		await button.click();
	}
}

test.describe("recording preferences", () => {
	test.skip(process.platform !== "linux", "The restart regression covers the primary Linux HUD.");

	test("restores microphone and selected screen after a full app restart", async () => {
		const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-recording-restart-"));
		let firstApp: ElectronApplication | null = null;
		let secondApp: ElectronApplication | null = null;

		try {
			firstApp = await launchApp(configRoot);
			const firstHud = await firstApp.firstWindow({ timeout: 60_000 });
			await firstHud.waitForLoadState("domcontentloaded");
			await dismissLanguagePrompt(firstHud);

			await firstHud.getByTestId("launch-microphone-button").click();
			await expect(firstHud.getByTestId("launch-microphone-button")).toHaveAttribute(
				"title",
				/Disable microphone/i,
			);

			await firstHud.getByTestId("launch-source-selector-button").click();
			const sourceWindow = await firstApp.waitForEvent("window", {
				predicate: (window) => window.url().includes("windowType=source-selector"),
				timeout: 15_000,
			});
			const screens = sourceWindow.locator(
				'[data-testid="source-selector-card"][data-source-kind="screen"]',
			);
			await expect.poll(() => screens.count(), { timeout: 15_000 }).toBeGreaterThan(0);
			await screens.first().click();
			await sourceWindow.getByTestId("source-selector-share-button").click();

			await expect
				.poll(() => firstHud.evaluate(() => window.electronAPI.getSelectedSource()), {
					timeout: 10_000,
				})
				.not.toBeNull();
			const selectedBeforeRestart = await firstHud.evaluate(() =>
				window.electronAPI.getSelectedSource(),
			);
			expect(selectedBeforeRestart).not.toBeNull();

			const userDataDir = await firstApp.evaluate(({ app: electronApp }) =>
				electronApp.getPath("userData"),
			);
			const preferencesPath = path.join(userDataDir, "recording-preferences.json");
			await expect
				.poll(() => {
					if (!fs.existsSync(preferencesPath)) return null;
					return JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
				})
				.toMatchObject({
					microphoneEnabled: true,
					captureSource: { id: selectedBeforeRestart?.id },
				});

			await closeApp(firstApp);
			firstApp = null;

			secondApp = await launchApp(configRoot);
			const secondHud = await secondApp.firstWindow({ timeout: 60_000 });
			await secondHud.waitForLoadState("domcontentloaded");
			await dismissLanguagePrompt(secondHud);

			await expect(secondHud.getByTestId("launch-microphone-button")).toHaveAttribute(
				"title",
				/Disable microphone/i,
			);
			await expect
				.poll(() => secondHud.evaluate(() => window.electronAPI.getSelectedSource()), {
					timeout: 15_000,
				})
				.toMatchObject({ id: selectedBeforeRestart?.id });
			await expect(secondHud.getByTestId("launch-record-button")).toBeEnabled();
		} finally {
			if (firstApp) await closeApp(firstApp);
			if (secondApp) await closeApp(secondApp);
			fs.rmSync(configRoot, { recursive: true, force: true });
		}
	});
});
