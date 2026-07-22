import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import { buildExportTimelineSegments, getExportSourceTimestampsMs } from "./exportTimeline";
import {
	closeNativeNvdecFramePort,
	readNativeNvdecFrame,
	waitForNativeNvdecFramePort,
} from "./nativeNvdecFramePort";

type OnFrameCallback = (
	frame: VideoFrame,
	exportTimestampUs: number,
	sourceTimestampMs: number,
) => Promise<void>;

type NativeNvdecVideoDecoderOptions = {
	inputPath: string;
	width: number;
	height: number;
	duration: number;
};

export class NativeNvdecVideoDecoder {
	private sessionId: string | null = null;
	private cancelled = false;

	constructor(private readonly options: NativeNvdecVideoDecoderOptions) {}

	async decodeAll(
		targetFrameRate: number,
		trimRegions: TrimRegion[] | undefined,
		speedRegions: SpeedRegion[] | undefined,
		onFrame: OnFrameCallback,
	): Promise<void> {
		if (!window.electronAPI?.startNativeNvdecDecode) {
			throw new Error("Required native NVDEC decoder IPC is unavailable");
		}
		const sourceTimestampsMs = getExportSourceTimestampsMs(
			this.options.duration,
			targetFrameRate,
			trimRegions,
			speedRegions,
		);
		if (sourceTimestampsMs.length === 0) {
			throw new Error("Native NVDEC export timeline contains no video frames");
		}
		const timelineSegments = buildExportTimelineSegments(
			this.options.duration,
			trimRegions,
			speedRegions,
		);

		const startResult = await window.electronAPI.startNativeNvdecDecode({
			inputPath: this.options.inputPath,
			width: this.options.width,
			height: this.options.height,
			frameRate: targetFrameRate,
			timelineSegments,
			totalFrames: sourceTimestampsMs.length,
		});
		if (!startResult.success || !startResult.sessionId) {
			throw new Error(
				startResult.message || startResult.error || "Required native NVDEC decode failed to start",
			);
		}

		const sessionId = startResult.sessionId;
		this.sessionId = sessionId;
		const portResult = await waitForNativeNvdecFramePort(sessionId);
		if (!portResult.success) {
			await this.cancelSession(sessionId);
			throw new Error(portResult.message || "Required native NVDEC frame port failed");
		}

		const frameConfig = {
			width: this.options.width,
			height: this.options.height,
			frameRate: targetFrameRate,
		};
		const frameDurationUs = 1_000_000 / targetFrameRate;
		let outputFrameIndex = 0;
		let decoderCompleted = false;

		try {
			while (!this.cancelled) {
				const decoded = await readNativeNvdecFrame(sessionId, frameConfig);
				if (!decoded) {
					decoderCompleted = true;
					break;
				}
				if (this.cancelled) {
					decoded.frame.close();
					break;
				}
				if (decoded.frameIndex !== outputFrameIndex) {
					decoded.frame.close();
					throw new Error(
						`Native NVDEC frame sequence jumped from ${outputFrameIndex} to ${decoded.frameIndex}`,
					);
				}
				if (outputFrameIndex >= sourceTimestampsMs.length) {
					decoded.frame.close();
					throw new Error(
						`Native NVDEC emitted more than ${sourceTimestampsMs.length} required frames`,
					);
				}

				await onFrame(
					decoded.frame,
					outputFrameIndex * frameDurationUs,
					sourceTimestampsMs[outputFrameIndex],
				);
				outputFrameIndex++;
			}

			if (this.cancelled) return;
			if (outputFrameIndex !== sourceTimestampsMs.length) {
				throw new Error(
					`Native NVDEC emitted ${outputFrameIndex}/${sourceTimestampsMs.length} required frames`,
				);
			}
		} catch (error) {
			if (!this.cancelled) throw error;
		} finally {
			if (decoderCompleted) {
				closeNativeNvdecFramePort(sessionId);
				if (this.sessionId === sessionId) this.sessionId = null;
			} else {
				await this.cancelSession(sessionId);
			}
		}
	}

	cancel(): void {
		this.cancelled = true;
		if (!this.sessionId) return;
		const sessionId = this.sessionId;
		this.sessionId = null;
		closeNativeNvdecFramePort(sessionId);
		void window.electronAPI.cancelNativeNvdecDecode(sessionId);
	}

	destroy(): void {
		this.cancel();
	}

	private async cancelSession(sessionId: string) {
		closeNativeNvdecFramePort(sessionId);
		if (this.sessionId === sessionId) this.sessionId = null;
		await window.electronAPI.cancelNativeNvdecDecode(sessionId);
	}
}
