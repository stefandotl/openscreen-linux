export interface AudioTimelineFilter {
	filter: string;
	outputLabel: string;
}

interface NativeGpuAudioMuxInput {
	videoOnlyPath: string;
	audioPath: string;
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

	return [
		"-hide_banner",
		"-y",
		"-i",
		input.videoOnlyPath,
		"-i",
		input.audioPath,
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
