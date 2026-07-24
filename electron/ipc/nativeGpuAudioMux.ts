export interface AudioTimelineFilter {
	filter: string;
	outputLabel: string;
}

interface NativeGpuAudioMuxInput {
	videoOnlyPath: string;
	audioPath?: string;
	ensureAudioTrack?: boolean;
	outputPath: string;
	totalFrames: number;
	frameRate: number;
}

export function buildNativeGpuAudioMuxArgs(
	input: NativeGpuAudioMuxInput,
	audioFilter: AudioTimelineFilter | null,
) {
	const outputDuration = (input.totalFrames / input.frameRate).toFixed(6);
	const paddedAudioLabel = "[native_audio]";
	const audioFilterArgs = audioFilter
		? [
				"-filter_complex",
				`${audioFilter.filter};${audioFilter.outputLabel}apad=whole_dur=${outputDuration}${paddedAudioLabel}`,
			]
		: ["-af", `apad=whole_dur=${outputDuration}`];
	const audioInputArgs = input.audioPath
		? ["-i", input.audioPath]
		: input.ensureAudioTrack
			? ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
			: [];

	return [
		"-hide_banner",
		"-y",
		"-i",
		input.videoOnlyPath,
		...audioInputArgs,
		...audioFilterArgs,
		"-map",
		"0:v:0",
		"-map",
		audioFilter ? paddedAudioLabel : "1:a?",
		"-c:v",
		"copy",
		"-c:a",
		"aac",
		"-b:a",
		"128k",
		"-t",
		outputDuration,
		"-movflags",
		"+faststart",
		input.outputPath,
	];
}
