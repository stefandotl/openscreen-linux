import { NATIVE_NVENC_FRAME_PORT_MESSAGE } from "./nativeNvencFramePortProtocol";

export type NativeNvencFramePortResult = {
	success: boolean;
	message?: string;
	error?: string;
};

type PendingWrite = {
	resolve: (result: NativeNvencFramePortResult) => void;
	timeout: ReturnType<typeof setTimeout>;
};

type FramePortSession = {
	port: MessagePort;
	nextRequestId: number;
	pending: Map<number, PendingWrite>;
	ready: Promise<NativeNvencFramePortResult>;
	resolveReady: (result: NativeNvencFramePortResult) => void;
	readyTimeout: ReturnType<typeof setTimeout>;
};

const PORT_TIMEOUT_MS = 5000;
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

	framePortSessions.delete(sessionId);
	clearTimeout(session.readyTimeout);
	session.resolveReady({ success: false, message });
	for (const pending of session.pending.values()) {
		clearTimeout(pending.timeout);
		pending.resolve({ success: false, message });
	}
	session.pending.clear();
	resolveRegistrationWaiters(sessionId, null);
}

function registerFramePort(sessionId: string, port: MessagePort) {
	closeNativeNvencFramePort(sessionId);
	let resolveReady!: (result: NativeNvencFramePortResult) => void;
	const ready = new Promise<NativeNvencFramePortResult>((resolve) => {
		resolveReady = resolve;
	});
	const session: FramePortSession = {
		port,
		nextRequestId: 1,
		pending: new Map(),
		ready,
		resolveReady,
		readyTimeout: setTimeout(() => {
			failSession(sessionId, "Native NVENC frame port handshake timed out");
		}, PORT_TIMEOUT_MS),
	};

	port.onmessage = (event: MessageEvent) => {
		const data = event.data as {
			type?: string;
			requestId?: number;
			result?: NativeNvencFramePortResult;
		};
		if (data?.type === "ready") {
			clearTimeout(session.readyTimeout);
			session.resolveReady({ success: true });
			return;
		}
		if (typeof data?.requestId !== "number" || !data.result) return;
		const pending = session.pending.get(data.requestId);
		if (!pending) return;
		session.pending.delete(data.requestId);
		clearTimeout(pending.timeout);
		pending.resolve(data.result);
	};
	port.onmessageerror = () => {
		failSession(sessionId, "Native NVENC frame port received an invalid message");
	};
	port.start();
	framePortSessions.set(sessionId, session);
	resolveRegistrationWaiters(sessionId, session);
}

if (typeof window !== "undefined") {
	window.addEventListener("message", (event) => {
		const data = event.data as { type?: string; sessionId?: string };
		if (
			data?.type !== NATIVE_NVENC_FRAME_PORT_MESSAGE ||
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
		}, PORT_TIMEOUT_MS);
		const onRegistered = (session: FramePortSession | null) => {
			clearTimeout(timeout);
			resolve(session);
		};
		const waiters = registrationWaiters.get(sessionId) ?? new Set();
		waiters.add(onRegistered);
		registrationWaiters.set(sessionId, waiters);
	});
}

export async function waitForNativeNvencFramePort(
	sessionId: string,
): Promise<NativeNvencFramePortResult> {
	const session = await waitForRegistration(sessionId);
	if (!session) {
		return { success: false, message: "Required native NVENC frame port was not delivered" };
	}
	return session.ready;
}

export function writeNativeNvencFrame(
	sessionId: string,
	chunk: ArrayBuffer,
): Promise<NativeNvencFramePortResult> {
	const session = framePortSessions.get(sessionId);
	if (!session) {
		return Promise.resolve({
			success: false,
			message: "Required native NVENC frame port is not connected",
		});
	}

	const requestId = session.nextRequestId++;
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			session.pending.delete(requestId);
			resolve({
				success: false,
				message: `Native NVENC frame ${requestId} acknowledgement timed out`,
			});
		}, PORT_TIMEOUT_MS);
		session.pending.set(requestId, { resolve, timeout });
		try {
			// Electron can transfer the port itself to MessagePortMain, but not ArrayBuffer
			// ownership across this boundary. Including chunk in the transfer list stalls.
			session.port.postMessage({ requestId, chunk });
		} catch (error) {
			session.pending.delete(requestId);
			clearTimeout(timeout);
			resolve({
				success: false,
				message: "Failed to transfer native NVENC frame",
				error: String(error),
			});
		}
	});
}

export function closeNativeNvencFramePort(sessionId: string) {
	const session = framePortSessions.get(sessionId);
	if (!session) return;

	framePortSessions.delete(sessionId);
	clearTimeout(session.readyTimeout);
	session.port.close();
	session.resolveReady({ success: false, message: "Native NVENC frame port closed" });
	for (const pending of session.pending.values()) {
		clearTimeout(pending.timeout);
		pending.resolve({ success: false, message: "Native NVENC frame port closed" });
	}
	session.pending.clear();
}
