import type { CursorCaptureMode } from "@/lib/recordingSession";

export interface PreferredCaptureSource {
	id: string;
	name: string;
	displayId: string | null;
	kind: "screen" | "window";
}

export interface RecordingPreferences {
	microphoneEnabled: boolean;
	microphoneDeviceId: string | null;
	microphoneDeviceName: string | null;
	systemAudioEnabled: boolean;
	webcamEnabled: boolean;
	webcamDeviceId: string | null;
	webcamDeviceName: string | null;
	cursorCaptureMode: CursorCaptureMode;
	captureSource: PreferredCaptureSource | null;
}

export const DEFAULT_RECORDING_PREFS: RecordingPreferences = {
	microphoneEnabled: false,
	microphoneDeviceId: null,
	microphoneDeviceName: null,
	systemAudioEnabled: false,
	webcamEnabled: false,
	webcamDeviceId: null,
	webcamDeviceName: null,
	cursorCaptureMode: "editable-overlay",
	captureSource: null,
};

function optionalStoredString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function normalizeStoredCaptureSource(value: unknown): PreferredCaptureSource | null {
	if (!value || typeof value !== "object") return null;
	const source = value as Partial<Record<keyof PreferredCaptureSource, unknown>>;
	const id = optionalStoredString(source.id);
	const name = optionalStoredString(source.name);
	if (!id || !name) return null;

	return {
		id,
		name,
		displayId: optionalStoredString(source.displayId),
		kind:
			source.kind === "screen" || source.kind === "window"
				? source.kind
				: id.startsWith("window:")
					? "window"
					: "screen",
	};
}

export function normalizeRecordingPreferences(value: unknown): RecordingPreferences {
	const recording =
		value && typeof value === "object"
			? (value as Partial<Record<keyof RecordingPreferences, unknown>>)
			: {};

	return {
		microphoneEnabled:
			typeof recording.microphoneEnabled === "boolean"
				? recording.microphoneEnabled
				: DEFAULT_RECORDING_PREFS.microphoneEnabled,
		microphoneDeviceId: optionalStoredString(recording.microphoneDeviceId),
		microphoneDeviceName: optionalStoredString(recording.microphoneDeviceName),
		systemAudioEnabled:
			typeof recording.systemAudioEnabled === "boolean"
				? recording.systemAudioEnabled
				: DEFAULT_RECORDING_PREFS.systemAudioEnabled,
		webcamEnabled:
			typeof recording.webcamEnabled === "boolean"
				? recording.webcamEnabled
				: DEFAULT_RECORDING_PREFS.webcamEnabled,
		webcamDeviceId: optionalStoredString(recording.webcamDeviceId),
		webcamDeviceName: optionalStoredString(recording.webcamDeviceName),
		cursorCaptureMode:
			recording.cursorCaptureMode === "system" || recording.cursorCaptureMode === "editable-overlay"
				? recording.cursorCaptureMode
				: DEFAULT_RECORDING_PREFS.cursorCaptureMode,
		captureSource: normalizeStoredCaptureSource(recording.captureSource),
	};
}
