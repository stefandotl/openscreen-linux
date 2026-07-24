import {
	DEFAULT_EDITOR_LAYOUT_SETTINGS,
	DEFAULT_EXPORT_SETTINGS,
} from "@/components/video-editor/editorDefaults";
import {
	type AnnotationTextStyle,
	DEFAULT_ANNOTATION_STYLE,
} from "@/components/video-editor/types";
import { normalizeTextAnimation } from "@/lib/annotationTextAnimation";
import type { ExportFormat, ExportQuality } from "@/lib/exporter";
import {
	DEFAULT_RECORDING_PREFS,
	normalizeRecordingPreferences,
	type RecordingPreferences,
} from "@/lib/recordingPreferences";
import type { AspectRatio } from "@/utils/aspectRatioUtils";

export {
	DEFAULT_RECORDING_PREFS,
	type PreferredCaptureSource,
	type RecordingPreferences,
} from "@/lib/recordingPreferences";

const PREFS_KEY = "openscreen_user_preferences";

const VALID_ASPECT_RATIOS: readonly string[] = [
	"16:9",
	"9:16",
	"1:1",
	"4:3",
	"4:5",
	"16:10",
	"10:16",
	"native",
];

export interface UserPreferences {
	/** Default padding % */
	padding: number;
	/** Default aspect ratio */
	aspectRatio: AspectRatio;
	/** Default export quality */
	exportQuality: ExportQuality;
	/** Default export format */
	exportFormat: ExportFormat;
	/** Folder used for the most recent successful export, if any */
	exportFolder: string | null;
	/** Folder of the most recently opened project, if any */
	projectFolder: string | null;
	/** Recording HUD control layout */
	trayLayout: "horizontal" | "vertical";
	/** Most recently edited text/caption style, used as the default for new videos */
	lastAnnotationStyle: AnnotationTextStyle | null;
	/** Last recording-bar configuration, restored when the HUD starts */
	recording: RecordingPreferences;
}

export const DEFAULT_PREFS: UserPreferences = {
	padding: DEFAULT_EDITOR_LAYOUT_SETTINGS.padding,
	aspectRatio: DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio,
	exportQuality: DEFAULT_EXPORT_SETTINGS.quality,
	exportFormat: DEFAULT_EXPORT_SETTINGS.format,
	exportFolder: null,
	projectFolder: null,
	trayLayout: "horizontal",
	lastAnnotationStyle: null,
	recording: DEFAULT_RECORDING_PREFS,
};

