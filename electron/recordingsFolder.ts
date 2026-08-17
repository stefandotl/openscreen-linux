export interface OpenRecordingsFolderDependencies {
	ensureDirectory: (directoryPath: string) => Promise<void>;
	openPath: (directoryPath: string) => Promise<string>;
}

export interface OpenRecordingsFolderResult {
	success: boolean;
	error?: string;
}

export async function openRecordingsFolder(
	directoryPath: string,
	dependencies: OpenRecordingsFolderDependencies,
): Promise<OpenRecordingsFolderResult> {
	try {
		await dependencies.ensureDirectory(directoryPath);
		const openError = await dependencies.openPath(directoryPath);
		if (openError) {
			return { success: false, error: openError };
		}
		return { success: true };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
