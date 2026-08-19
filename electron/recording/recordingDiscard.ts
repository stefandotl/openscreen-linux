import path from "node:path";
import type { RecordingSession } from "../../src/lib/recordingSession";

const RECORDING_SESSION_SUFFIX = ".session.json";

function isPathWithinDir(filePath: string, dirPath: string): boolean {
	const resolved = path.resolve(filePath);
	const resolvedDir = path.resolve(dirPath);
	return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
}

function sessionManifestPathForVideo(videoPath: string): string {
	const parsedPath = path.parse(videoPath);
	const baseName = parsedPath.name.endsWith("-webcam")
		? parsedPath.name.slice(0, -"-webcam".length)
		: parsedPath.name;
	return path.join(parsedPath.dir, `${baseName}${RECORDING_SESSION_SUFFIX}`);
}

/**
 * Files to remove when discarding a recording session: the screen video, its
 * cursor-telemetry sidecar, the optional webcam sidecar, and the session
 * manifest. Only paths inside {@link recordingsDir} are ever deleted; imported
 * media or project assets elsewhere are left intact.
 */
export function getDiscardDeletionTargets(
	session: Pick<RecordingSession, "screenVideoPath" | "webcamVideoPath">,
	recordingsDir: string,
): string[] {
	const targets = new Set<string>();
	if (session.screenVideoPath) {
		targets.add(session.screenVideoPath);
		targets.add(`${session.screenVideoPath}.cursor.json`);
	}
	if (session.webcamVideoPath) {
		targets.add(session.webcamVideoPath);
	}
	targets.add(sessionManifestPathForVideo(session.screenVideoPath));

	return Array.from(targets).filter((target) => isPathWithinDir(target, recordingsDir));
}
