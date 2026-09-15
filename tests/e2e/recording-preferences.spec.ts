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
	const launchEnv = { ...process.env };
	delete launchEnv.ELECTRON_RUN_AS_NODE;
	return electron.launch({
		args: [
			MAIN_JS,
			"--no-sandbox",
			"--enable-unsafe-swiftshader",
			"--lang=en-US",
			`--user-data-dir=${userDataDir}/profile`,
		],
		env: {
			...launchEnv,
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
		const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-recording-restart-"));
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

test("retains a virtual camera while enumeration is incomplete and recovers its changed ID", async () => {
	const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "videtio-virtual-camera-"));
	const app = await launchApp(configRoot);
	try {
		const page = await app.firstWindow({ timeout: 60_000 });
		await page.waitForLoadState("domcontentloaded");
		await page.evaluate(() =>
			window.electronAPI.updateRecordingPreferences({
				webcamEnabled: true,
				webcamDeviceId: "old-origin-id",
				webcamDeviceName: "OBS Virtual Camera",
			}),
		);
		await page.addInitScript(() => {
			const started = performance.now();
			const requests: string[] = [];
			(window as unknown as { cameraRequests: string[] }).cameraRequests = requests;
			Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
				value: async () => {
					const devices = [
						{
							kind: "videoinput",
							deviceId: "built-in",
							label: "Built-in Camera",
							groupId: "physical",
							toJSON: () => ({}),
						},
					];
					if (performance.now() - started > 3000)
						devices.push({
							kind: "videoinput",
							deviceId: "new-virtual-id",
							label: "OBS Virtual Camera",
							groupId: "virtual",
							toJSON: () => ({}),
						});
					return devices;
				},
			});
			Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
				value: async (constraints: MediaStreamConstraints) => {
					const video = constraints.video as MediaTrackConstraints;
					const id = (video.deviceId as ConstrainDOMStringParameters)?.exact as string;
					requests.push(id);
					if (id !== "new-virtual-id") throw new Error(`Unexpected camera requested: ${id}`);
					const canvas = document.createElement("canvas");
					canvas.width = 320;
					canvas.height = 180;
					const context = canvas.getContext("2d")!;
					context.fillRect(0, 0, 320, 180);
					return canvas.captureStream(30);
				},
			});
		});
		await page.reload();
		await page.waitForLoadState("domcontentloaded");
		await expect
			.poll(async () =>
				page.evaluate(async () => {
					const { preferences } = await window.electronAPI.initializeRecordingPreferences({});
					return preferences.webcamDeviceName;
				}),
			)
			.toBe("OBS Virtual Camera");
		// Sample during the incomplete enumeration, then await the automatic recovery.
		await page.waitForTimeout(1000);
		const waiting = await page.evaluate(() =>
			window.electronAPI.initializeRecordingPreferences({}),
		);
		expect(waiting.preferences.webcamDeviceId).toBe("old-origin-id");
		expect(waiting.preferences.webcamDeviceName).toBe("OBS Virtual Camera");
		await expect
			.poll(
				async () =>
					page.evaluate(async () => {
						const { preferences } = await window.electronAPI.initializeRecordingPreferences({});
						return preferences.webcamDeviceId;
					}),
				{ timeout: 15_000 },
			)
			.toBe("new-virtual-id");
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as unknown as { cameraRequests: string[] }).cameraRequests.length,
				),
			)
			.toBeGreaterThan(0);
		const requests = await page.evaluate(
			() => (window as unknown as { cameraRequests: string[] }).cameraRequests,
		);
		expect(requests.every((id) => id === "new-virtual-id")).toBe(true);
		const saved = await page.evaluate(() => window.electronAPI.initializeRecordingPreferences({}));
		expect(saved.preferences.webcamDeviceName).toBe("OBS Virtual Camera");
	} finally {
		await closeApp(app);
		fs.rmSync(configRoot, { recursive: true, force: true });
	}
});
