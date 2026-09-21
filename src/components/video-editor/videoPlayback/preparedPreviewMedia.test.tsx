import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePreparedPreviewMedia } from "./preparedPreviewMedia";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolver) => {
		resolve = resolver;
	});
	return { promise, resolve };
}

describe("usePreparedPreviewMedia", () => {
	it("keeps a webcam-only scene visible until the next scene media is ready", async () => {
		const pending = new Map<string, ReturnType<typeof deferred<{ success: true; path: string }>>>();
		const preparePreviewVideo = vi.fn((path: string) => {
			const request = deferred<{ success: true; path: string }>();
			pending.set(path, request);
			return request.promise;
		});
		const onError = vi.fn();
		const { result, rerender } = renderHook(
			({ videoPath, webcamVideoPath }) =>
				usePreparedPreviewMedia({
					videoPath,
					webcamVideoPath,
					preparePreviewVideo,
					onError,
				}),
			{
				initialProps: {
					videoPath: "scene-1-screen.webm",
					webcamVideoPath: "scene-1-webcam.webm" as string | undefined,
				},
			},
		);

		await act(async () => {
			pending
				.get("scene-1-screen.webm")
				?.resolve({ success: true, path: "scene-1-screen-preview.webm" });
			pending
				.get("scene-1-webcam.webm")
				?.resolve({ success: true, path: "scene-1-webcam-preview.webm" });
			await Promise.resolve();
		});
		expect(result.current).toEqual({
			sourceVideoPath: "scene-1-screen.webm",
			videoPath: "scene-1-screen-preview.webm",
			webcamVideoPath: "scene-1-webcam-preview.webm",
		});

		rerender({
			videoPath: "scene-2-screen.webm",
			webcamVideoPath: "scene-2-webcam.webm",
		});
		expect(result.current).toEqual({
			sourceVideoPath: "scene-1-screen.webm",
			videoPath: "scene-1-screen-preview.webm",
			webcamVideoPath: "scene-1-webcam-preview.webm",
		});

		await act(async () => {
			pending
				.get("scene-2-screen.webm")
				?.resolve({ success: true, path: "scene-2-screen-preview.webm" });
			await Promise.resolve();
		});
		expect(result.current?.webcamVideoPath).toBe("scene-1-webcam-preview.webm");

		await act(async () => {
			pending
				.get("scene-2-webcam.webm")
				?.resolve({ success: true, path: "scene-2-webcam-preview.webm" });
			await Promise.resolve();
		});
		expect(result.current).toEqual({
			sourceVideoPath: "scene-2-screen.webm",
			videoPath: "scene-2-screen-preview.webm",
			webcamVideoPath: "scene-2-webcam-preview.webm",
		});
		expect(onError).not.toHaveBeenCalled();
	});
});
