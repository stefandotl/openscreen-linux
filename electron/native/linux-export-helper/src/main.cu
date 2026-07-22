// Required Linux export helper: FFmpeg CUDA hardware frames -> CUDA compositor -> NVENC.
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include <cuda.h>
#include <cuda_runtime.h>
#include <nlohmann/json.hpp>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/buffer.h>
#include <libavutil/dict.h>
#include <libavutil/error.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_cuda.h>
#include <libavutil/opt.h>
#include <libavutil/pixdesc.h>
}

namespace {

constexpr int kOutputFrameRate = 30;
constexpr int kMaxOutputDimension = 4096;

struct FrameDeleter {
	void operator()(AVFrame *frame) const { av_frame_free(&frame); }
};

struct PacketDeleter {
	void operator()(AVPacket *packet) const { av_packet_free(&packet); }
};

using FramePtr = std::unique_ptr<AVFrame, FrameDeleter>;
using PacketPtr = std::unique_ptr<AVPacket, PacketDeleter>;

std::string avError(int code) {
	std::array<char, AV_ERROR_MAX_STRING_SIZE> buffer{};
	av_strerror(code, buffer.data(), buffer.size());
	return buffer.data();
}

[[noreturn]] void fail(const std::string &message) {
	std::cerr << "FAIL: " << message << "\n";
	std::exit(1);
}

void requireAv(int result, const std::string &operation) {
	if (result >= 0) return;
	fail(operation + ": " + avError(result));
}

void requireCuda(CUresult result, const char *operation) {
	if (result == CUDA_SUCCESS) return;
	const char *name = nullptr;
	const char *description = nullptr;
	cuGetErrorName(result, &name);
	cuGetErrorString(result, &description);
	fail(std::string(operation) + ": " + (name ? name : "unknown") + " (" +
		 (description ? description : "no description") + ")");
}

void requireRuntime(cudaError_t result, const char *operation) {
	if (result == cudaSuccess) return;
	fail(std::string(operation) + ": " + cudaGetErrorName(result) + " (" +
		 cudaGetErrorString(result) + ")");
}

const char *pixelFormatName(AVPixelFormat format) {
	const char *name = av_get_pix_fmt_name(format);
	return name ? name : "unknown";
}

AVPixelFormat selectCudaFormat(AVCodecContext *, const AVPixelFormat *formats) {
	for (const AVPixelFormat *format = formats; *format != AV_PIX_FMT_NONE; format++) {
		if (*format == AV_PIX_FMT_CUDA) return *format;
	}
	std::cerr << "Decoder did not offer AV_PIX_FMT_CUDA. Offered:";
	for (const AVPixelFormat *format = formats; *format != AV_PIX_FMT_NONE; format++) {
		std::cerr << ' ' << pixelFormatName(*format);
	}
	std::cerr << "\n";
	return AV_PIX_FMT_NONE;
}

__device__ float clampFloat(float value, float minimum, float maximum) {
	return fminf(maximum, fmaxf(minimum, value));
}

__device__ float samplePlane(
	const uint8_t *plane,
	int pitch,
	int width,
	int height,
	float x,
	float y) {
	x = clampFloat(x, 0.0f, static_cast<float>(width - 1));
	y = clampFloat(y, 0.0f, static_cast<float>(height - 1));
	const int x0 = static_cast<int>(floorf(x));
	const int y0 = static_cast<int>(floorf(y));
	const int x1 = min(x0 + 1, width - 1);
	const int y1 = min(y0 + 1, height - 1);
	const float tx = x - static_cast<float>(x0);
	const float ty = y - static_cast<float>(y0);
	const float top = static_cast<float>(plane[y0 * pitch + x0]) * (1.0f - tx) +
					  static_cast<float>(plane[y0 * pitch + x1]) * tx;
	const float bottom = static_cast<float>(plane[y1 * pitch + x0]) * (1.0f - tx) +
						 static_cast<float>(plane[y1 * pitch + x1]) * tx;
	return top * (1.0f - ty) + bottom * ty;
}

__device__ float sampleInterleavedPlane(
	const uint8_t *plane,
	int pitch,
	int width,
	int height,
	float x,
	float y,
	int channel) {
	x = clampFloat(x, 0.0f, static_cast<float>(width - 1));
	y = clampFloat(y, 0.0f, static_cast<float>(height - 1));
	const int x0 = static_cast<int>(floorf(x));
	const int y0 = static_cast<int>(floorf(y));
	const int x1 = min(x0 + 1, width - 1);
	const int y1 = min(y0 + 1, height - 1);
	const float tx = x - static_cast<float>(x0);
	const float ty = y - static_cast<float>(y0);
	const float top =
		static_cast<float>(plane[y0 * pitch + x0 * 2 + channel]) * (1.0f - tx) +
		static_cast<float>(plane[y0 * pitch + x1 * 2 + channel]) * tx;
	const float bottom =
		static_cast<float>(plane[y1 * pitch + x0 * 2 + channel]) * (1.0f - tx) +
		static_cast<float>(plane[y1 * pitch + x1 * 2 + channel]) * tx;
	return top * (1.0f - ty) + bottom * ty;
}

struct SceneTransform {
	float left;
	float top;
	float width;
	float height;
};

struct PlannedFrame {
	double sourceTimestampMs;
	float cameraScale;
	float cameraX;
	float cameraY;
	float motionBlurX;
	float motionBlurY;
};

struct ExportPlan {
	int version = 0;
	int width = 0;
	int height = 0;
	std::string inputPath;
	std::string wallpaperNv12Path;
	std::string overlayRgbaPath;
	double overlayStartMs = -1.0;
	double overlayEndMs = -1.0;
	float screenX = 0.0f;
	float screenY = 0.0f;
	float screenWidth = 0.0f;
	float screenHeight = 0.0f;
	int sourceWidth = 0;
	int sourceHeight = 0;
	int64_t bitrate = 0;
	std::vector<PlannedFrame> frames;
};

struct GpuAssets {
	uint8_t *wallpaper = nullptr;
	uint8_t *overlay = nullptr;
};

SceneTransform plannedSceneTransform(const ExportPlan &plan, const PlannedFrame &frame) {
	SceneTransform transform{};
	transform.left = frame.cameraX + frame.cameraScale * plan.screenX;
	transform.top = frame.cameraY + frame.cameraScale * plan.screenY;
	transform.width = frame.cameraScale * plan.screenWidth;
	transform.height = frame.cameraScale * plan.screenHeight;
	return transform;
}

__device__ bool mapOutputToSource(
	float outputX,
	float outputY,
	const SceneTransform &transform,
	int sourceWidth,
	int sourceHeight,
	float *sourceX,
	float *sourceY) {
	if (outputX < transform.left || outputY < transform.top ||
		outputX > transform.left + transform.width ||
		outputY > transform.top + transform.height) {
		return false;
	}

	const float localX = (outputX - transform.left) / transform.width;
	const float localY = (outputY - transform.top) / transform.height;
	*sourceX = clampFloat(localX, 0.0f, 1.0f) * static_cast<float>(sourceWidth - 1);
	*sourceY = clampFloat(localY, 0.0f, 1.0f) * static_cast<float>(sourceHeight - 1);
	return true;
}

__device__ int motionBlurTapCount(float motionBlurX, float motionBlurY) {
	const float targetBlur = hypotf(motionBlurX, motionBlurY) / 2.4f;
	if (targetBlur <= 0.5f) return 1;
	if (targetBlur > 8.0f) return 15;
	if (targetBlur > 4.0f) return 11;
	return 7;
}

__global__ void compositeLuma(
	const uint8_t *sourceY,
	int sourcePitch,
	int sourceWidth,
	int sourceHeight,
	uint8_t *outputY,
	int outputPitch,
	int outputWidth,
	int outputHeight,
	SceneTransform transform,
	float motionBlurX,
	float motionBlurY,
	const uint8_t *wallpaperY,
	const uint8_t *overlayRgba) {
	const int x = static_cast<int>(blockIdx.x * blockDim.x + threadIdx.x);
	const int y = static_cast<int>(blockIdx.y * blockDim.y + threadIdx.y);
	if (x >= outputWidth || y >= outputHeight) return;

	const float fx = static_cast<float>(x) + 0.5f;
	const float fy = static_cast<float>(y) + 0.5f;
	const float wallpaperValue = static_cast<float>(wallpaperY[y * outputWidth + x]);
	const int tapCount = motionBlurTapCount(motionBlurX, motionBlurY);
	float value = 0.0f;
	for (int tap = 0; tap < tapCount; tap++) {
		const float tapPosition =
			tapCount == 1 ? 0.0f : static_cast<float>(tap) / static_cast<float>(tapCount - 1) - 0.5f;
		const float sampleOutputX = fx - motionBlurX * tapPosition;
		const float sampleOutputY = fy - motionBlurY * tapPosition;
		float tapValue = wallpaperValue;
		float sourceX = 0.0f;
		float sourceYCoordinate = 0.0f;
		if (mapOutputToSource(
				sampleOutputX,
				sampleOutputY,
				transform,
				sourceWidth,
				sourceHeight,
				&sourceX,
				&sourceYCoordinate)) {
			tapValue = samplePlane(
				sourceY,
				sourcePitch,
				sourceWidth,
				sourceHeight,
				sourceX,
				sourceYCoordinate);
		}
		value += tapValue;
	}
	value /= static_cast<float>(tapCount);

	if (overlayRgba) {
		const int overlayOffset = (y * outputWidth + x) * 4;
		const float red = static_cast<float>(overlayRgba[overlayOffset]);
		const float green = static_cast<float>(overlayRgba[overlayOffset + 1]);
		const float blue = static_cast<float>(overlayRgba[overlayOffset + 2]);
		const float alpha = static_cast<float>(overlayRgba[overlayOffset + 3]) / 255.0f;
		const float overlayY = 16.0f + 0.182586f * red + 0.614231f * green + 0.062007f * blue;
		value = value * (1.0f - alpha) + overlayY * alpha;
	}
	outputY[y * outputPitch + x] = static_cast<uint8_t>(clampFloat(value, 16.0f, 235.0f));
}

__global__ void compositeChroma(
	const uint8_t *sourceUv,
	int sourcePitch,
	int sourceWidth,
	int sourceHeight,
	uint8_t *outputUv,
	int outputPitch,
	int outputWidth,
	int outputHeight,
	SceneTransform transform,
	float motionBlurX,
	float motionBlurY,
	const uint8_t *wallpaperUv,
	const uint8_t *overlayRgba) {
	const int x = static_cast<int>(blockIdx.x * blockDim.x + threadIdx.x);
	const int y = static_cast<int>(blockIdx.y * blockDim.y + threadIdx.y);
	const int outputChromaWidth = outputWidth / 2;
	const int outputChromaHeight = outputHeight / 2;
	if (x >= outputChromaWidth || y >= outputChromaHeight) return;

	const float outputX = static_cast<float>(x * 2) + 1.0f;
	const float outputY = static_cast<float>(y * 2) + 1.0f;
	const float wallpaperU = static_cast<float>(wallpaperUv[y * outputWidth + x * 2]);
	const float wallpaperV = static_cast<float>(wallpaperUv[y * outputWidth + x * 2 + 1]);
	const int tapCount = motionBlurTapCount(motionBlurX, motionBlurY);
	float u = 0.0f;
	float v = 0.0f;
	for (int tap = 0; tap < tapCount; tap++) {
		const float tapPosition =
			tapCount == 1 ? 0.0f : static_cast<float>(tap) / static_cast<float>(tapCount - 1) - 0.5f;
		const float sampleOutputX = outputX - motionBlurX * tapPosition;
		const float sampleOutputY = outputY - motionBlurY * tapPosition;
		float tapU = wallpaperU;
		float tapV = wallpaperV;
		float sourceX = 0.0f;
		float sourceYCoordinate = 0.0f;
		if (mapOutputToSource(
				sampleOutputX,
				sampleOutputY,
				transform,
				sourceWidth,
				sourceHeight,
				&sourceX,
				&sourceYCoordinate)) {
			const float sourceChromaX = sourceX * 0.5f;
			const float sourceChromaY = sourceYCoordinate * 0.5f;
			tapU = sampleInterleavedPlane(
				sourceUv,
				sourcePitch,
				sourceWidth / 2,
				sourceHeight / 2,
				sourceChromaX,
				sourceChromaY,
				0);
			tapV = sampleInterleavedPlane(
				sourceUv,
				sourcePitch,
				sourceWidth / 2,
				sourceHeight / 2,
				sourceChromaX,
				sourceChromaY,
				1);
		}
		u += tapU;
		v += tapV;
	}
	u /= static_cast<float>(tapCount);
	v /= static_cast<float>(tapCount);

	if (overlayRgba) {
		float alpha = 0.0f;
		float red = 0.0f;
		float green = 0.0f;
		float blue = 0.0f;
		for (int dy = 0; dy < 2; dy++) {
			for (int dx = 0; dx < 2; dx++) {
				const int overlayOffset = ((y * 2 + dy) * outputWidth + x * 2 + dx) * 4;
				const float pixelAlpha = static_cast<float>(overlayRgba[overlayOffset + 3]) / 255.0f;
				alpha += pixelAlpha;
				red += static_cast<float>(overlayRgba[overlayOffset]) * pixelAlpha;
				green += static_cast<float>(overlayRgba[overlayOffset + 1]) * pixelAlpha;
				blue += static_cast<float>(overlayRgba[overlayOffset + 2]) * pixelAlpha;
			}
		}
		if (alpha > 0.0f) {
			red /= alpha;
			green /= alpha;
			blue /= alpha;
			const float blend = alpha * 0.25f;
			const float overlayU = 128.0f - 0.100644f * red - 0.338572f * green + 0.439216f * blue;
			const float overlayV = 128.0f + 0.439216f * red - 0.398942f * green - 0.040274f * blue;
			u = u * (1.0f - blend) + overlayU * blend;
			v = v * (1.0f - blend) + overlayV * blend;
		}
	}
	outputUv[y * outputPitch + x * 2] = static_cast<uint8_t>(clampFloat(u, 16.0f, 240.0f));
	outputUv[y * outputPitch + x * 2 + 1] =
		static_cast<uint8_t>(clampFloat(v, 16.0f, 240.0f));
}

struct ExportState {
	AVBufferRef *deviceRef = nullptr;
	AVBufferRef *outputFramesRef = nullptr;
	AVFormatContext *inputFormat = nullptr;
	AVFormatContext *outputFormat = nullptr;
	AVCodecContext *decoder = nullptr;
	AVCodecContext *encoder = nullptr;
	AVStream *inputStream = nullptr;
	AVStream *outputStream = nullptr;
	int inputStreamIndex = -1;
	bool outputIoOpen = false;
	bool headerWritten = false;
	int totalFrames = 0;
	std::chrono::steady_clock::time_point startedAt{};

