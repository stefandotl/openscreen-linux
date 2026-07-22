import { NATIVE_NVDEC_FRAME_PORT_MESSAGE } from "./nativeNvdecFramePortProtocol";

export type NativeNvdecFramePortResult = {
	success: boolean;
	message?: string;
	error?: string;
	stderr?: string;
};

export type NativeNvdecFrame = {
	frame: VideoFrame;
	frameIndex: number;
};

export function createNativeNvdecVideoFrame(
	chunk: ArrayBuffer,
	config: { width: number; height: number; frameRate: number },
	frameIndex: number,
): VideoFrame {
	const expectedBytes = Math.ceil((config.width * config.height * 3) / 2);
	if (chunk.byteLength !== expectedBytes) {
		throw new Error(`Native NVDEC frame has ${chunk.byteLength} bytes; expected ${expectedBytes}`);
	}
	const yPlaneBytes = config.width * config.height;
	return new VideoFrame(chunk, {
		format: "NV12",
		codedWidth: config.width,
		codedHeight: config.height,
		displayWidth: config.width,
		displayHeight: config.height,
		timestamp: Math.round((frameIndex * 1_000_000) / config.frameRate),
		duration: Math.round(1_000_000 / config.frameRate),
		layout: [
			{ offset: 0, stride: config.width },
			{ offset: yPlaneBytes, stride: config.width },
		],
		colorSpace: {
			primaries: "bt709",
			transfer: "bt709",
			matrix: "bt709",
			fullRange: false,
		},
	});
}

type NativeNvdecWireMessage =
	| { type: "frame"; frameId: number; frameIndex: number; chunk: ArrayBuffer }
	| { type: "complete"; result: NativeNvdecFramePortResult; frameCount?: number };

type PendingRead = {
	resolve: (message: NativeNvdecWireMessage) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};

type FramePortSession = {
	port: MessagePort;
	ready: Promise<NativeNvdecFramePortResult>;
	resolveReady: (result: NativeNvdecFramePortResult) => void;
	readyTimeout: ReturnType<typeof setTimeout>;
	queuedMessage?: NativeNvdecWireMessage;
	pendingRead?: PendingRead;
	failure?: Error;
};

const PORT_HANDSHAKE_TIMEOUT_MS = 5000;
const FRAME_READ_TIMEOUT_MS = 30_000;
const framePortSessions = new Map<string, FramePortSession>();
const registrationWaiters = new Map<string, Set<(session: FramePortSession | null) => void>>();

function resolveRegistrationWaiters(sessionId: string, session: FramePortSession | null) {
	const waiters = registrationWaiters.get(sessionId);
	if (!waiters) return;
	registrationWaiters.delete(sessionId);
	for (const resolve of waiters) resolve(session);
}

function failSession(sessionId: string, message: string) {
	const session = framePortSessions.get(sessionId);
	if (!session) return;

	const error = new Error(message);
	session.failure = error;
	clearTimeout(session.readyTimeout);
	session.resolveReady({ success: false, message });
	if (session.pendingRead) {
		clearTimeout(session.pendingRead.timeout);
		session.pendingRead.reject(error);
		session.pendingRead = undefined;
	}
	resolveRegistrationWaiters(sessionId, null);
}

function enqueueMessage(sessionId: string, message: NativeNvdecWireMessage) {
	const session = framePortSessions.get(sessionId);
	if (!session || session.failure) return;

	if (session.pendingRead) {
		const pending = session.pendingRead;
		session.pendingRead = undefined;
		clearTimeout(pending.timeout);
		pending.resolve(message);
		return;
	}

	if (session.queuedMessage) {
		failSession(sessionId, "Native NVDEC sent frames without respecting backpressure");
		return;
	}
	session.queuedMessage = message;
}

function registerFramePort(sessionId: string, port: MessagePort) {
	closeNativeNvdecFramePort(sessionId);
	let resolveReady!: (result: NativeNvdecFramePortResult) => void;
	const ready = new Promise<NativeNvdecFramePortResult>((resolve) => {
		resolveReady = resolve;
	});
	const session: FramePortSession = {
		port,
		ready,
		resolveReady,
		readyTimeout: setTimeout(() => {
			failSession(sessionId, "Native NVDEC frame port handshake timed out");
		}, PORT_HANDSHAKE_TIMEOUT_MS),
	};

	port.onmessage = (event: MessageEvent) => {
		const data = event.data as {
			type?: unknown;
			frameId?: unknown;
			frameIndex?: unknown;
			chunk?: unknown;
			result?: NativeNvdecFramePortResult;
			frameCount?: unknown;
		};
		if (data?.type === "ready") {
			clearTimeout(session.readyTimeout);
			session.resolveReady({ success: true });
			return;
		}
		if (
			data?.type === "frame" &&
			typeof data.frameId === "number" &&
			typeof data.frameIndex === "number" &&
			data.chunk instanceof ArrayBuffer
		) {
			enqueueMessage(sessionId, {
				type: "frame",
				frameId: data.frameId,
				frameIndex: data.frameIndex,
				chunk: data.chunk,
			});
			return;
		}
		if (data?.type === "complete" && data.result) {
			enqueueMessage(sessionId, {
				type: "complete",
				result: data.result,
				frameCount: typeof data.frameCount === "number" ? data.frameCount : undefined,
			});
			return;
		}
		failSession(sessionId, "Native NVDEC frame port received an invalid message");
	};
	port.onmessageerror = () => {
		failSession(sessionId, "Native NVDEC frame port could not deserialize a message");
	};
	port.start();
	framePortSessions.set(sessionId, session);
	resolveRegistrationWaiters(sessionId, session);
}

