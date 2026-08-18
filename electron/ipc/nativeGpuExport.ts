import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ipcMain, type WebContents } from "electron";
import {
	NATIVE_GPU_EXPORT_CHANNELS,
	NATIVE_GPU_EXPORT_PROTOCOL_VERSION,
	type NativeGpuExportProgress,
	type NativeGpuExportRequest,
} from "../../src/lib/exporter/nativeGpuExportProtocol";
import { type AudioTimelineFilter, buildNativeGpuAudioMuxArgs } from "./nativeGpuAudioMux";

const HELPER_NAME = "openscreen-linux-export-helper";
const MAX_STATIC_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_OVERLAY_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_OVERLAYS = 10_000;
const MAX_BLUR_REGIONS = 10_000;
const MAX_PLAN_FRAMES = 20_736_000;
const MAX_OUTPUT_DIMENSION = 4096;

function roundPerfMs(value: number) {
	return Math.round(value * 10) / 10;
}

function logNativeNvencMainPerf(details: Record<string, unknown>) {
	console.info(`[native-nvenc-main-perf] ${JSON.stringify(details)}`);
}

interface NativeGpuExportDependencies {
	getFfmpegBinary: () => string;
	resolveApprovedVideoPath: (filePath?: string | null) => string | null;
	buildAudioTimelineFilter: (
		sourceDurationSec?: number,
		trimRegions?: Array<{ startMs: number; endMs: number }>,
		speedRegions?: Array<{ startMs: number; endMs: number; speed: number }>,
	) => AudioTimelineFilter | null;
}

interface ProcessResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
}

interface NativeGpuExportSession {
	id: string;
	helperProcess: ChildProcess;
	helperExit: Promise<ProcessResult>;
	muxProcess: ChildProcess | null;
	tempDir: string;
	videoOnlyPath: string;
	outputPath: string;
	audioPath?: string;
	sourceDurationSec: number;
	trimRegions?: Array<{ startMs: number; endMs: number }>;
	speedRegions?: Array<{ startMs: number; endMs: number; speed: number }>;
	ensureAudioTrack: boolean;
	totalFrames: number;
	frameRate: number;
	sender: WebContents;
	stdout: string;
	stderr: string;
	stdoutBuffer: string;
	cancelled: boolean;
	startupStartedAt: number;
	helperSpawnedAt: number;
	firstProgressLogged: boolean;
}

const sessions = new Map<string, NativeGpuExportSession>();

function tailText(value: string, maxLength = 16_000) {
	return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}

function helperCandidates() {
	const envPath = process.env.OPENSCREEN_LINUX_EXPORT_HELPER_EXE?.trim();
	const appRoot = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : process.cwd();
	const archTag = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
	const resourceRoot =
		typeof process.resourcesPath === "string"
			? process.resourcesPath
			: path.join(appRoot, "resources");
	return [
		envPath,
		path.join(appRoot, "electron", "native", "linux-export-helper", "build", HELPER_NAME),
		path.join(appRoot, "electron", "native", "bin", archTag, HELPER_NAME),
		path.join(resourceRoot, "electron", "native", "bin", archTag, HELPER_NAME),
	].filter((candidate): candidate is string => Boolean(candidate));
}

export function findLinuxExportHelperPath() {
	if (process.platform !== "linux") return null;
	for (const candidate of helperCandidates()) {
		try {
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Try the next explicit development or packaged location.
		}
	}
	return null;
}