	~ExportState() {
		if (headerWritten && outputFormat) av_write_trailer(outputFormat);
		if (outputIoOpen && outputFormat) avio_closep(&outputFormat->pb);
		avcodec_free_context(&encoder);
		avcodec_free_context(&decoder);
		avformat_close_input(&inputFormat);
		avformat_free_context(outputFormat);
		av_buffer_unref(&outputFramesRef);
		av_buffer_unref(&deviceRef);
	}
};

void initializeInput(ExportState &state, const std::string &inputPath) {
	requireAv(avformat_open_input(&state.inputFormat, inputPath.c_str(), nullptr, nullptr), "open input");
	requireAv(avformat_find_stream_info(state.inputFormat, nullptr), "read input stream info");
	state.inputStreamIndex = av_find_best_stream(
		state.inputFormat,
		AVMEDIA_TYPE_VIDEO,
		-1,
		-1,
		nullptr,
		0);
	requireAv(state.inputStreamIndex, "find video stream");
	state.inputStream = state.inputFormat->streams[state.inputStreamIndex];

	const AVCodec *decoder = avcodec_find_decoder(state.inputStream->codecpar->codec_id);
	if (!decoder) fail("No decoder found for input codec");
	state.decoder = avcodec_alloc_context3(decoder);
	if (!state.decoder) fail("Could not allocate decoder context");
	requireAv(
		avcodec_parameters_to_context(state.decoder, state.inputStream->codecpar),
		"copy decoder parameters");
	state.decoder->get_format = selectCudaFormat;
	state.decoder->hw_device_ctx = av_buffer_ref(state.deviceRef);
	if (!state.decoder->hw_device_ctx) fail("Could not reference CUDA device for decoder");
	state.decoder->extra_hw_frames = 8;
	requireAv(avcodec_open2(state.decoder, decoder, nullptr), "open CUDA decoder");
}

void initializeOutput(ExportState &state, const std::string &outputPath, const ExportPlan &plan) {
	requireAv(
		avformat_alloc_output_context2(&state.outputFormat, nullptr, "mp4", outputPath.c_str()),
		"allocate MP4 output");
	if (!state.outputFormat) fail("Could not create MP4 output context");

	const AVCodec *encoder = avcodec_find_encoder_by_name("h264_nvenc");
	if (!encoder) fail("Required h264_nvenc encoder is unavailable");
	state.encoder = avcodec_alloc_context3(encoder);
	if (!state.encoder) fail("Could not allocate NVENC context");
	state.encoder->width = plan.width;
	state.encoder->height = plan.height;
	state.encoder->time_base = AVRational{1, kOutputFrameRate};
	state.encoder->framerate = AVRational{kOutputFrameRate, 1};
	state.encoder->pix_fmt = AV_PIX_FMT_CUDA;
	state.encoder->bit_rate = plan.bitrate;
	state.encoder->rc_max_rate = plan.bitrate * 3 / 2;
	state.encoder->rc_buffer_size = plan.bitrate * 2;
	state.encoder->gop_size = kOutputFrameRate * 2;
	state.encoder->max_b_frames = 0;
	state.encoder->color_range = AVCOL_RANGE_MPEG;
	state.encoder->color_primaries = AVCOL_PRI_BT709;
	state.encoder->color_trc = AVCOL_TRC_BT709;
	state.encoder->colorspace = AVCOL_SPC_BT709;
	if (state.outputFormat->oformat->flags & AVFMT_GLOBALHEADER) {
		state.encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
	}

	state.outputFramesRef = av_hwframe_ctx_alloc(state.deviceRef);
	if (!state.outputFramesRef) fail("Could not allocate CUDA output frame context");
	auto *framesContext = reinterpret_cast<AVHWFramesContext *>(state.outputFramesRef->data);
	framesContext->format = AV_PIX_FMT_CUDA;
	framesContext->sw_format = AV_PIX_FMT_NV12;
	framesContext->width = plan.width;
	framesContext->height = plan.height;
	framesContext->initial_pool_size = 12;
	requireAv(av_hwframe_ctx_init(state.outputFramesRef), "initialize CUDA output frame pool");
	state.encoder->hw_frames_ctx = av_buffer_ref(state.outputFramesRef);
	if (!state.encoder->hw_frames_ctx) fail("Could not reference CUDA output frame pool");

	AVDictionary *encoderOptions = nullptr;
	av_dict_set(&encoderOptions, "preset", "p4", 0);
	av_dict_set(&encoderOptions, "tune", "hq", 0);
	av_dict_set(&encoderOptions, "rc", "vbr", 0);
	const int openResult = avcodec_open2(state.encoder, encoder, &encoderOptions);
	av_dict_free(&encoderOptions);
	requireAv(openResult, "open h264_nvenc");
	if (state.encoder->codec->id != AV_CODEC_ID_H264 ||
		std::string(state.encoder->codec->name) != "h264_nvenc") {
		fail("Encoder is not h264_nvenc");
	}

	state.outputStream = avformat_new_stream(state.outputFormat, nullptr);
	if (!state.outputStream) fail("Could not create output video stream");
	state.outputStream->time_base = state.encoder->time_base;
	requireAv(
		avcodec_parameters_from_context(state.outputStream->codecpar, state.encoder),
		"copy encoder parameters");

	if (!(state.outputFormat->oformat->flags & AVFMT_NOFILE)) {
		requireAv(avio_open(&state.outputFormat->pb, outputPath.c_str(), AVIO_FLAG_WRITE), "open output file");
		state.outputIoOpen = true;
	}
	AVDictionary *muxerOptions = nullptr;
	av_dict_set(&muxerOptions, "use_editlist", "0", 0);
	av_dict_set(&muxerOptions, "movflags", "+faststart", 0);
	const int headerResult = avformat_write_header(state.outputFormat, &muxerOptions);
	av_dict_free(&muxerOptions);
	requireAv(headerResult, "write MP4 header");
	state.headerWritten = true;
}

void verifyDecodedFrame(const AVFrame *frame) {
	if (frame->format != AV_PIX_FMT_CUDA) {
		fail(std::string("Decoder returned ") +
			 pixelFormatName(static_cast<AVPixelFormat>(frame->format)) + " instead of CUDA");
	}
	if (!frame->hw_frames_ctx) fail("Decoded CUDA frame has no hardware frame context");
	auto *framesContext = reinterpret_cast<AVHWFramesContext *>(frame->hw_frames_ctx->data);
	if (framesContext->sw_format != AV_PIX_FMT_NV12) {
		fail(std::string("Decoded CUDA frame uses unsupported software layout ") +
			 pixelFormatName(framesContext->sw_format) + "; native export requires NV12");
	}
	if (!frame->data[0] || !frame->data[1]) fail("Decoded CUDA frame has missing NV12 planes");
}

double compositeFrame(
	ExportState &state,
	const AVFrame *source,
	AVFrame *output,
	const SceneTransform &transform,
	float motionBlurX,
	float motionBlurY,
	const GpuAssets &assets,
	bool overlayActive) {
	verifyDecodedFrame(source);
	if (output->format != AV_PIX_FMT_CUDA || !output->data[0] || !output->data[1]) {
		fail("NVENC output frame is not a valid CUDA frame");
	}

	auto *deviceContext = reinterpret_cast<AVHWDeviceContext *>(state.deviceRef->data);
	auto *cudaContext = reinterpret_cast<AVCUDADeviceContext *>(deviceContext->hwctx);
	if (!cudaContext || !cudaContext->cuda_ctx) fail("FFmpeg CUDA device context is unavailable");
	requireCuda(cuCtxPushCurrent(cudaContext->cuda_ctx), "cuCtxPushCurrent");
	const auto startedAt = std::chrono::steady_clock::now();
	const cudaStream_t stream = reinterpret_cast<cudaStream_t>(cudaContext->stream);
	const int outputWidth = state.encoder->width;
	const int outputHeight = state.encoder->height;

	const dim3 block(16, 16);
	const dim3 lumaGrid(
		(outputWidth + block.x - 1) / block.x,
		(outputHeight + block.y - 1) / block.y);
	compositeLuma<<<lumaGrid, block, 0, stream>>>(
		source->data[0],
		source->linesize[0],
		source->width,
		source->height,
		output->data[0],
		output->linesize[0],
		outputWidth,
		outputHeight,
		transform,
		motionBlurX,
		motionBlurY,
		assets.wallpaper,
		overlayActive ? assets.overlay : nullptr);
	requireRuntime(cudaGetLastError(), "compositeLuma launch");

	const dim3 chromaGrid(
		(outputWidth / 2 + block.x - 1) / block.x,
		(outputHeight / 2 + block.y - 1) / block.y);
	compositeChroma<<<chromaGrid, block, 0, stream>>>(
		source->data[1],
		source->linesize[1],
		source->width,
		source->height,
		output->data[1],
		output->linesize[1],
		outputWidth,
		outputHeight,
		transform,
		motionBlurX,
		motionBlurY,
		assets.wallpaper + static_cast<std::size_t>(outputWidth) * outputHeight,
		overlayActive ? assets.overlay : nullptr);
	requireRuntime(cudaGetLastError(), "compositeChroma launch");
	requireRuntime(cudaStreamSynchronize(stream), "compositor stream synchronization");

	const auto finishedAt = std::chrono::steady_clock::now();
	CUcontext poppedContext = nullptr;
	requireCuda(cuCtxPopCurrent(&poppedContext), "cuCtxPopCurrent");
	if (poppedContext != cudaContext->cuda_ctx) fail("Unexpected CUDA context was popped");
	return std::chrono::duration<double, std::milli>(finishedAt - startedAt).count();
}

void writeEncoderPackets(ExportState &state, AVPacket *packet) {
	while (true) {
		const int receiveResult = avcodec_receive_packet(state.encoder, packet);
		if (receiveResult == AVERROR(EAGAIN) || receiveResult == AVERROR_EOF) return;
		requireAv(receiveResult, "receive NVENC packet");
		av_packet_rescale_ts(packet, state.encoder->time_base, state.outputStream->time_base);
		packet->stream_index = state.outputStream->index;
		requireAv(av_interleaved_write_frame(state.outputFormat, packet), "write encoded packet");
		av_packet_unref(packet);
	}
}

void encodeFrame(ExportState &state, AVFrame *frame, AVPacket *packet) {
	requireAv(avcodec_send_frame(state.encoder, frame), "send CUDA frame to NVENC");
	writeEncoderPackets(state, packet);
}

ExportPlan loadPlan(const std::string &planPath) {
	std::ifstream stream(planPath);
	if (!stream) fail("Could not open native GPU export plan: " + planPath);
	nlohmann::json document;
	stream >> document;

	ExportPlan plan;
	plan.version = document.at("version").get<int>();
	if (plan.version != 2) fail("Unsupported native GPU export plan version");
	plan.width = document.at("width").get<int>();
	plan.height = document.at("height").get<int>();
	plan.inputPath = document.at("inputPath").get<std::string>();
	plan.wallpaperNv12Path = document.at("wallpaperNv12Path").get<std::string>();
	plan.overlayRgbaPath = document.value("overlayRgbaPath", "");
	plan.overlayStartMs = document.value("overlayStartMs", -1.0);
	plan.overlayEndMs = document.value("overlayEndMs", -1.0);
	const auto &screenRect = document.at("screenRect");
	plan.screenX = screenRect.at("x").get<float>();
	plan.screenY = screenRect.at("y").get<float>();
	plan.screenWidth = screenRect.at("width").get<float>();
	plan.screenHeight = screenRect.at("height").get<float>();
	plan.sourceWidth = document.at("sourceWidth").get<int>();
	plan.sourceHeight = document.at("sourceHeight").get<int>();
	plan.bitrate = document.at("bitrate").get<int64_t>();
	if (plan.sourceWidth <= 0 || plan.sourceHeight <= 0 || plan.sourceWidth % 2 != 0 ||
		plan.sourceHeight % 2 != 0) {
		fail("Native GPU export source dimensions are invalid");
	}
	if (plan.bitrate < 500'000 || plan.bitrate > 200'000'000) {
		fail("Native GPU export bitrate is invalid");
	}
	if (plan.width < 2 || plan.height < 2 || plan.width % 2 != 0 || plan.height % 2 != 0 ||
		plan.width > kMaxOutputDimension || plan.height > kMaxOutputDimension ||
		document.at("frameRate").get<int>() != kOutputFrameRate) {
		fail("Native GPU export plan requires even dimensions up to 4096px at 30 fps");
	}
	const auto &crop = document.at("cropRegion");
	if (fabs(crop.at("x").get<double>()) > 0.0001 ||
		fabs(crop.at("y").get<double>()) > 0.0001 ||
		fabs(crop.at("width").get<double>() - 1.0) > 0.0001 ||
		fabs(crop.at("height").get<double>() - 1.0) > 0.0001) {
		fail("Native GPU export requires the default crop");
	}
	for (const auto &item : document.at("frames")) {
		const float motionBlurX = item.at("motionBlurX").get<float>();
		const float motionBlurY = item.at("motionBlurY").get<float>();
		if (!std::isfinite(motionBlurX) || !std::isfinite(motionBlurY) ||
			fabs(motionBlurX) > 128.0f || fabs(motionBlurY) > 128.0f) {
			fail("Native GPU export motion blur vector is invalid");
		}
		plan.frames.push_back({
			item.at("sourceTimestampMs").get<double>(),
			item.at("cameraScale").get<float>(),
			item.at("cameraX").get<float>(),
			item.at("cameraY").get<float>(),
			motionBlurX,
			motionBlurY,
		});
	}
	if (plan.wallpaperNv12Path.empty()) fail("Native GPU export wallpaper path is missing");
	if (plan.frames.empty()) fail("Native GPU export plan contains no frames");
	for (std::size_t index = 1; index < plan.frames.size(); index++) {
		if (plan.frames[index].sourceTimestampMs < plan.frames[index - 1].sourceTimestampMs) {
			fail("Native GPU export source timestamps must be monotonic");
		}
	}
	return plan;
}

std::vector<uint8_t> readExactFile(const std::string &path, std::size_t expectedBytes) {
	std::ifstream stream(path, std::ios::binary | std::ios::ate);
	if (!stream) fail("Could not open raw GPU asset: " + path);
	const std::streamsize size = stream.tellg();
	if (size < 0 || static_cast<std::size_t>(size) != expectedBytes) {
		fail(
			"GPU asset has " + std::to_string(size) + " bytes; expected " +
			std::to_string(expectedBytes) + ": " + path);
	}
	stream.seekg(0, std::ios::beg);
	std::vector<uint8_t> data(expectedBytes);
	if (!stream.read(reinterpret_cast<char *>(data.data()), size)) {
		fail("Could not read raw GPU asset: " + path);
	}
	return data;
}

GpuAssets uploadGpuAssets(ExportState &state, const ExportPlan &plan) {
	GpuAssets assets;
	auto *deviceContext = reinterpret_cast<AVHWDeviceContext *>(state.deviceRef->data);
	auto *cudaContext = reinterpret_cast<AVCUDADeviceContext *>(deviceContext->hwctx);
	requireCuda(cuCtxPushCurrent(cudaContext->cuda_ctx), "cuCtxPushCurrent for asset upload");
	const std::size_t outputPixels = static_cast<std::size_t>(plan.width) * plan.height;
	const std::size_t wallpaperBytes = outputPixels * 3 / 2;
	const auto wallpaper = readExactFile(plan.wallpaperNv12Path, wallpaperBytes);
	requireRuntime(cudaMalloc(&assets.wallpaper, wallpaperBytes), "cudaMalloc wallpaper");
	requireRuntime(
		cudaMemcpy(assets.wallpaper, wallpaper.data(), wallpaperBytes, cudaMemcpyHostToDevice),
		"upload wallpaper");
	if (!plan.overlayRgbaPath.empty()) {
		const std::size_t bytes = outputPixels * 4;
		const auto data = readExactFile(plan.overlayRgbaPath, bytes);
		requireRuntime(cudaMalloc(&assets.overlay, bytes), "cudaMalloc overlay");
		requireRuntime(
			cudaMemcpy(assets.overlay, data.data(), bytes, cudaMemcpyHostToDevice),
			"upload overlay");
	}
	CUcontext poppedContext = nullptr;
	requireCuda(cuCtxPopCurrent(&poppedContext), "cuCtxPopCurrent after asset upload");
	return assets;
}

void releaseGpuAssets(ExportState &state, GpuAssets *assets) {
	if (!assets->wallpaper && !assets->overlay) return;
	auto *deviceContext = reinterpret_cast<AVHWDeviceContext *>(state.deviceRef->data);
	auto *cudaContext = reinterpret_cast<AVCUDADeviceContext *>(deviceContext->hwctx);
	requireCuda(cuCtxPushCurrent(cudaContext->cuda_ctx), "cuCtxPushCurrent for asset release");
	if (assets->wallpaper) requireRuntime(cudaFree(assets->wallpaper), "cudaFree wallpaper");
	if (assets->overlay) requireRuntime(cudaFree(assets->overlay), "cudaFree overlay");
	assets->wallpaper = nullptr;
	assets->overlay = nullptr;
	CUcontext poppedContext = nullptr;
	requireCuda(cuCtxPopCurrent(&poppedContext), "cuCtxPopCurrent after asset release");
}

void renderOutputFrame(
	ExportState &state,
	const AVFrame *sourceFrame,
	AVPacket *encodedPacket,
	const ExportPlan &plan,
	const GpuAssets &assets,
	int *frameCount,
	double *compositorMs) {
	if (sourceFrame->width != plan.sourceWidth || sourceFrame->height != plan.sourceHeight) {
		fail(
			"Decoded source dimensions " + std::to_string(sourceFrame->width) + "x" +
			std::to_string(sourceFrame->height) + " do not match plan " +
			std::to_string(plan.sourceWidth) + "x" + std::to_string(plan.sourceHeight));
	}
	FramePtr outputFrame(av_frame_alloc());
	if (!outputFrame) fail("Could not allocate output frame");
	requireAv(
		av_hwframe_get_buffer(state.outputFramesRef, outputFrame.get(), 0),
		"allocate CUDA output frame");
	outputFrame->pts = *frameCount;
	outputFrame->color_range = AVCOL_RANGE_MPEG;
	outputFrame->color_primaries = AVCOL_PRI_BT709;
	outputFrame->color_trc = AVCOL_TRC_BT709;
	outputFrame->colorspace = AVCOL_SPC_BT709;

	const PlannedFrame &plannedFrame = plan.frames.at(*frameCount);
	const SceneTransform transform = plannedSceneTransform(plan, plannedFrame);
	const bool overlayActive =
		assets.overlay && plannedFrame.sourceTimestampMs >= plan.overlayStartMs &&
		plannedFrame.sourceTimestampMs < plan.overlayEndMs;
	*compositorMs += compositeFrame(
		state,
		sourceFrame,
		outputFrame.get(),
		transform,
		plannedFrame.motionBlurX,
		plannedFrame.motionBlurY,
		assets,
		overlayActive);
	encodeFrame(state, outputFrame.get(), encodedPacket);
	(*frameCount)++;
	if (*frameCount % 120 == 0 || *frameCount == state.totalFrames) {
		const double elapsedSeconds = std::max(
			std::chrono::duration<double>(std::chrono::steady_clock::now() - state.startedAt).count(),
			0.001);
		std::cout << std::fixed << std::setprecision(2)
				  << "PROGRESS: {\"frames\":" << *frameCount << ",\"totalFrames\":"
				  << state.totalFrames << ",\"fps\":"
				  << static_cast<double>(*frameCount) / elapsedSeconds << "}" << std::endl;
	}
}

struct TimelineSelectionState {
	FramePtr previousFrame{nullptr};
	double previousTimestampMs = 0.0;
};

double decodedTimestampMs(const ExportState &state, const AVFrame *frame) {
	const int64_t timestamp =
		frame->best_effort_timestamp != AV_NOPTS_VALUE ? frame->best_effort_timestamp : frame->pts;
	if (timestamp == AV_NOPTS_VALUE) fail("Decoded frame has no timestamp");
	const int64_t startTimestamp =
		state.inputStream->start_time == AV_NOPTS_VALUE ? 0 : state.inputStream->start_time;
	return static_cast<double>(timestamp - startTimestamp) * av_q2d(state.inputStream->time_base) *
		1000.0;
}

void processDecodedFrames(
	ExportState &state,
	AVFrame *decodedFrame,
	AVPacket *encodedPacket,
	int frameLimit,
	const ExportPlan &plan,
	const GpuAssets &assets,
	TimelineSelectionState *selection,
	int *frameCount,
	double *compositorMs) {
	while (*frameCount < frameLimit) {
		const int receiveResult = avcodec_receive_frame(state.decoder, decodedFrame);
		if (receiveResult == AVERROR(EAGAIN) || receiveResult == AVERROR_EOF) return;
		requireAv(receiveResult, "receive CUDA decoded frame");
		verifyDecodedFrame(decodedFrame);

		const double currentTimestampMs = decodedTimestampMs(state, decodedFrame);
		while (*frameCount < frameLimit &&
			plan.frames[*frameCount].sourceTimestampMs <= currentTimestampMs + 0.001) {
			const double targetTimestampMs = plan.frames[*frameCount].sourceTimestampMs;
			const AVFrame *selectedFrame = decodedFrame;
			if (selection->previousFrame &&
				fabs(selection->previousTimestampMs - targetTimestampMs) <
					fabs(currentTimestampMs - targetTimestampMs)) {
				selectedFrame = selection->previousFrame.get();
			}
			renderOutputFrame(
				state,
				selectedFrame,
				encodedPacket,
				plan,
				assets,
				frameCount,
				compositorMs);
		}
		selection->previousFrame.reset(av_frame_clone(decodedFrame));
		if (!selection->previousFrame) fail("Could not retain decoded CUDA frame");
		selection->previousTimestampMs = currentTimestampMs;
		av_frame_unref(decodedFrame);
	}
}

}  // namespace

