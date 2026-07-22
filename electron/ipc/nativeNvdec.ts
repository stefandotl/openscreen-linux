import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { MessagePortMain } from "electron";
import {
	EXPORT_TIMELINE_EPSILON_SEC,
	type ExportTimelineSegment,
} from "../../src/lib/exporter/exportTimeline";

export type NativeNvdecStartOptions = {
	inputPath: string;
	width: number;
	height: number;
	frameRate: number;
	timelineSegments: ExportTimelineSegment[];
	totalFrames: number;
	ffmpegPath: string;
};

type NativeNvdecResult = {
	success: boolean;
	message?: string;
	error?: string;
	stderr?: string;
};

type ProcessExit = {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
};

type PendingAcknowledgement = {
	frameId: number;
	resolve: () => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};

type NativeNvdecSession = {
	process: ChildProcessWithoutNullStreams;
	inputPath: string;
	width: number;
	height: number;
	frameRate: number;
	frameBytes: number;
	totalFrames: number;
	stderr: string;
	framePort?: MessagePortMain;
	pumpStarted: boolean;
	cancelled: boolean;
	completed: boolean;
	pendingAcknowledgement?: PendingAcknowledgement;
	exitPromise: Promise<ProcessExit>;
	perf: {
		startedAtMs: number;
		lastLogAtMs: number;
		frames: number;
		bytes: number;
		portPostMs: number;
		ackWaitMs: number;
		maxAckWaitMs: number;
	};
};

const FRAME_ACK_TIMEOUT_MS = 30_000;
const nativeNvdecSessions = new Map<string, NativeNvdecSession>();

