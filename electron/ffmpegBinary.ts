import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

interface ResolveFfmpegBinaryOptions {
	explicitPath?: string;
	platform: NodeJS.Platform;
	resourcesPath?: string;
	isExecutable?: (candidate: string) => boolean;
}

function isExecutable(candidate: string) {
	try {
		accessSync(candidate, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function resolveFfmpegBinary({
	explicitPath,
	platform,
	resourcesPath,
	isExecutable: canExecute = isExecutable,
}: ResolveFfmpegBinaryOptions) {
	const configuredPath = explicitPath?.trim();
	if (configuredPath) {
		return configuredPath;
	}

	const executableName = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
	const candidates = [
		resourcesPath ? path.join(resourcesPath, "ffmpeg", executableName) : null,
		...(platform === "darwin"
			? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]
			: []),
		...(platform === "linux" ? ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"] : []),
	].filter((candidate): candidate is string => Boolean(candidate));

	return candidates.find(canExecute) ?? executableName;
}