int main(int argc, char **argv) {
	if (argc != 4 || std::string(argv[1]) != "--plan") {
		std::cerr << "Usage: " << argv[0] << " --plan PLAN.json OUTPUT\n";
		return 2;
	}
	const ExportPlan plan = loadPlan(argv[2]);
	const std::string inputPath = plan.inputPath;
	const std::string outputPath = argv[3];
	const int frameLimit = static_cast<int>(plan.frames.size());
	if (!std::filesystem::is_regular_file(inputPath)) fail("Input file does not exist: " + inputPath);

	ExportState state;
	requireAv(
		av_hwdevice_ctx_create(&state.deviceRef, AV_HWDEVICE_TYPE_CUDA, "0", nullptr, 0),
		"create FFmpeg CUDA device");
	initializeInput(state, inputPath);
	initializeOutput(state, outputPath, plan);
	GpuAssets assets = uploadGpuAssets(state, plan);

	FramePtr decodedFrame(av_frame_alloc());
	PacketPtr inputPacket(av_packet_alloc());
	PacketPtr encodedPacket(av_packet_alloc());
	if (!decodedFrame || !inputPacket || !encodedPacket) fail("Could not allocate FFmpeg frame/packets");

	const auto startedAt = std::chrono::steady_clock::now();
	state.startedAt = startedAt;
	state.totalFrames = frameLimit;
	int frameCount = 0;
	double compositorMs = 0.0;
	TimelineSelectionState selection;
	while (frameCount < frameLimit && av_read_frame(state.inputFormat, inputPacket.get()) >= 0) {
		if (inputPacket->stream_index == state.inputStreamIndex) {
			requireAv(avcodec_send_packet(state.decoder, inputPacket.get()), "send packet to CUDA decoder");
			processDecodedFrames(
				state,
				decodedFrame.get(),
				encodedPacket.get(),
				frameLimit,
				plan,
				assets,
				&selection,
				&frameCount,
				&compositorMs);
		}
		av_packet_unref(inputPacket.get());
	}
	if (frameCount < frameLimit) {
		requireAv(avcodec_send_packet(state.decoder, nullptr), "flush CUDA decoder");
		processDecodedFrames(
			state,
			decodedFrame.get(),
			encodedPacket.get(),
			frameLimit,
			plan,
			assets,
			&selection,
			&frameCount,
			&compositorMs);
	}
	while (frameCount < frameLimit && selection.previousFrame) {
		renderOutputFrame(
			state,
			selection.previousFrame.get(),
			encodedPacket.get(),
			plan,
			assets,
			&frameCount,
			&compositorMs);
	}
	if (frameCount != frameLimit) {
		fail("Input ended after " + std::to_string(frameCount) + "/" +
			 std::to_string(frameLimit) + " requested frames");
	}
	requireAv(avcodec_send_frame(state.encoder, nullptr), "flush h264_nvenc");
	writeEncoderPackets(state, encodedPacket.get());
	requireAv(av_write_trailer(state.outputFormat), "finalize MP4");
	state.headerWritten = false;
	releaseGpuAssets(state, &assets);
	const auto finishedAt = std::chrono::steady_clock::now();
	const double elapsedSeconds =
		std::chrono::duration<double>(finishedAt - startedAt).count();

	std::ostringstream result;
	result << std::fixed << std::setprecision(2)
		   << "PASS: {\"frames\":" << frameCount << ",\"seconds\":" << elapsedSeconds
		   << ",\"fps\":" << static_cast<double>(frameCount) / elapsedSeconds
		   << ",\"avgCompositorMs\":" << compositorMs / static_cast<double>(frameCount)
		   << ",\"decoder\":\"" << state.decoder->codec->name << "\",\"encoder\":\""
		   << state.encoder->codec->name
		   << "\",\"pixelPath\":\"cuda-nv12\",\"mode\":\"native-gpu\"}";
	std::cout << result.str() << "\n";
	return 0;
}