function processExit(child: ChildProcess): Promise<ProcessResult> {
	return new Promise((resolve) => {
		child.once("error", (error) => resolve({ code: null, signal: null, error }));
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
}

async function runCapturedProcess(command: string, args: string[], operation: string) {
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout = tailText(stdout + chunk.toString("utf-8"));
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = tailText(stderr + chunk.toString("utf-8"));
	});
	const result = await processExit(child);
	if (result.error || result.code !== 0) {
		throw new Error(
			`${operation} failed: ${result.error?.message || stderr || stdout || `exit code ${result.code}`}`,
		);
	}
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function validateRequest(payload: NativeGpuExportRequest) {
	if (!payload || typeof payload !== "object" || !payload.plan) {
		throw new Error("Native GPU export request is missing its plan");
	}
	const { plan } = payload;
	if (plan.version !== NATIVE_GPU_EXPORT_PROTOCOL_VERSION) {
		throw new Error(`Unsupported native GPU export protocol version: ${plan.version}`);
	}
	if (
		!Number.isInteger(plan.width) ||
		!Number.isInteger(plan.height) ||
		plan.width < 2 ||
		plan.height < 2 ||
		plan.width % 2 !== 0 ||
		plan.height % 2 !== 0 ||
		plan.width > MAX_OUTPUT_DIMENSION ||
		plan.height > MAX_OUTPUT_DIMENSION ||
		plan.frameRate !== 30
	) {
		throw new Error(
			`Native GPU export requires even output dimensions up to ${MAX_OUTPUT_DIMENSION}px at 30 fps`,
		);
	}
	if (
		!Number.isInteger(plan.sourceWidth) ||
		!Number.isInteger(plan.sourceHeight) ||
		plan.sourceWidth <= 0 ||
		plan.sourceHeight <= 0 ||
		plan.sourceWidth % 2 !== 0 ||
		plan.sourceHeight % 2 !== 0
	) {
		throw new Error("Native GPU export source dimensions are invalid");
	}
	if (!finiteNumber(plan.bitrate) || plan.bitrate < 500_000 || plan.bitrate > 200_000_000) {
		throw new Error("Native GPU export bitrate is invalid");
	}
	if (
		!Array.isArray(plan.frames) ||
		plan.frames.length < 1 ||
		plan.frames.length > MAX_PLAN_FRAMES
	) {
		throw new Error("Native GPU export frame plan has an invalid length");
	}
	let previousTimestamp = -1;
	for (const frame of plan.frames) {
		if (
			!finiteNumber(frame.sourceTimestampMs) ||
			!finiteNumber(frame.cameraScale) ||
			!finiteNumber(frame.cameraX) ||
			!finiteNumber(frame.cameraY) ||
			!finiteNumber(frame.motionBlurX) ||
			!finiteNumber(frame.motionBlurY) ||
			!finiteNumber(frame.webcamScale) ||
			frame.sourceTimestampMs < previousTimestamp ||
			frame.cameraScale <= 0 ||
			frame.cameraScale > 10 ||
			frame.webcamScale < 0.35 ||
			frame.webcamScale > 1
		) {
			throw new Error("Native GPU export frame plan is invalid or non-monotonic");
		}
		previousTimestamp = frame.sourceTimestampMs;
	}
	const rect = plan.screenRect;
	if (
		!rect ||
		!finiteNumber(rect.x) ||
		!finiteNumber(rect.y) ||
		!finiteNumber(rect.width) ||
		!finiteNumber(rect.height) ||
		rect.width <= 0 ||
		rect.height <= 0
	) {
		throw new Error("Native GPU export screen rectangle is invalid");
	}
	if (
		typeof plan.screenCover !== "boolean" ||
		!finiteNumber(plan.screenBorderRadius) ||
		plan.screenBorderRadius < 0
	) {
		throw new Error("Native GPU export screen layout is invalid");
	}
	if (plan.webcam) {
		const webcam = plan.webcam;
		const webcamRect = webcam.rect;
		if (
			typeof webcam.inputPath !== "string" ||
			!Number.isInteger(webcam.sourceWidth) ||
			!Number.isInteger(webcam.sourceHeight) ||
			webcam.sourceWidth <= 0 ||
			webcam.sourceHeight <= 0 ||
			webcam.sourceWidth % 2 !== 0 ||
			webcam.sourceHeight % 2 !== 0 ||
			!webcamRect ||
			!finiteNumber(webcamRect.x) ||
			!finiteNumber(webcamRect.y) ||
			!finiteNumber(webcamRect.width) ||
			!finiteNumber(webcamRect.height) ||
			webcamRect.x < 0 ||
			webcamRect.y < 0 ||
			webcamRect.width <= 0 ||
			webcamRect.height <= 0 ||
			webcamRect.x + webcamRect.width > plan.width ||
			webcamRect.y + webcamRect.height > plan.height ||
			!finiteNumber(webcam.borderRadius) ||
			webcam.borderRadius < 0 ||
			!["rectangle", "rounded", "circle", "square"].includes(webcam.maskShape) ||
			typeof webcam.mirrored !== "boolean" ||
			![0, 90, 180, 270].includes(webcam.rotation) ||
			typeof webcam.anchorRight !== "boolean" ||
			typeof webcam.anchorBottom !== "boolean"
		) {
			throw new Error("Native GPU export webcam layout is invalid");
		}
		if (
			webcam.shadow &&
			(typeof webcam.shadow.color !== "string" ||
				!finiteNumber(webcam.shadow.blur) ||
				!finiteNumber(webcam.shadow.offsetX) ||
				!finiteNumber(webcam.shadow.offsetY) ||
				webcam.shadow.blur < 0)
		) {
			throw new Error("Native GPU export webcam shadow is invalid");
		}
	}
	const crop = plan.cropRegion;
	if (
		!crop ||
		Math.abs(crop.x) > 0.0001 ||
		Math.abs(crop.y) > 0.0001 ||
		Math.abs(crop.width - 1) > 0.0001 ||
		Math.abs(crop.height - 1) > 0.0001
	) {
		throw new Error("Native GPU export requires the default crop");
	}
	if (!(payload.wallpaperPng instanceof ArrayBuffer)) {
		throw new Error("Native GPU export wallpaper PNG is missing");
	}
	if (
		payload.wallpaperPng.byteLength < 1 ||
		payload.wallpaperPng.byteLength > MAX_STATIC_ASSET_BYTES
	) {
		throw new Error("Native GPU export wallpaper PNG has an invalid size");
	}
	if (!Array.isArray(plan.blurRegions) || plan.blurRegions.length > MAX_BLUR_REGIONS) {
		throw new Error("Native GPU export blur-region collection is invalid");
	}
	for (let index = 0; index < plan.blurRegions.length; index++) {
		const region = plan.blurRegions[index];
		if (
			!finiteNumber(region.startMs) ||
			!finiteNumber(region.endMs) ||
			region.startMs < 0 ||
			region.endMs <= region.startMs ||
			!Number.isInteger(region.x) ||
			!Number.isInteger(region.y) ||
			!Number.isInteger(region.width) ||
			!Number.isInteger(region.height) ||
			!Number.isInteger(region.blockSize) ||
			!Number.isInteger(region.zIndex) ||
			region.x < 0 ||
			region.y < 0 ||
			region.width < 1 ||
			region.height < 1 ||
			region.x + region.width > plan.width ||
			region.y + region.height > plan.height ||
			region.blockSize < 1 ||
			region.blockSize > 512 ||
			!Number.isInteger(region.intensity) ||
			region.intensity < 1 ||
			region.intensity > 512 ||
			!["blur", "mosaic"].includes(region.type) ||
			!["rectangle", "oval"].includes(region.shape) ||
			!["white", "black"].includes(region.color)
		) {
			throw new Error(`Native GPU export blur region ${index} is invalid`);
		}
	}
	if (
		!Array.isArray(plan.overlays) ||
		plan.overlays.length > MAX_OVERLAYS ||
		!Array.isArray(payload.overlayPngs) ||
		payload.overlayPngs.length !== plan.overlays.length
	) {
		throw new Error("Native GPU export overlay collection is invalid");
	}
	let totalOverlayBytes = 0;
	for (let index = 0; index < plan.overlays.length; index++) {
		const overlay = plan.overlays[index];
		const pixels = payload.overlayPngs[index];
		if (
			!finiteNumber(overlay.startMs) ||
			!finiteNumber(overlay.endMs) ||
			overlay.startMs < 0 ||
			overlay.endMs <= overlay.startMs ||
			!Number.isInteger(overlay.x) ||
			!Number.isInteger(overlay.y) ||
			!Number.isInteger(overlay.width) ||
			!Number.isInteger(overlay.height) ||
			!Number.isInteger(overlay.zIndex) ||
			overlay.x < 0 ||
			overlay.y < 0 ||
			overlay.width < 1 ||
			overlay.height < 1 ||
			overlay.x + overlay.width > plan.width ||
			overlay.y + overlay.height > plan.height ||
			!(pixels instanceof ArrayBuffer) ||
			pixels.byteLength < 1 ||
			pixels.byteLength > MAX_STATIC_ASSET_BYTES
		) {
			throw new Error(`Native GPU export overlay ${index} is invalid`);
		}
		totalOverlayBytes += pixels.byteLength;
		if (totalOverlayBytes > MAX_TOTAL_OVERLAY_ASSET_BYTES) {
			throw new Error("Native GPU export overlay assets exceed the size limit");
		}
	}
	if (!finiteNumber(payload.sourceDurationSec) || payload.sourceDurationSec <= 0) {
		throw new Error("Native GPU export source duration is invalid");
	}
}

function emitProgress(
	session: NativeGpuExportSession,
	progress: Omit<NativeGpuExportProgress, "sessionId">,
) {
	if (session.sender.isDestroyed()) return;
	session.sender.send(NATIVE_GPU_EXPORT_CHANNELS.progress, {
		sessionId: session.id,
		...progress,
	} satisfies NativeGpuExportProgress);
}

function consumeHelperLine(session: NativeGpuExportSession, line: string) {
	if (line.startsWith("PROGRESS: ")) {
		try {
			const progress = JSON.parse(line.slice("PROGRESS: ".length)) as {
				frames?: unknown;
				totalFrames?: unknown;
				fps?: unknown;
			};
			if (
				finiteNumber(progress.frames) &&
				finiteNumber(progress.totalFrames) &&
				finiteNumber(progress.fps)
			) {
				if (!session.firstProgressLogged) {
					session.firstProgressLogged = true;
					logNativeNvencMainPerf({
						startupId: session.id,
						phase: "first-helper-progress",
						sinceRequestMs: roundPerfMs(performance.now() - session.startupStartedAt),
						sinceHelperSpawnMs: roundPerfMs(performance.now() - session.helperSpawnedAt),
						currentFrame: progress.frames,
					});
				}
				emitProgress(session, {
					phase: "rendering",
					currentFrame: progress.frames,
					totalFrames: progress.totalFrames,
					fps: progress.fps,
				});
			}
		} catch (error) {
			session.stderr = tailText(
				`${session.stderr}\nInvalid helper progress line (${String(error)}): ${line}`,
			);
		}
	}
}

function consumeHelperStdout(session: NativeGpuExportSession, chunk: Buffer) {
	const text = chunk.toString("utf-8");
	session.stdout = tailText(session.stdout + text);
	session.stdoutBuffer += text;
	while (true) {
		const newline = session.stdoutBuffer.indexOf("\n");
		if (newline < 0) return;
		const line = session.stdoutBuffer.slice(0, newline).trim();
		session.stdoutBuffer = session.stdoutBuffer.slice(newline + 1);
		if (line) consumeHelperLine(session, line);
	}
}

async function prepareStaticAssets(
	ffmpeg: string,
	tempDir: string,
	payload: NativeGpuExportRequest,
) {
	const totalStartedAt = performance.now();
	const wallpaperPngPath = path.join(tempDir, "wallpaper.png");
	const wallpaperNv12Path = path.join(tempDir, "wallpaper.nv12");
	const wallpaperStartedAt = performance.now();
	await fs.writeFile(wallpaperPngPath, Buffer.from(payload.wallpaperPng));
	await runCapturedProcess(
		ffmpeg,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			wallpaperPngPath,
			"-frames:v",
			"1",
			"-pix_fmt",
			"nv12",
			"-f",
			"rawvideo",
			wallpaperNv12Path,
		],
		"Wallpaper conversion",
	);
	const wallpaperFinishedAt = performance.now();

	const overlays = [];
	const overlaysStartedAt = performance.now();
	for (let index = 0; index < payload.plan.overlays.length; index++) {
		const overlay = payload.plan.overlays[index];
		const overlayPngPath = path.join(tempDir, `overlay-${index}.png`);
		const overlayRgbaPath = path.join(tempDir, `overlay-${index}.rgba`);
		await fs.writeFile(overlayPngPath, Buffer.from(payload.overlayPngs[index]));
		await runCapturedProcess(
			ffmpeg,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-i",
				overlayPngPath,
				"-frames:v",
				"1",
				"-pix_fmt",
				"rgba",
				"-f",
				"rawvideo",
				overlayRgbaPath,
			],
			`Overlay ${index} conversion`,
		);
		overlays.push({ ...overlay, rgbaPath: overlayRgbaPath });
	}
	return {
		wallpaperNv12Path,
		overlays,
		performance: {
			wallpaperMs: wallpaperFinishedAt - wallpaperStartedAt,
			overlaysMs: performance.now() - overlaysStartedAt,
			totalMs: performance.now() - totalStartedAt,
		},
	};
}