if (typeof window !== "undefined") {
	window.addEventListener("message", (event) => {
		const data = event.data as { type?: string; sessionId?: string };
		if (
			data?.type !== NATIVE_NVDEC_FRAME_PORT_MESSAGE ||
			typeof data.sessionId !== "string" ||
			!event.ports[0]
		) {
			return;
		}
		registerFramePort(data.sessionId, event.ports[0]);
	});
}

async function waitForRegistration(sessionId: string): Promise<FramePortSession | null> {
	const existing = framePortSessions.get(sessionId);
	if (existing) return existing;

	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			const waiters = registrationWaiters.get(sessionId);
			waiters?.delete(onRegistered);
			if (waiters?.size === 0) registrationWaiters.delete(sessionId);
			resolve(null);
		}, PORT_HANDSHAKE_TIMEOUT_MS);
		const onRegistered = (session: FramePortSession | null) => {
			clearTimeout(timeout);
			resolve(session);
		};
		const waiters = registrationWaiters.get(sessionId) ?? new Set();
		waiters.add(onRegistered);
		registrationWaiters.set(sessionId, waiters);
	});
}

export async function waitForNativeNvdecFramePort(
	sessionId: string,
): Promise<NativeNvdecFramePortResult> {
	const session = await waitForRegistration(sessionId);
	if (!session) {
		return { success: false, message: "Required native NVDEC frame port was not delivered" };
	}
	return session.ready;
}

async function readWireMessage(session: FramePortSession): Promise<NativeNvdecWireMessage> {
	if (session.failure) throw session.failure;
	if (session.queuedMessage) {
		const message = session.queuedMessage;
		session.queuedMessage = undefined;
		return message;
	}
	if (session.pendingRead) {
		throw new Error("Native NVDEC already has a pending frame read");
	}

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (session.pendingRead?.resolve === resolve) session.pendingRead = undefined;
			reject(new Error("Timed out waiting for the next native NVDEC frame"));
		}, FRAME_READ_TIMEOUT_MS);
		session.pendingRead = { resolve, reject, timeout };
	});
}

export async function readNativeNvdecFrame(
	sessionId: string,
	config: { width: number; height: number; frameRate: number },
): Promise<NativeNvdecFrame | null> {
	const session = framePortSessions.get(sessionId);
	if (!session) throw new Error("Required native NVDEC frame port is not connected");
	const message = await readWireMessage(session);

	if (message.type === "complete") {
		framePortSessions.delete(sessionId);
		session.port.close();
		if (!message.result.success) {
			throw new Error(
				[message.result.message, message.result.error, message.result.stderr]
					.filter(Boolean)
					.join(": ") || "Required native NVDEC decode failed",
			);
		}
		return null;
	}

	let result: NativeNvdecFramePortResult = { success: true };
	try {
		const frame = createNativeNvdecVideoFrame(message.chunk, config, message.frameIndex);
		return { frame, frameIndex: message.frameIndex };
	} catch (error) {
		result = {
			success: false,
			message: "Renderer rejected native NVDEC frame",
			error: error instanceof Error ? error.message : String(error),
		};
		throw error;
	} finally {
		session.port.postMessage({ type: "ack", frameId: message.frameId, result });
	}
}

export function closeNativeNvdecFramePort(sessionId: string) {
	const session = framePortSessions.get(sessionId);
	if (!session) return;

	framePortSessions.delete(sessionId);
	clearTimeout(session.readyTimeout);
	session.port.close();
	session.resolveReady({ success: false, message: "Native NVDEC frame port closed" });
	if (session.pendingRead) {
		clearTimeout(session.pendingRead.timeout);
		session.pendingRead.reject(new Error("Native NVDEC frame port closed"));
		session.pendingRead = undefined;
	}
}