function tailText(text: string, maxLength = 8000) {
	return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

function formatFfmpegNumber(value: number): string {
	return value.toFixed(6).replace(/\.?0+$/, "") || "0";
}

export function buildNativeNvdecVideoFilter(
	timelineSegments: ExportTimelineSegment[],
	frameRate: number,
): string {
	const selectExpression = timelineSegments
		.map(
			(segment) =>
				`gte(t,${formatFfmpegNumber(segment.startSec)})*lt(t,${formatFfmpegNumber(segment.endSec)})`,
		)
		.join("+");

	let outputFrameOffset = 0;
	const mappings = timelineSegments.map((segment) => {
		const mapping = {
			...segment,
			outputOffsetSec: outputFrameOffset / frameRate,
		};
		const durationSec = segment.endSec - segment.startSec - EXPORT_TIMELINE_EPSILON_SEC;
		outputFrameOffset += Math.max(0, Math.ceil((durationSec / segment.speed) * frameRate));
		return mapping;
	});
	let setptsExpression = "NAN";
	for (let index = mappings.length - 1; index >= 0; index--) {
		const segment = mappings[index];
		const start = formatFfmpegNumber(segment.startSec);
		const end = formatFfmpegNumber(segment.endSec);
		const speed = formatFfmpegNumber(segment.speed);
		const outputOffset = formatFfmpegNumber(segment.outputOffsetSec);
		setptsExpression =
			`if(between(PTS*TB,${start},${end}),` +
			`(${outputOffset}+(PTS*TB-${start})/${speed})/TB,${setptsExpression})`;
	}

	return (
		`setpts=PTS-STARTPTS,select='${selectExpression}',setpts='${setptsExpression}',` +
		`fps=${formatFfmpegNumber(frameRate)}:start_time=0:round=near,` +
		"tpad=stop_mode=clone:stop=-1,hwdownload,format=nv12"
	);
}

export function buildNativeNvdecArgs(input: {
	inputPath: string;
	frameRate: number;
	timelineSegments: ExportTimelineSegment[];
	totalFrames: number;
}): string[] {
	const lastSegment = input.timelineSegments.at(-1);
	if (!lastSegment) throw new Error("Native NVDEC timeline contains no segments");

	return [
		"-hide_banner",
		"-nostdin",
		"-hwaccel",
		"cuda",
		"-hwaccel_device",
		"0",
		"-hwaccel_output_format",
		"cuda",
		"-to",
		formatFfmpegNumber(lastSegment.endSec),
		"-i",
		input.inputPath,
		"-map",
		"0:v:0",
		"-an",
		"-sn",
		"-dn",
		"-vf",
		buildNativeNvdecVideoFilter(input.timelineSegments, input.frameRate),
		"-frames:v",
		String(input.totalFrames),
		"-pix_fmt",
		"nv12",
		"-f",
		"rawvideo",
		"pipe:1",
	];
}

function maybeLogPerf(session: NativeNvdecSession, force = false) {
	const stats = session.perf;
	if (stats.frames === 0) return;

	const now = performance.now();
	if (!force && stats.frames % 120 !== 0 && now - stats.lastLogAtMs < 5000) return;

	const elapsedSec = Math.max((now - stats.startedAtMs) / 1000, 0.001);
	console.info(
		`[native-nvdec-main-perf] ${JSON.stringify({
			frames: stats.frames,
			feedFps: Number((stats.frames / elapsedSec).toFixed(2)),
			feedMiBps: Number((stats.bytes / (1024 * 1024) / elapsedSec).toFixed(2)),
			avgMs: {
				portPost: Number((stats.portPostMs / stats.frames).toFixed(3)),
				frameAck: Number((stats.ackWaitMs / stats.frames).toFixed(2)),
			},
			maxFrameAckMs: Number(stats.maxAckWaitMs.toFixed(2)),
		})}`,
	);
	stats.lastLogAtMs = now;
}

function rejectPendingAcknowledgement(session: NativeNvdecSession, error: Error) {
	const pending = session.pendingAcknowledgement;
	if (!pending) return;
	session.pendingAcknowledgement = undefined;
	clearTimeout(pending.timeout);
	pending.reject(error);
}

async function sendFrame(
	session: NativeNvdecSession,
	frameId: number,
	frame: Uint8Array,
): Promise<void> {
	const port = session.framePort;
	if (!port) throw new Error("Native NVDEC frame port is not connected");
	if (session.pendingAcknowledgement) {
		throw new Error("Native NVDEC attempted to send more than one unacknowledged frame");
	}

	let acknowledgementTimeout: ReturnType<typeof setTimeout> | undefined;
	const acknowledgement = new Promise<void>((resolve, reject) => {
		acknowledgementTimeout = setTimeout(() => {
			if (session.pendingAcknowledgement?.frameId === frameId) {
				session.pendingAcknowledgement = undefined;
			}
			reject(new Error(`Native NVDEC frame ${frameId} acknowledgement timed out`));
		}, FRAME_ACK_TIMEOUT_MS);
		session.pendingAcknowledgement = {
			frameId,
			resolve,
			reject,
			timeout: acknowledgementTimeout,
		};
	});

	const postStartedAtMs = performance.now();
	try {
		// MessagePortMain cannot transfer ArrayBuffer ownership reliably to the renderer.
		// Structured-clone the bounded single-frame payload and wait for its acknowledgement.
		port.postMessage({ type: "frame", frameId, frameIndex: frameId - 1, chunk: frame.buffer });
	} catch (error) {
		session.pendingAcknowledgement = undefined;
		if (acknowledgementTimeout) clearTimeout(acknowledgementTimeout);
		throw new Error(`Failed to send native NVDEC frame: ${String(error)}`);
	}
	session.perf.portPostMs += performance.now() - postStartedAtMs;

	const acknowledgementStartedAtMs = performance.now();
	await acknowledgement;
	const acknowledgementMs = performance.now() - acknowledgementStartedAtMs;
	session.perf.ackWaitMs += acknowledgementMs;
	session.perf.maxAckWaitMs = Math.max(session.perf.maxAckWaitMs, acknowledgementMs);
}

async function pumpFrames(sessionId: string, session: NativeNvdecSession) {
	let frame = new Uint8Array(session.frameBytes);
	let frameOffset = 0;
	let frameId = 1;

	try {
		for await (const value of session.process.stdout) {
			if (session.cancelled) break;
			const chunk = value as Buffer;
			let chunkOffset = 0;

			while (chunkOffset < chunk.byteLength && !session.cancelled) {
				const copyLength = Math.min(
					session.frameBytes - frameOffset,
					chunk.byteLength - chunkOffset,
				);
				frame.set(chunk.subarray(chunkOffset, chunkOffset + copyLength), frameOffset);
				frameOffset += copyLength;
				chunkOffset += copyLength;

				if (frameOffset !== session.frameBytes) continue;
				if (frameId === 1) {
					console.info("[native-nvdec] First decoded NV12 frame ready", {
						bytes: frame.byteLength,
						width: session.width,
						height: session.height,
					});
				}

				await sendFrame(session, frameId, frame);
				session.perf.frames++;
				session.perf.bytes += frame.byteLength;
				maybeLogPerf(session);
				frameId++;
				frame = new Uint8Array(session.frameBytes);
				frameOffset = 0;
			}
		}

		if (session.cancelled) return;
		const exit = await session.exitPromise;
		if (frameOffset !== 0) {
			throw new Error(
				`Native NVDEC produced a partial frame (${frameOffset}/${session.frameBytes} bytes)`,
			);
		}
		if (exit.error || exit.code !== 0) {
			throw new Error(
				exit.error?.message ||
					`Native NVDEC ffmpeg exited with code ${exit.code}${exit.signal ? ` (${exit.signal})` : ""}`,
			);
		}
		if (session.perf.frames !== session.totalFrames) {
			throw new Error(
				`Native NVDEC produced ${session.perf.frames}/${session.totalFrames} required frames`,
			);
		}

		maybeLogPerf(session, true);
		session.completed = true;
		session.framePort?.postMessage({
			type: "complete",
			result: { success: true } satisfies NativeNvdecResult,
			frameCount: session.perf.frames,
		});
		console.info("[native-nvdec] Decode completed", {
			inputPath: session.inputPath,
			frames: session.perf.frames,
		});
	} catch (error) {
		if (!session.cancelled) {
			const result = {
				success: false,
				message: "Required native NVDEC decode failed",
				error: error instanceof Error ? error.message : String(error),
				stderr: session.stderr,
			} satisfies NativeNvdecResult;
			console.warn("[native-nvdec] Decode failed", result);
			session.framePort?.postMessage({ type: "complete", result });
		}
	} finally {
		session.completed = true;
		rejectPendingAcknowledgement(session, new Error("Native NVDEC decode ended"));
		nativeNvdecSessions.delete(sessionId);
		if (!session.process.killed && session.process.exitCode === null) {
			session.process.kill("SIGKILL");
		}
	}
}

export function startNativeNvdecSession(options: NativeNvdecStartOptions): string {
	const args = buildNativeNvdecArgs(options);
	console.info("[native-nvdec] Starting ffmpeg decode", {
		ffmpeg: options.ffmpegPath,
		inputPath: options.inputPath,
		width: options.width,
		height: options.height,
		frameRate: options.frameRate,
		timelineSegments: options.timelineSegments.length,
		totalFrames: options.totalFrames,
		outputPixelFormat: "nv12",
	});

	const child = spawn(options.ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
	child.stdin.end();
	const sessionId = randomUUID();
	const now = performance.now();
	const session: NativeNvdecSession = {
		process: child,
		inputPath: options.inputPath,
		width: options.width,
		height: options.height,
		frameRate: options.frameRate,
		frameBytes: Math.ceil((options.width * options.height * 3) / 2),
		totalFrames: options.totalFrames,
		stderr: "",
		pumpStarted: false,
		cancelled: false,
		completed: false,
		perf: {
			startedAtMs: now,
			lastLogAtMs: now,
			frames: 0,
			bytes: 0,
			portPostMs: 0,
			ackWaitMs: 0,
			maxAckWaitMs: 0,
		},
		exitPromise: new Promise((resolve) => {
			child.once("error", (error) => resolve({ code: null, signal: null, error }));
			child.once("close", (code, signal) => resolve({ code, signal }));
		}),
	};
	child.stderr.on("data", (chunk: Buffer) => {
		session.stderr = tailText(session.stderr + chunk.toString("utf-8"));
	});
	nativeNvdecSessions.set(sessionId, session);
	return sessionId;
}

export function connectNativeNvdecSessionPort(sessionId: string, port: MessagePortMain): boolean {
	const session = nativeNvdecSessions.get(sessionId);
	if (!session || session.pumpStarted) {
		port.close();
		return false;
	}

	session.framePort = port;
	session.pumpStarted = true;
	port.on("message", (event) => {
		const data = event.data as {
			type?: unknown;
			frameId?: unknown;
			result?: NativeNvdecResult;
		};
		if (data?.type !== "ack" || typeof data.frameId !== "number") return;
		const pending = session.pendingAcknowledgement;
		if (!pending || pending.frameId !== data.frameId) return;
		session.pendingAcknowledgement = undefined;
		clearTimeout(pending.timeout);
		if (data.result?.success) {
			pending.resolve();
		} else {
			pending.reject(
				new Error(data.result?.message || data.result?.error || "NVDEC frame was rejected"),
			);
		}
	});
	port.on("close", () => {
		if (session.completed || session.cancelled) return;
		session.cancelled = true;
		rejectPendingAcknowledgement(session, new Error("Native NVDEC frame port closed"));
		if (!session.process.killed) session.process.kill("SIGKILL");
		nativeNvdecSessions.delete(sessionId);
	});
	port.start();
	port.postMessage({ type: "ready" });
	void pumpFrames(sessionId, session);
	console.info("[native-nvdec] Frame port connected", { sessionId });
	return true;
}

export function cancelNativeNvdecSession(sessionId: string): void {
	const session = nativeNvdecSessions.get(sessionId);
	if (!session) return;

	session.cancelled = true;
	nativeNvdecSessions.delete(sessionId);
	rejectPendingAcknowledgement(session, new Error("Native NVDEC decode cancelled"));
	session.framePort?.close();
	session.process.stdout.destroy();
	if (!session.process.killed) session.process.kill("SIGKILL");
}