/** Parses stored preferences without throwing on malformed JSON. */
function safeJsonParse(text: string | null): Record<string, unknown> | null {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function normalizeStoredAnnotationStyle(value: unknown): AnnotationTextStyle | null {
	if (!value || typeof value !== "object") return null;
	const style = value as Partial<Record<keyof AnnotationTextStyle, unknown>>;

	return {
		color: typeof style.color === "string" ? style.color : DEFAULT_ANNOTATION_STYLE.color,
		backgroundColor:
			typeof style.backgroundColor === "string"
				? style.backgroundColor
				: DEFAULT_ANNOTATION_STYLE.backgroundColor,
		fontSize:
			typeof style.fontSize === "number" &&
			Number.isFinite(style.fontSize) &&
			style.fontSize >= 1 &&
			style.fontSize <= 512
				? style.fontSize
				: DEFAULT_ANNOTATION_STYLE.fontSize,
		fontFamily:
			typeof style.fontFamily === "string" && style.fontFamily.trim()
				? style.fontFamily
				: DEFAULT_ANNOTATION_STYLE.fontFamily,
		fontWeight: style.fontWeight === "normal" ? "normal" : DEFAULT_ANNOTATION_STYLE.fontWeight,
		fontStyle: style.fontStyle === "italic" ? "italic" : DEFAULT_ANNOTATION_STYLE.fontStyle,
		textDecoration:
			style.textDecoration === "underline" ? "underline" : DEFAULT_ANNOTATION_STYLE.textDecoration,
		textAlign:
			style.textAlign === "left" || style.textAlign === "right"
				? style.textAlign
				: DEFAULT_ANNOTATION_STYLE.textAlign,
		textAnimation: normalizeTextAnimation(
			typeof style.textAnimation === "string" ? style.textAnimation : undefined,
		),
		wordHighlight:
			typeof style.wordHighlight === "boolean"
				? style.wordHighlight
				: DEFAULT_ANNOTATION_STYLE.wordHighlight,
		textStrokeWidth:
			typeof style.textStrokeWidth === "number" &&
			Number.isFinite(style.textStrokeWidth) &&
			style.textStrokeWidth >= 0 &&
			style.textStrokeWidth <= 16
				? style.textStrokeWidth
				: DEFAULT_ANNOTATION_STYLE.textStrokeWidth,
		textStrokeColor:
			typeof style.textStrokeColor === "string"
				? style.textStrokeColor
				: DEFAULT_ANNOTATION_STYLE.textStrokeColor,
		wordHighlightMode:
			style.wordHighlightMode === "text" ? "text" : DEFAULT_ANNOTATION_STYLE.wordHighlightMode,
		wordHighlightColor:
			typeof style.wordHighlightColor === "string"
				? style.wordHighlightColor
				: DEFAULT_ANNOTATION_STYLE.wordHighlightColor,
	};
}

/** Load preferences from localStorage, falling back to defaults for missing or invalid fields. */
export function loadUserPreferences(): UserPreferences {
	let raw: Record<string, unknown> | null = null;
	try {
		raw = safeJsonParse(localStorage.getItem(PREFS_KEY));
	} catch {
		return { ...DEFAULT_PREFS };
	}
	if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFS };

	return {
		padding:
			typeof raw.padding === "number" &&
			Number.isFinite(raw.padding) &&
			raw.padding >= 0 &&
			raw.padding <= 100
				? raw.padding
				: DEFAULT_PREFS.padding,
		aspectRatio:
			typeof raw.aspectRatio === "string" && VALID_ASPECT_RATIOS.includes(raw.aspectRatio)
				? (raw.aspectRatio as AspectRatio)
				: DEFAULT_PREFS.aspectRatio,
		exportQuality:
			raw.exportQuality === "medium" ||
			raw.exportQuality === "good" ||
			raw.exportQuality === "source"
				? (raw.exportQuality as ExportQuality)
				: DEFAULT_PREFS.exportQuality,
		exportFormat:
			raw.exportFormat === "gif" || raw.exportFormat === "mp4"
				? (raw.exportFormat as ExportFormat)
				: DEFAULT_PREFS.exportFormat,
		exportFolder:
			typeof raw.exportFolder === "string" && raw.exportFolder.length > 0
				? raw.exportFolder
				: DEFAULT_PREFS.exportFolder,
		projectFolder:
			typeof raw.projectFolder === "string" && raw.projectFolder.length > 0
				? raw.projectFolder
				: DEFAULT_PREFS.projectFolder,
		trayLayout:
			raw.trayLayout === "horizontal" || raw.trayLayout === "vertical"
				? raw.trayLayout
				: DEFAULT_PREFS.trayLayout,
		lastAnnotationStyle: normalizeStoredAnnotationStyle(raw.lastAnnotationStyle),
		recording: normalizeRecordingPreferences(raw.recording),
	};
}

/**
 * Parent directory of a saved file path. Handles both POSIX and Windows
 * separators since the path comes from the OS save dialog. Root dirs keep their
 * trailing separator so the result stays a valid directory ("/video.mp4" -> "/",
 * "C:\\video.mp4" -> "C:\\"). Returns null if no separator is found.
 */
export function parentDirectoryOf(filePath: string): string | null {
	const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	if (lastSep < 0) return null;

	// POSIX root, e.g. "/video.mp4" -> "/"
	if (lastSep === 0) return filePath[0];

	// Windows drive root, e.g. "C:\\video.mp4" -> "C:\\"
	if (lastSep === 2 && /^[A-Za-z]:[/\\]/.test(filePath)) {
		return filePath.slice(0, lastSep + 1);
	}

	return filePath.slice(0, lastSep);
}

/** Remembered export folder as `string | undefined`, for IPC handlers that treat absence as "use the default". */
export function getExportFolder(): string | undefined {
	return loadUserPreferences().exportFolder ?? undefined;
}

/** Remembered open-project folder as `string | undefined`, for IPC handlers that treat absence as "use the default". */
export function getProjectFolder(): string | undefined {
	return loadUserPreferences().projectFolder ?? undefined;
}

/** Persist preferences to localStorage; only the provided fields are updated. */
export function saveUserPreferences(partial: Partial<UserPreferences>): void {
	const current = loadUserPreferences();
	const merged = { ...current, ...partial };
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
	} catch {
		// localStorage may be unavailable (e.g. private browsing, quota exceeded)
	}
}

/** Persist only recording-bar fields while retaining the rest of the last configuration. */
export function saveRecordingPreferences(partial: Partial<RecordingPreferences>): void {
	const current = loadUserPreferences().recording;
	saveUserPreferences({ recording: { ...current, ...partial } });
}
