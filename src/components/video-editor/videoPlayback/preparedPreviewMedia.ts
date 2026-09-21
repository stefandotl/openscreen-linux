import { useEffect, useState } from "react";

export interface PreparedPreviewMediaPaths {
	sourceVideoPath: string;
	videoPath: string;
	webcamVideoPath?: string;
}

interface PreviewPreparationResult {
	success: boolean;
	path?: string;
	message?: string;
	error?: string;
}

interface UsePreparedPreviewMediaOptions {
	videoPath: string;
	webcamVideoPath?: string;
	preparePreviewVideo?: (filePath: string) => Promise<PreviewPreparationResult>;
	onError: (message: string) => void;
}

/**
 * Prepares both scene videos as one visual handoff. While the next pair is being
 * prepared, the previous pair remains mounted so a webcam-only scene cannot flash
 * its wallpaper between scenes.
 */
export function usePreparedPreviewMedia({
	videoPath,
	webcamVideoPath,
	preparePreviewVideo,
	onError,
}: UsePreparedPreviewMediaOptions): PreparedPreviewMediaPaths | null {
	const [preparedMediaPaths, setPreparedMediaPaths] = useState<PreparedPreviewMediaPaths | null>(
		null,
	);

	useEffect(() => {
		let cancelled = false;
		if (!videoPath || !preparePreviewVideo) {
			setPreparedMediaPaths({
				sourceVideoPath: videoPath,
				videoPath,
				...(webcamVideoPath ? { webcamVideoPath } : {}),
			});
			return () => {
				cancelled = true;
			};
		}

		const screenPreview = preparePreviewVideo(videoPath);
		const webcamPreview = webcamVideoPath
			? preparePreviewVideo(webcamVideoPath)
			: Promise.resolve(null);
		void Promise.all([screenPreview, webcamPreview])
			.then(([screenResult, webcamResult]) => {
				if (cancelled) return;
				if (!screenResult.success || !screenResult.path) {
					const detail = screenResult.error || screenResult.message || "Unknown preview error";
					onError(`Screen preview optimization failed: ${detail}`);
				}
				if (webcamResult && (!webcamResult.success || !webcamResult.path)) {
					const detail = webcamResult.error || webcamResult.message || "Unknown preview error";
					onError(`Webcam preview optimization failed: ${detail}`);
				}
				setPreparedMediaPaths({
					sourceVideoPath: videoPath,
					videoPath: screenResult.success && screenResult.path ? screenResult.path : videoPath,
					...(webcamVideoPath
						? {
								webcamVideoPath:
									webcamResult?.success && webcamResult.path ? webcamResult.path : webcamVideoPath,
							}
						: {}),
				});
			})
			.catch((error) => {
				if (cancelled) return;
				const detail = error instanceof Error ? error.message : String(error);
				onError(`Preview optimization failed: ${detail}`);
				setPreparedMediaPaths({
					sourceVideoPath: videoPath,
					videoPath,
					...(webcamVideoPath ? { webcamVideoPath } : {}),
				});
			});

		return () => {
			cancelled = true;
		};
	}, [onError, preparePreviewVideo, videoPath, webcamVideoPath]);

	return preparedMediaPaths;
}
