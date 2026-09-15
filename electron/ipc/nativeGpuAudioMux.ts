import type { AudioRegion } from "../../src/components/video-editor/audioRegions";
export interface AudioTimelineFilter {
	filter: string;
	outputLabel: string;
}

interface NativeGpuAudioMuxInput {
	videoOnlyPath: string;
	audioPath?: string;
	audioRegions?: AudioRegion[];
	sourceDurationSec?: number;
	ensureAudioTrack?: boolean;
	outputPath: string;
	totalFrames: number;
	frameRate: number;
}

export function buildNativeGpuAudioMuxArgs(
	input: NativeGpuAudioMuxInput,
	audioFilter: AudioTimelineFilter | null,
) {
	if (input.audioRegions?.length) return buildMixedAudioMuxArgs(input, audioFilter);
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
		"-ac",
		"2",
		"-ar",
		"48000",
		"-b:a",
		"128k",
		"-t",
		outputDuration,
		"-movflags",
		"+faststart",
		input.outputPath,
	];
}

function buildMixedAudioMuxArgs(
	input: NativeGpuAudioMuxInput,
	timeline: AudioTimelineFilter | null,
) {
	const clips = input.audioRegions!;
	const duration = input.sourceDurationSec!;
	if (!Number.isFinite(duration) || duration <= 0)
		throw new Error("Missing source duration for audio mix");
	const seconds = (ms: number) => (ms / 1000).toFixed(6);
	const filters = [`[1:a:0]apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[original]`];
	for (const [index, clip] of clips.entries()) {
		const length = clip.endMs - clip.startMs;
		const fadeIn = Math.min(clip.fadeInMs, length);
		const fadeOut = Math.min(clip.fadeOutMs, length);
		filters.push(
			`[${index + 2}:a:0]atrim=start=${seconds(clip.sourceStartMs)}:duration=${seconds(length)},asetpts=PTS-STARTPTS,` +
				`volume=${clip.volume}` +
				(fadeIn > 0 ? `,afade=t=in:d=${seconds(fadeIn)}` : "") +
				(fadeOut > 0 ? `,afade=t=out:st=${seconds(length - fadeOut)}:d=${seconds(fadeOut)}` : "") +
				`,adelay=${Math.round(clip.startMs)}:all=1[clip${index}]`,
		);
	}
	filters.push(
		`[original]${clips.map((_, i) => `[clip${i}]`).join("")}amix=inputs=${clips.length + 1}:duration=longest:normalize=0:dropout_transition=0,atrim=duration=${duration}[scene_audio]`,
	);
	let output = "[scene_audio]";
	if (timeline) {
		let index = 0;
		const rewritten = timeline.filter.replace(/\[1:a\]/g, () => `[scene_part${index++}]`);
		if (index > 0)
			filters.push(
				`[scene_audio]asplit=${index}${Array.from({ length: index }, (_, i) => `[scene_part${i}]`).join("")}`,
			);
		else filters.push("[scene_audio]anullsink");
		filters.push(rewritten);
		output = timeline.outputLabel;
	}
	const outputDuration = (input.totalFrames / input.frameRate).toFixed(6);
	filters.push(`${output}apad=whole_dur=${outputDuration}[mixed_audio]`);
	return [
		"-hide_banner",
		"-nostdin",
		"-y",
		"-i",
		input.videoOnlyPath,
		...(input.audioPath
			? ["-i", input.audioPath]
			: ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]),
		...clips.flatMap((clip) => ["-i", clip.sourcePath]),
		"-filter_complex",
		filters.join(";"),
		"-map",
		"0:v:0",
		"-map",
		"[mixed_audio]",
		"-c:v",
		"copy",
		"-c:a",
		"aac",
		"-ac",
		"2",
		"-ar",
		"48000",
		"-b:a",
		"192k",
		"-t",
		outputDuration,
		"-movflags",
		"+faststart",
		input.outputPath,
	];
}
