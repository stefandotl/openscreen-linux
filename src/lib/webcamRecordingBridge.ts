const DEFAULT_WEBCAM_WIDTH = 640;
const DEFAULT_WEBCAM_HEIGHT = 480;

function positiveDimension(value: number | undefined, fallback: number) {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.round(value)
		: fallback;
}

/**
 * Keeps the track handed to MediaRecorder stable while the physical webcam
 * stream is replaced. Some Linux UVC devices briefly disappear and re-enumerate;
 * recording the physical track directly makes the rest of the webcam sidecar
 * permanently empty after that first disconnect.
 */
export class WebcamRecordingBridge {
	private readonly video = document.createElement("video");
	private readonly canvas = document.createElement("canvas");
	private readonly context: CanvasRenderingContext2D;
	private readonly outputStream: MediaStream;
	private readonly outputTrack: CanvasCaptureMediaStreamTrack;
	private readonly frameIntervalId: number;
	private sourceStream: MediaStream | null = null;
	private destroyed = false;

	private constructor(sourceStream: MediaStream, frameRate: number) {
		const sourceSettings = sourceStream.getVideoTracks()[0]?.getSettings();
		this.canvas.width = positiveDimension(sourceSettings?.width, DEFAULT_WEBCAM_WIDTH);
		this.canvas.height = positiveDimension(sourceSettings?.height, DEFAULT_WEBCAM_HEIGHT);

		const context = this.canvas.getContext("2d", { alpha: false });
		if (!context) {
			throw new Error("Webcam recording bridge could not create a 2D canvas context.");
		}
		this.context = context;
		this.context.fillStyle = "#000";
		this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);

		if (typeof this.canvas.captureStream !== "function") {
			throw new Error("Canvas capture is unavailable for resilient webcam recording.");
		}
		this.outputStream = this.canvas.captureStream(0);
		const outputTrack = this.outputStream.getVideoTracks()[0] as
			| CanvasCaptureMediaStreamTrack
			| undefined;
		if (!outputTrack || typeof outputTrack.requestFrame !== "function") {
			this.outputStream.getTracks().forEach((track) => track.stop());
			throw new Error("Canvas capture did not provide a requestable webcam video track.");
		}
		this.outputTrack = outputTrack;

		this.video.autoplay = true;
		this.video.muted = true;
		this.video.playsInline = true;

		const intervalMs = Math.max(1, Math.round(1000 / frameRate));
		this.frameIntervalId = window.setInterval(() => this.renderFrame(), intervalMs);
	}

	static async create(sourceStream: MediaStream, frameRate: number) {
		const bridge = new WebcamRecordingBridge(sourceStream, frameRate);
		try {
			await bridge.attachSource(sourceStream);
			return bridge;
		} catch (error) {
			bridge.destroy();
			throw error;
		}
	}

	get stream() {
		return this.outputStream;
	}

	async attachSource(sourceStream: MediaStream) {
		if (this.destroyed) {
			throw new Error("Cannot attach a webcam to a destroyed recording bridge.");
		}
		const sourceTrack = sourceStream.getVideoTracks()[0];
		if (!sourceTrack || sourceTrack.readyState === "ended") {
			throw new Error("Cannot attach a webcam stream without a live video track.");
		}

		this.sourceStream = sourceStream;
		this.video.srcObject = sourceStream;
		await this.video.play();
	}

	detachSource(sourceStream: MediaStream) {
		if (this.sourceStream !== sourceStream) {
			return;
		}
		this.sourceStream = null;
		this.video.pause();
		this.video.srcObject = null;
	}

	destroy() {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;
		window.clearInterval(this.frameIntervalId);
		this.sourceStream = null;
		this.video.pause();
		this.video.srcObject = null;
		this.outputStream.getTracks().forEach((track) => track.stop());
	}

	private renderFrame() {
		if (this.destroyed) {
			return;
		}
		if (this.sourceStream && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
			this.context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
		}
		// requestFrame also repeats the last complete image while Linux re-enumerates
		// the physical camera, so MediaRecorder's track never ends during the gap.
		this.outputTrack.requestFrame();
	}
}