async function runMux(session: NativeGpuExportSession, command: string, args: string[]) {
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	session.muxProcess = child;
	child.stdout?.on("data", (chunk: Buffer) => {
		session.stdout = tailText(session.stdout + chunk.toString("utf-8"));
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		session.stderr = tailText(session.stderr + chunk.toString("utf-8"));
	});
	const result = await processExit(child);
	session.muxProcess = null;
	if (session.cancelled) throw new Error("Native GPU export cancelled");
	if (result.error || result.code !== 0) {
		throw new Error(
			`Audio mux failed: ${result.error?.message || session.stderr || `exit code ${result.code}`}`,
		);
	}
}

async function cleanupSession(session: NativeGpuExportSession) {
	await fs.rm(session.tempDir, { recursive: true, force: true }).catch((error) => {
		console.warn("[native-gpu-export] Failed to remove temporary export directory", {
			tempDir: session.tempDir,
			error: String(error),
		});
	});
}

export function registerNativeGpuExportHandlers(dependencies: NativeGpuExportDependencies) {
	ipcMain.handle(
		NATIVE_GPU_EXPORT_CHANNELS.start,
		async (event, payload: NativeGpuExportRequest) => {
			const requestStartedAt = performance.now();
			const startupId = randomUUID();
			let tempDir: string | null = null;
			try {
				if (process.platform !== "linux") {
					throw new Error(
						`Native GPU export requires Linux; current platform is ${process.platform}`,
					);
				}
				const validationStartedAt = performance.now();
				validateRequest(payload);
				logNativeNvencMainPerf({
					startupId,
					phase: "validate-request",
					durationMs: roundPerfMs(performance.now() - validationStartedAt),
					frames: payload.plan.frames.length,
					overlays: payload.plan.overlays.length,
				});
				const helperPath = findLinuxExportHelperPath();
				if (!helperPath) {
					throw new Error(
						`Required ${HELPER_NAME} binary was not found. Run npm run build:native:linux-export.`,
					);
				}
				const inputPath = dependencies.resolveApprovedVideoPath(payload.plan.inputPath);
				if (!inputPath) {
					throw new Error("Native GPU export input path is invalid or unapproved");
				}
				let webcamInputPath: string | undefined;
				if (payload.plan.webcam) {
					webcamInputPath =
						dependencies.resolveApprovedVideoPath(payload.plan.webcam.inputPath) ?? undefined;
					if (!webcamInputPath) {
						throw new Error("Native GPU export webcam path is invalid or unapproved");
					}
				}
				let audioPath: string | undefined;
				if (payload.audioPath) {
					audioPath = dependencies.resolveApprovedVideoPath(payload.audioPath) ?? undefined;
					if (!audioPath) {
						throw new Error("Native GPU export audio path is invalid or unapproved");
					}
				}
				const outputPath =
					typeof payload.outputPath === "string" ? path.normalize(payload.outputPath) : "";
				if (!path.isAbsolute(outputPath) || !outputPath.toLowerCase().endsWith(".mp4")) {
					throw new Error("Native GPU export output path is invalid");
				}
				await fs.mkdir(path.dirname(outputPath), { recursive: true });
				tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-native-gpu-export-"));
				const assets = await prepareStaticAssets(dependencies.getFfmpegBinary(), tempDir, payload);
				logNativeNvencMainPerf({
					startupId,
					phase: "prepare-static-assets",
					durationMs: roundPerfMs(assets.performance.totalMs),
					wallpaperMs: roundPerfMs(assets.performance.wallpaperMs),
					overlaysMs: roundPerfMs(assets.performance.overlaysMs),
					overlays: payload.plan.overlays.length,
				});
				const planPath = path.join(tempDir, "plan.json");
				const videoOnlyPath = path.join(tempDir, "video.mp4");
				const planSerializationStartedAt = performance.now();
				const serializedPlan = JSON.stringify({
					...payload.plan,
					inputPath,
					...(payload.plan.webcam && webcamInputPath
						? { webcam: { ...payload.plan.webcam, inputPath: webcamInputPath } }
						: {}),
					wallpaperNv12Path: assets.wallpaperNv12Path,
					overlays: assets.overlays,
				});
				const planSerializedAt = performance.now();
				await fs.writeFile(planPath, serializedPlan);
				logNativeNvencMainPerf({
					startupId,
					phase: "write-plan",
					serializeMs: roundPerfMs(planSerializedAt - planSerializationStartedAt),
					writeMs: roundPerfMs(performance.now() - planSerializedAt),
					bytes: Buffer.byteLength(serializedPlan),
				});
				const helperSpawnedAt = performance.now();
				const child = spawn(helperPath, ["--plan", planPath, videoOnlyPath], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				const sessionId = startupId;
				const session: NativeGpuExportSession = {
					id: sessionId,
					helperProcess: child,
					helperExit: processExit(child),
					muxProcess: null,
					tempDir,
					videoOnlyPath,
					outputPath,
					audioPath,
					sourceDurationSec: payload.sourceDurationSec,
					trimRegions: payload.trimRegions,
					speedRegions: payload.speedRegions,
					ensureAudioTrack: payload.ensureAudioTrack === true,
					totalFrames: payload.plan.frames.length,
					frameRate: payload.plan.frameRate,
					sender: event.sender,
					stdout: "",
					stderr: "",
					stdoutBuffer: "",
					cancelled: false,
					startupStartedAt: requestStartedAt,
					helperSpawnedAt,
					firstProgressLogged: false,
				};
				child.stdout?.on("data", (chunk: Buffer) => consumeHelperStdout(session, chunk));
				child.stderr?.on("data", (chunk: Buffer) => {
					session.stderr = tailText(session.stderr + chunk.toString("utf-8"));
				});
				sessions.set(sessionId, session);
				logNativeNvencMainPerf({
					startupId,
					phase: "startup-total",
					durationMs: roundPerfMs(performance.now() - requestStartedAt),
					frames: session.totalFrames,
					overlays: payload.plan.overlays.length,
				});
				console.info("[native-gpu-export] Started zero-copy export", {
					helperPath,
					inputPath,
					webcamInputPath,
					outputPath,
					frames: session.totalFrames,
					audio: Boolean(audioPath),
				});
				return { success: true, sessionId };
			} catch (error) {
				logNativeNvencMainPerf({
					startupId,
					phase: "startup-failed",
					durationMs: roundPerfMs(performance.now() - requestStartedAt),
					error: error instanceof Error ? error.message : String(error),
				});
				if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
				console.error("[native-gpu-export] Failed to start required export", error);
				return {
					success: false,
					message: "Failed to start required native GPU export",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
	);

	ipcMain.handle(NATIVE_GPU_EXPORT_CHANNELS.finish, async (_, sessionId: string) => {
		const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
		if (!session) return { success: false, message: "Native GPU export session not found" };
		try {
			const helperResult = await session.helperExit;
			if (session.cancelled) return { success: false, message: "Native GPU export cancelled" };
			if (helperResult.error || helperResult.code !== 0) {
				throw new Error(
					`CUDA compositor failed: ${
						helperResult.error?.message ||
						session.stderr ||
						session.stdout ||
						`exit code ${helperResult.code}`
					}`,
				);
			}
			emitProgress(session, {
				phase: "finalizing",
				currentFrame: session.totalFrames,
				totalFrames: session.totalFrames,
				fps: 0,
			});
			if (session.audioPath || session.ensureAudioTrack) {
				const audioFilter = dependencies.buildAudioTimelineFilter(
					session.sourceDurationSec,
					session.trimRegions,
					session.speedRegions,
				);
				await runMux(
					session,
					dependencies.getFfmpegBinary(),
					buildNativeGpuAudioMuxArgs(
						{
							videoOnlyPath: session.videoOnlyPath,
							audioPath: session.audioPath,
							outputPath: session.outputPath,
							ensureAudioTrack: session.ensureAudioTrack,
							totalFrames: session.totalFrames,
							frameRate: session.frameRate,
						},
						audioFilter,
					),
				);
			} else {
				await fs.copyFile(session.videoOnlyPath, session.outputPath);
			}
			console.info("[native-gpu-export] Completed zero-copy export", {
				outputPath: session.outputPath,
				stdout: tailText(session.stdout, 2000),
			});
			return {
				success: true,
				path: session.outputPath,
				message: "Video exported successfully",
				stderr: session.stderr,
			};
		} catch (error) {
			console.error("[native-gpu-export] Required export failed", {
				error: error instanceof Error ? error.message : String(error),
				stderr: session.stderr,
				stdout: session.stdout,
			});
			return {
				success: false,
				message: "Required native GPU export failed",
				error: error instanceof Error ? error.message : String(error),
				stderr: session.stderr,
			};
		} finally {
			sessions.delete(sessionId);
			await cleanupSession(session);
		}
	});

	ipcMain.handle(NATIVE_GPU_EXPORT_CHANNELS.cancel, async (_, sessionId: string) => {
		const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
		if (!session) return { success: true };
		session.cancelled = true;
		if (!session.helperProcess.killed) session.helperProcess.kill("SIGKILL");
		if (session.muxProcess && !session.muxProcess.killed) session.muxProcess.kill("SIGKILL");
		return { success: true };
	});
}
