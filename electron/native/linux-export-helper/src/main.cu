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
#include <utility>
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
	float borderRadius;
	bool cover;
};

struct PlannedFrame {
	double sourceTimestampMs;
	float cameraScale;
	float cameraX;
	float cameraY;
	float motionBlurX;
	float motionBlurY;
	float webcamScale;
};

enum class WebcamMaskShape {
	Rectangle,
	Rounded,
	Circle,
	Square,
};

struct WebcamPlan {
	bool enabled = false;
	std::string inputPath;
	int sourceWidth = 0;
	int sourceHeight = 0;
	float x = 0.0f;
	float y = 0.0f;
	float width = 0.0f;
	float height = 0.0f;
	float borderRadius = 0.0f;
	WebcamMaskShape maskShape = WebcamMaskShape::Rectangle;
	bool mirrored = false;
	bool anchorRight = true;
	bool anchorBottom = true;
	bool shadowEnabled = false;
	float shadowBlur = 0.0f;
	float shadowOffsetX = 0.0f;
	float shadowOffsetY = 0.0f;
};

struct PlannedOverlay {
	std::string rgbaPath;
	double startMs = -1.0;
	double endMs = -1.0;
	int x = 0;
	int y = 0;
	int width = 0;
	int height = 0;
	int zIndex = 0;
};

struct ExportPlan {
	int version = 0;
	int width = 0;
	int height = 0;
	std::string inputPath;
	std::string wallpaperNv12Path;
	float screenX = 0.0f;
	float screenY = 0.0f;
	float screenWidth = 0.0f;
	float screenHeight = 0.0f;
	bool screenCover = false;
	float screenBorderRadius = 0.0f;
	int sourceWidth = 0;
	int sourceHeight = 0;
	int64_t bitrate = 0;
	WebcamPlan webcam;
	std::vector<PlannedFrame> frames;
	std::vector<PlannedOverlay> overlays;
};

struct GpuOverlay {
	uint8_t *pixels = nullptr;
	double startMs = -1.0;
	double endMs = -1.0;
	int x = 0;
	int y = 0;
	int width = 0;
	int height = 0;
};

struct GpuAssets {
	uint8_t *wallpaper = nullptr;
	std::vector<GpuOverlay> overlays;
};

SceneTransform plannedSceneTransform(const ExportPlan &plan, const PlannedFrame &frame) {
	SceneTransform transform{};
	transform.left = frame.cameraX + frame.cameraScale * plan.screenX;
	transform.top = frame.cameraY + frame.cameraScale * plan.screenY;
	transform.width = frame.cameraScale * plan.screenWidth;
	transform.height = frame.cameraScale * plan.screenHeight;
	transform.borderRadius = frame.cameraScale * plan.screenBorderRadius;
	transform.cover = plan.screenCover;
	return transform;
}

__device__ bool insideRoundedRect(
	float outputX,
	float outputY,
	const SceneTransform &transform) {
	if (outputX < transform.left || outputY < transform.top ||
		outputX > transform.left + transform.width ||
		outputY > transform.top + transform.height) {
		return false;
	}
	const float radius =
		clampFloat(transform.borderRadius, 0.0f, fminf(transform.width, transform.height) * 0.5f);
	if (radius <= 0.0f) return true;
	const float nearestX =
		clampFloat(outputX, transform.left + radius, transform.left + transform.width - radius);
	const float nearestY =
		clampFloat(outputY, transform.top + radius, transform.top + transform.height - radius);
	const float dx = outputX - nearestX;
	const float dy = outputY - nearestY;
	return dx * dx + dy * dy <= radius * radius;
}

__device__ bool mapOutputToSource(
	float outputX,
	float outputY,
	const SceneTransform &transform,
	int sourceWidth,
	int sourceHeight,
	float *sourceX,
	float *sourceY) {
	if (!insideRoundedRect(outputX, outputY, transform)) return false;

	const float localX = (outputX - transform.left) / transform.width;
	const float localY = (outputY - transform.top) / transform.height;
	const float sourceAspect = static_cast<float>(sourceWidth) / static_cast<float>(sourceHeight);
	const float targetAspect = transform.width / transform.height;
	float cropX = 0.0f;
	float cropY = 0.0f;
	float cropWidth = static_cast<float>(sourceWidth);
	float cropHeight = static_cast<float>(sourceHeight);
	if (transform.cover && sourceAspect > targetAspect) {
		cropWidth = static_cast<float>(sourceHeight) * targetAspect;
		cropX = (static_cast<float>(sourceWidth) - cropWidth) * 0.5f;
	} else if (transform.cover && sourceAspect < targetAspect) {
		cropHeight = static_cast<float>(sourceWidth) / targetAspect;
		cropY = (static_cast<float>(sourceHeight) - cropHeight) * 0.5f;
	}
	*sourceX = cropX + clampFloat(localX, 0.0f, 1.0f) * fmaxf(0.0f, cropWidth - 1.0f);
	*sourceY = cropY + clampFloat(localY, 0.0f, 1.0f) * fmaxf(0.0f, cropHeight - 1.0f);
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
	const uint8_t *wallpaperY) {
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
	const uint8_t *wallpaperUv) {
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

	outputUv[y * outputPitch + x * 2] = static_cast<uint8_t>(clampFloat(u, 16.0f, 240.0f));
	outputUv[y * outputPitch + x * 2 + 1] =
		static_cast<uint8_t>(clampFloat(v, 16.0f, 240.0f));
}

__global__ void compositeWebcamLuma(
	const uint8_t *sourceY,
	int sourcePitch,
	int sourceWidth,
	int sourceHeight,
	uint8_t *outputY,
	int outputPitch,
	SceneTransform transform,
	bool mirrored) {
	const int localX = static_cast<int>(blockIdx.x * blockDim.x + threadIdx.x);
	const int localY = static_cast<int>(blockIdx.y * blockDim.y + threadIdx.y);
	if (localX >= static_cast<int>(ceilf(transform.width)) ||
		localY >= static_cast<int>(ceilf(transform.height))) {
		return;
	}
	const int outputX = static_cast<int>(floorf(transform.left)) + localX;
	const int outputYCoordinate = static_cast<int>(floorf(transform.top)) + localY;
	const float sampleOutputX = static_cast<float>(outputX) + 0.5f;
	const float sampleOutputY = static_cast<float>(outputYCoordinate) + 0.5f;
	float sourceX = 0.0f;
	float sourceYCoordinate = 0.0f;
	if (!mapOutputToSource(
			sampleOutputX,
			sampleOutputY,
			transform,
			sourceWidth,
			sourceHeight,
			&sourceX,
			&sourceYCoordinate)) {
		return;
	}
	if (mirrored) sourceX = static_cast<float>(sourceWidth - 1) - sourceX;
	outputY[outputYCoordinate * outputPitch + outputX] = static_cast<uint8_t>(
		clampFloat(
			samplePlane(
				sourceY,
				sourcePitch,
				sourceWidth,
				sourceHeight,
				sourceX,
				sourceYCoordinate),
			16.0f,
			235.0f));
}

__global__ void compositeWebcamChroma(
	const uint8_t *sourceUv,
	int sourcePitch,
	int sourceWidth,
	int sourceHeight,
	uint8_t *outputUv,
	int outputPitch,
	int outputWidth,
	int outputHeight,
	SceneTransform transform,
	bool mirrored) {
	const int localX = static_cast<int>(blockIdx.x * blockDim.x + threadIdx.x);
	const int localY = static_cast<int>(blockIdx.y * blockDim.y + threadIdx.y);
	const int startX = static_cast<int>(floorf(transform.left * 0.5f));
	const int startY = static_cast<int>(floorf(transform.top * 0.5f));
	const int endX = static_cast<int>(ceilf((transform.left + transform.width) * 0.5f));
	const int endY = static_cast<int>(ceilf((transform.top + transform.height) * 0.5f));
	const int chromaX = startX + localX;
	const int chromaY = startY + localY;
	if (chromaX >= endX || chromaY >= endY || chromaX < 0 || chromaY < 0 ||
		chromaX >= outputWidth / 2 || chromaY >= outputHeight / 2) {
		return;
	}
	const float sampleOutputX = static_cast<float>(chromaX * 2) + 1.0f;
	const float sampleOutputY = static_cast<float>(chromaY * 2) + 1.0f;
	float sourceX = 0.0f;
	float sourceYCoordinate = 0.0f;
	if (!mapOutputToSource(
			sampleOutputX,
			sampleOutputY,
			transform,
			sourceWidth,
			sourceHeight,
			&sourceX,
			&sourceYCoordinate)) {
		return;
	}
	if (mirrored) sourceX = static_cast<float>(sourceWidth - 1) - sourceX;
	const float sourceChromaX = sourceX * 0.5f;
	const float sourceChromaY = sourceYCoordinate * 0.5f;
	const int outputOffset = chromaY * outputPitch + chromaX * 2;
	outputUv[outputOffset] = static_cast<uint8_t>(
		clampFloat(
			sampleInterleavedPlane(
				sourceUv,
				sourcePitch,
				sourceWidth / 2,
				sourceHeight / 2,
				sourceChromaX,
				sourceChromaY,
				0),
			16.0f,
			240.0f));
	outputUv[outputOffset + 1] = static_cast<uint8_t>(
		clampFloat(
			sampleInterleavedPlane(
				sourceUv,
				sourcePitch,
				sourceWidth / 2,
				sourceHeight / 2,
				sourceChromaX,
				sourceChromaY,
				1),
			16.0f,
			240.0f));
}

__device__ float webcamShadowAlpha(
	float outputX,
	float outputY,
	const SceneTransform &transform,
	float blur,
	float offsetX,
	float offsetY) {
	const float shiftedX = outputX - offsetX;
	const float shiftedY = outputY - offsetY;
	const float radius =
		clampFloat(transform.borderRadius, 0.0f, fminf(transform.width, transform.height) * 0.5f);
	const float nearestX =
		clampFloat(shiftedX, transform.left + radius, transform.left + transform.width - radius);
	const float nearestY =
		clampFloat(shiftedY, transform.top + radius, transform.top + transform.height - radius);
	const float dx = shiftedX - nearestX;
	const float dy = shiftedY - nearestY;
	const float distance = sqrtf(dx * dx + dy * dy);
	if (distance <= radius) return 0.35f;
	const float outsideDistance = distance - radius;
	const float sigma = fmaxf(1.0f, blur * 0.5f);
	return 0.35f * expf(-(outsideDistance * outsideDistance) / (2.0f * sigma * sigma));
}

__global__ void compositeWebcamShadowLuma(
	uint8_t *outputY,
	int outputPitch,
	int startX,
	int startY,
	int width,
	int height,
	SceneTransform transform,
	float blur,
	float offsetX,
	float offsetY) {
	const int localX = static_cast<int>(blockIdx.x * blockDim.x + threadIdx.x);
	const int localY = static_cast<int>(blockIdx.y * blockDim.y + threadIdx.y);
	if (localX >= width || localY >= height) return;
	const int outputX = startX + localX;
	const int outputYCoordinate = startY + localY;
	const float alpha = webcamShadowAlpha(
		static_cast<float>(outputX) + 0.5f,
		static_cast<float>(outputYCoordinate) + 0.5f,
		transform,
		blur,
		offsetX,
		offsetY);
	if (alpha <= 0.001f) return;
	const int offset = outputYCoordinate * outputPitch + outputX;
	outputY[offset] = static_cast<uint8_t>(
		clampFloat(static_cast<float>(outputY[offset]) * (1.0f - alpha) + 16.0f * alpha, 16.0f, 235.0f));
}

__global__ void compositeWebcamShadowChroma(
	uint8_t *outputUv,
	int outputPitch,
	int startX,
	int startY,
	int width,
	int height,
	SceneTransform transform,
	float blur,
	float offsetX,
	float offsetY) {
	const int localX = static_cast<int>(blockIdx.x * blockDim.x + threadIdx.x);
	const int localY = static_cast<int>(blockIdx.y * blockDim.y + threadIdx.y);
	if (localX >= width || localY >= height) return;
	const int chromaX = startX + localX;
	const int chromaY = startY + localY;
	const float alpha = webcamShadowAlpha(
		static_cast<float>(chromaX * 2) + 1.0f,
		static_cast<float>(chromaY * 2) + 1.0f,
		transform,
		blur,
		offsetX,
		offsetY);
	if (alpha <= 0.001f) return;
	const int offset = chromaY * outputPitch + chromaX * 2;
	outputUv[offset] = static_cast<uint8_t>(
		clampFloat(static_cast<float>(outputUv[offset]) * (1.0f - alpha) + 128.0f * alpha, 16.0f, 240.0f));
	outputUv[offset + 1] = static_cast<uint8_t>(
		clampFloat(
			static_cast<float>(outputUv[offset + 1]) * (1.0f - alpha) + 128.0f * alpha,
			16.0f,
			240.0f));
}

__global__ void compositeOverlayLuma(
	uint8_t *outputY,
	int outputPitch,
	const uint8_t *overlayRgba,
	int overlayX,
	int overlayY,
	int overlayWidth,
	int overlayHeight) {
	const int x = static_cast<int>(blockIdx.x * blockDim.x + threadIdx.x);
	const int y = static_cast<int>(blockIdx.y * blockDim.y + threadIdx.y);
	if (x >= overlayWidth || y >= overlayHeight) return;

	const int overlayOffset = (y * overlayWidth + x) * 4;
	const float red = static_cast<float>(overlayRgba[overlayOffset]);
	const float green = static_cast<float>(overlayRgba[overlayOffset + 1]);
	const float blue = static_cast<float>(overlayRgba[overlayOffset + 2]);
	const float alpha = static_cast<float>(overlayRgba[overlayOffset + 3]) / 255.0f;
	if (alpha <= 0.0f) return;
	const int outputOffset = (overlayY + y) * outputPitch + overlayX + x;
	const float value = static_cast<float>(outputY[outputOffset]);
	const float overlayValue = 16.0f + 0.182586f * red + 0.614231f * green + 0.062007f * blue;
	outputY[outputOffset] = static_cast<uint8_t>(
		clampFloat(value * (1.0f - alpha) + overlayValue * alpha, 16.0f, 235.0f));
}

__global__ void compositeOverlayChroma(
	uint8_t *outputUv,
	int outputPitch,
	const uint8_t *overlayRgba,
	int overlayX,
	int overlayY,
	int overlayWidth,
	int overlayHeight,
	int chromaStartX,
	int chromaStartY,
	int chromaWidth,
	int chromaHeight) {
	const int localChromaX = static_cast<int>(blockIdx.x * blockDim.x + threadIdx.x);
	const int localChromaY = static_cast<int>(blockIdx.y * blockDim.y + threadIdx.y);
	if (localChromaX >= chromaWidth || localChromaY >= chromaHeight) return;
	const int chromaX = chromaStartX + localChromaX;
	const int chromaY = chromaStartY + localChromaY;

	float alpha = 0.0f;
	float red = 0.0f;
	float green = 0.0f;
	float blue = 0.0f;
	for (int dy = 0; dy < 2; dy++) {
		for (int dx = 0; dx < 2; dx++) {
			const int outputX = chromaX * 2 + dx;
			const int outputY = chromaY * 2 + dy;
			const int localX = outputX - overlayX;
			const int localY = outputY - overlayY;
			if (localX < 0 || localY < 0 || localX >= overlayWidth || localY >= overlayHeight) continue;
			const int overlayOffset = (localY * overlayWidth + localX) * 4;
			const float pixelAlpha = static_cast<float>(overlayRgba[overlayOffset + 3]) / 255.0f;
			alpha += pixelAlpha;
			red += static_cast<float>(overlayRgba[overlayOffset]) * pixelAlpha;
			green += static_cast<float>(overlayRgba[overlayOffset + 1]) * pixelAlpha;
			blue += static_cast<float>(overlayRgba[overlayOffset + 2]) * pixelAlpha;
		}
	}
	if (alpha <= 0.0f) return;
	red /= alpha;
	green /= alpha;
	blue /= alpha;
	const float blend = alpha * 0.25f;
	const int outputOffset = chromaY * outputPitch + chromaX * 2;
	const float currentU = static_cast<float>(outputUv[outputOffset]);
	const float currentV = static_cast<float>(outputUv[outputOffset + 1]);
	const float overlayU = 128.0f - 0.100644f * red - 0.338572f * green + 0.439216f * blue;
	const float overlayV = 128.0f + 0.439216f * red - 0.398942f * green - 0.040274f * blue;
	outputUv[outputOffset] = static_cast<uint8_t>(
		clampFloat(currentU * (1.0f - blend) + overlayU * blend, 16.0f, 240.0f));
	outputUv[outputOffset + 1] = static_cast<uint8_t>(
		clampFloat(currentV * (1.0f - blend) + overlayV * blend, 16.0f, 240.0f));
}

struct ExportState {
	AVBufferRef *deviceRef = nullptr;
	AVBufferRef *outputFramesRef = nullptr;
	AVFormatContext *inputFormat = nullptr;
	AVFormatContext *outputFormat = nullptr;
	AVCodecContext *decoder = nullptr;
	AVFormatContext *webcamInputFormat = nullptr;
	AVCodecContext *webcamDecoder = nullptr;
	AVStream *webcamInputStream = nullptr;
	int webcamInputStreamIndex = -1;
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
		avcodec_free_context(&webcamDecoder);
		avformat_close_input(&inputFormat);
		avformat_close_input(&webcamInputFormat);
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

void initializeWebcamInput(ExportState &state, const WebcamPlan &webcam) {
	requireAv(
		avformat_open_input(&state.webcamInputFormat, webcam.inputPath.c_str(), nullptr, nullptr),
		"open webcam input");
	requireAv(
		avformat_find_stream_info(state.webcamInputFormat, nullptr),
		"read webcam input stream info");
	state.webcamInputStreamIndex = av_find_best_stream(
		state.webcamInputFormat,
		AVMEDIA_TYPE_VIDEO,
		-1,
		-1,
		nullptr,
		0);
	requireAv(state.webcamInputStreamIndex, "find webcam video stream");
	state.webcamInputStream = state.webcamInputFormat->streams[state.webcamInputStreamIndex];

	const AVCodec *decoder = avcodec_find_decoder(state.webcamInputStream->codecpar->codec_id);
	if (!decoder) fail("No decoder found for webcam codec");
	state.webcamDecoder = avcodec_alloc_context3(decoder);
	if (!state.webcamDecoder) fail("Could not allocate webcam decoder context");
	requireAv(
		avcodec_parameters_to_context(state.webcamDecoder, state.webcamInputStream->codecpar),
		"copy webcam decoder parameters");
	state.webcamDecoder->get_format = selectCudaFormat;
	state.webcamDecoder->hw_device_ctx = av_buffer_ref(state.deviceRef);
	if (!state.webcamDecoder->hw_device_ctx) {
		fail("Could not reference CUDA device for webcam decoder");
	}
	state.webcamDecoder->extra_hw_frames = 8;
	requireAv(avcodec_open2(state.webcamDecoder, decoder, nullptr), "open CUDA webcam decoder");
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

SceneTransform plannedWebcamTransform(const ExportPlan &plan, const PlannedFrame &frame) {
	const WebcamPlan &webcam = plan.webcam;
	const float scale = frame.webcamScale;
	SceneTransform transform{};
	transform.left =
		webcam.x + (webcam.anchorRight ? webcam.width * (1.0f - scale) : 0.0f);
	transform.top =
		webcam.y + (webcam.anchorBottom ? webcam.height * (1.0f - scale) : 0.0f);
	transform.width = webcam.width * scale;
	transform.height = webcam.height * scale;
	transform.borderRadius = webcam.borderRadius * scale;
	transform.cover = true;
	return transform;
}

double compositeFrame(
	ExportState &state,
	const ExportPlan &plan,
	const AVFrame *source,
	const AVFrame *webcamSource,
	AVFrame *output,
	const SceneTransform &transform,
	const SceneTransform *webcamTransform,
	float motionBlurX,
	float motionBlurY,
	const GpuAssets &assets,
	double sourceTimestampMs) {
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
		assets.wallpaper);
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
		assets.wallpaper + static_cast<std::size_t>(outputWidth) * outputHeight);
	requireRuntime(cudaGetLastError(), "compositeChroma launch");

	if (webcamSource && webcamTransform) {
		verifyDecodedFrame(webcamSource);
		const WebcamPlan &webcam = plan.webcam;
		if (webcamSource->width != webcam.sourceWidth ||
			webcamSource->height != webcam.sourceHeight) {
			fail(
				"Decoded webcam dimensions " + std::to_string(webcamSource->width) + "x" +
				std::to_string(webcamSource->height) + " do not match plan " +
				std::to_string(webcam.sourceWidth) + "x" +
				std::to_string(webcam.sourceHeight));
		}
		if (webcam.shadowEnabled) {
			const float expansion = webcam.shadowBlur * 3.0f;
			const int shadowStartX = std::max(
				0,
				static_cast<int>(floorf(
					webcamTransform->left + webcam.shadowOffsetX - expansion)));
			const int shadowStartY = std::max(
				0,
				static_cast<int>(floorf(
					webcamTransform->top + webcam.shadowOffsetY - expansion)));
			const int shadowEndX = std::min(
				outputWidth,
				static_cast<int>(ceilf(
					webcamTransform->left + webcamTransform->width +
					webcam.shadowOffsetX + expansion)));
			const int shadowEndY = std::min(
				outputHeight,
				static_cast<int>(ceilf(
					webcamTransform->top + webcamTransform->height +
					webcam.shadowOffsetY + expansion)));
			const int shadowWidth = std::max(0, shadowEndX - shadowStartX);
			const int shadowHeight = std::max(0, shadowEndY - shadowStartY);
			if (shadowWidth > 0 && shadowHeight > 0) {
				const dim3 shadowLumaGrid(
					(shadowWidth + block.x - 1) / block.x,
					(shadowHeight + block.y - 1) / block.y);
				compositeWebcamShadowLuma<<<shadowLumaGrid, block, 0, stream>>>(
					output->data[0],
					output->linesize[0],
					shadowStartX,
					shadowStartY,
					shadowWidth,
					shadowHeight,
					*webcamTransform,
					webcam.shadowBlur,
					webcam.shadowOffsetX,
					webcam.shadowOffsetY);
				requireRuntime(cudaGetLastError(), "compositeWebcamShadowLuma launch");

				const int shadowChromaStartX = shadowStartX / 2;
				const int shadowChromaStartY = shadowStartY / 2;
				const int shadowChromaEndX = (shadowEndX + 1) / 2;
				const int shadowChromaEndY = (shadowEndY + 1) / 2;
				const int shadowChromaWidth = shadowChromaEndX - shadowChromaStartX;
				const int shadowChromaHeight = shadowChromaEndY - shadowChromaStartY;
				const dim3 shadowChromaGrid(
					(shadowChromaWidth + block.x - 1) / block.x,
					(shadowChromaHeight + block.y - 1) / block.y);
				compositeWebcamShadowChroma<<<shadowChromaGrid, block, 0, stream>>>(
					output->data[1],
					output->linesize[1],
					shadowChromaStartX,
					shadowChromaStartY,
					shadowChromaWidth,
					shadowChromaHeight,
					*webcamTransform,
					webcam.shadowBlur,
					webcam.shadowOffsetX,
					webcam.shadowOffsetY);
				requireRuntime(cudaGetLastError(), "compositeWebcamShadowChroma launch");
			}
		}

		const int webcamWidth = static_cast<int>(ceilf(webcamTransform->width));
		const int webcamHeight = static_cast<int>(ceilf(webcamTransform->height));
		const dim3 webcamLumaGrid(
			(webcamWidth + block.x - 1) / block.x,
			(webcamHeight + block.y - 1) / block.y);
		compositeWebcamLuma<<<webcamLumaGrid, block, 0, stream>>>(
			webcamSource->data[0],
			webcamSource->linesize[0],
			webcamSource->width,
			webcamSource->height,
			output->data[0],
			output->linesize[0],
			*webcamTransform,
			webcam.mirrored);
		requireRuntime(cudaGetLastError(), "compositeWebcamLuma launch");

		const int webcamChromaStartX = static_cast<int>(floorf(webcamTransform->left * 0.5f));
		const int webcamChromaStartY = static_cast<int>(floorf(webcamTransform->top * 0.5f));
		const int webcamChromaEndX =
			static_cast<int>(ceilf((webcamTransform->left + webcamTransform->width) * 0.5f));
		const int webcamChromaEndY =
			static_cast<int>(ceilf((webcamTransform->top + webcamTransform->height) * 0.5f));
		const int webcamChromaWidth = webcamChromaEndX - webcamChromaStartX;
		const int webcamChromaHeight = webcamChromaEndY - webcamChromaStartY;
		const dim3 webcamChromaGrid(
			(webcamChromaWidth + block.x - 1) / block.x,
			(webcamChromaHeight + block.y - 1) / block.y);
		compositeWebcamChroma<<<webcamChromaGrid, block, 0, stream>>>(
			webcamSource->data[1],
			webcamSource->linesize[1],
			webcamSource->width,
			webcamSource->height,
			output->data[1],
			output->linesize[1],
			outputWidth,
			outputHeight,
			*webcamTransform,
			webcam.mirrored);
		requireRuntime(cudaGetLastError(), "compositeWebcamChroma launch");
	}

	for (const auto &overlay : assets.overlays) {
		if (sourceTimestampMs < overlay.startMs || sourceTimestampMs >= overlay.endMs) continue;
		const dim3 overlayLumaGrid(
			(overlay.width + block.x - 1) / block.x,
			(overlay.height + block.y - 1) / block.y);
		compositeOverlayLuma<<<overlayLumaGrid, block, 0, stream>>>(
			output->data[0],
			output->linesize[0],
			overlay.pixels,
			overlay.x,
			overlay.y,
			overlay.width,
			overlay.height);
		requireRuntime(cudaGetLastError(), "compositeOverlayLuma launch");

		const int chromaStartX = overlay.x / 2;
		const int chromaStartY = overlay.y / 2;
		const int chromaEndX = (overlay.x + overlay.width + 1) / 2;
		const int chromaEndY = (overlay.y + overlay.height + 1) / 2;
		const int chromaWidth = chromaEndX - chromaStartX;
		const int chromaHeight = chromaEndY - chromaStartY;
		const dim3 overlayChromaGrid(
			(chromaWidth + block.x - 1) / block.x,
			(chromaHeight + block.y - 1) / block.y);
		compositeOverlayChroma<<<overlayChromaGrid, block, 0, stream>>>(
			output->data[1],
			output->linesize[1],
			overlay.pixels,
			overlay.x,
			overlay.y,
			overlay.width,
			overlay.height,
			chromaStartX,
			chromaStartY,
			chromaWidth,
			chromaHeight);
		requireRuntime(cudaGetLastError(), "compositeOverlayChroma launch");
	}
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
	if (plan.version != 4) fail("Unsupported native GPU export plan version");
	plan.width = document.at("width").get<int>();
	plan.height = document.at("height").get<int>();
	plan.inputPath = document.at("inputPath").get<std::string>();
	plan.wallpaperNv12Path = document.at("wallpaperNv12Path").get<std::string>();
	const auto &screenRect = document.at("screenRect");
	plan.screenX = screenRect.at("x").get<float>();
	plan.screenY = screenRect.at("y").get<float>();
	plan.screenWidth = screenRect.at("width").get<float>();
	plan.screenHeight = screenRect.at("height").get<float>();
	plan.screenCover = document.at("screenCover").get<bool>();
	plan.screenBorderRadius = document.at("screenBorderRadius").get<float>();
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
		const double sourceTimestampMs = item.at("sourceTimestampMs").get<double>();
		const float cameraScale = item.at("cameraScale").get<float>();
		const float cameraX = item.at("cameraX").get<float>();
		const float cameraY = item.at("cameraY").get<float>();
		const float webcamScale = item.at("webcamScale").get<float>();
		if (!std::isfinite(motionBlurX) || !std::isfinite(motionBlurY) ||
			!std::isfinite(sourceTimestampMs) || !std::isfinite(cameraScale) ||
			!std::isfinite(cameraX) || !std::isfinite(cameraY) ||
			!std::isfinite(webcamScale) || sourceTimestampMs < 0.0 ||
			cameraScale <= 0.0f || cameraScale > 10.0f || webcamScale < 0.35f ||
			webcamScale > 1.0f || fabs(motionBlurX) > 128.0f ||
			fabs(motionBlurY) > 128.0f) {
			fail("Native GPU export frame transform is invalid");
		}
		plan.frames.push_back({
			sourceTimestampMs,
			cameraScale,
			cameraX,
			cameraY,
			motionBlurX,
			motionBlurY,
			webcamScale,
		});
	}
	if (!std::isfinite(plan.screenX) || !std::isfinite(plan.screenY) ||
		!std::isfinite(plan.screenWidth) || !std::isfinite(plan.screenHeight) ||
		!std::isfinite(plan.screenBorderRadius) || plan.screenWidth <= 0.0f ||
		plan.screenHeight <= 0.0f || plan.screenX < 0.0f || plan.screenY < 0.0f ||
		plan.screenX + plan.screenWidth > static_cast<float>(plan.width) + 0.001f ||
		plan.screenY + plan.screenHeight > static_cast<float>(plan.height) + 0.001f ||
		plan.screenBorderRadius < 0.0f) {
		fail("Native GPU export screen layout is invalid");
	}
	if (document.contains("webcam")) {
		const auto &item = document.at("webcam");
		plan.webcam.enabled = true;
		plan.webcam.inputPath = item.at("inputPath").get<std::string>();
		plan.webcam.sourceWidth = item.at("sourceWidth").get<int>();
		plan.webcam.sourceHeight = item.at("sourceHeight").get<int>();
		const auto &rect = item.at("rect");
		plan.webcam.x = rect.at("x").get<float>();
		plan.webcam.y = rect.at("y").get<float>();
		plan.webcam.width = rect.at("width").get<float>();
		plan.webcam.height = rect.at("height").get<float>();
		plan.webcam.borderRadius = item.at("borderRadius").get<float>();
		const std::string maskShape = item.at("maskShape").get<std::string>();
		if (maskShape == "rectangle") {
			plan.webcam.maskShape = WebcamMaskShape::Rectangle;
		} else if (maskShape == "rounded") {
			plan.webcam.maskShape = WebcamMaskShape::Rounded;
		} else if (maskShape == "circle") {
			plan.webcam.maskShape = WebcamMaskShape::Circle;
			plan.webcam.borderRadius =
				std::min(plan.webcam.width, plan.webcam.height) * 0.5f;
		} else if (maskShape == "square") {
			plan.webcam.maskShape = WebcamMaskShape::Square;
		} else {
			fail("Native GPU export webcam mask shape is invalid");
		}
		plan.webcam.mirrored = item.at("mirrored").get<bool>();
		plan.webcam.anchorRight = item.at("anchorRight").get<bool>();
		plan.webcam.anchorBottom = item.at("anchorBottom").get<bool>();
		if (!item.at("shadow").is_null()) {
			const auto &shadow = item.at("shadow");
			plan.webcam.shadowEnabled = true;
			plan.webcam.shadowBlur = shadow.at("blur").get<float>();
			plan.webcam.shadowOffsetX = shadow.at("offsetX").get<float>();
			plan.webcam.shadowOffsetY = shadow.at("offsetY").get<float>();
		}
		if (plan.webcam.inputPath.empty() || plan.webcam.sourceWidth <= 0 ||
			plan.webcam.sourceHeight <= 0 || plan.webcam.sourceWidth % 2 != 0 ||
			plan.webcam.sourceHeight % 2 != 0 || !std::isfinite(plan.webcam.x) ||
			!std::isfinite(plan.webcam.y) || !std::isfinite(plan.webcam.width) ||
			!std::isfinite(plan.webcam.height) || !std::isfinite(plan.webcam.borderRadius) ||
			plan.webcam.x < 0.0f || plan.webcam.y < 0.0f || plan.webcam.width <= 0.0f ||
			plan.webcam.height <= 0.0f ||
			plan.webcam.x + plan.webcam.width > static_cast<float>(plan.width) + 0.001f ||
			plan.webcam.y + plan.webcam.height > static_cast<float>(plan.height) + 0.001f ||
			plan.webcam.borderRadius < 0.0f || !std::isfinite(plan.webcam.shadowBlur) ||
			!std::isfinite(plan.webcam.shadowOffsetX) ||
			!std::isfinite(plan.webcam.shadowOffsetY) || plan.webcam.shadowBlur < 0.0f) {
			fail("Native GPU export webcam layout is invalid");
		}
	}
	for (const auto &item : document.at("overlays")) {
		PlannedOverlay overlay;
		overlay.rgbaPath = item.at("rgbaPath").get<std::string>();
		overlay.startMs = item.at("startMs").get<double>();
		overlay.endMs = item.at("endMs").get<double>();
		overlay.x = item.at("x").get<int>();
		overlay.y = item.at("y").get<int>();
		overlay.width = item.at("width").get<int>();
		overlay.height = item.at("height").get<int>();
		overlay.zIndex = item.at("zIndex").get<int>();
		if (overlay.rgbaPath.empty() || !std::isfinite(overlay.startMs) ||
			!std::isfinite(overlay.endMs) || overlay.startMs < 0.0 ||
			overlay.endMs <= overlay.startMs || overlay.x < 0 || overlay.y < 0 ||
			overlay.width < 1 || overlay.height < 1 || overlay.x + overlay.width > plan.width ||
			overlay.y + overlay.height > plan.height) {
			fail("Native GPU export overlay is invalid");
		}
		plan.overlays.push_back(std::move(overlay));
	}
	if (!std::is_sorted(
			plan.overlays.begin(),
			plan.overlays.end(),
			[](const PlannedOverlay &a, const PlannedOverlay &b) { return a.zIndex < b.zIndex; })) {
		fail("Native GPU export overlays are not ordered by z-index");
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
	assets.overlays.reserve(plan.overlays.size());
	for (const auto &overlay : plan.overlays) {
		const std::size_t bytes = static_cast<std::size_t>(overlay.width) * overlay.height * 4;
		const auto data = readExactFile(overlay.rgbaPath, bytes);
		GpuOverlay gpuOverlay;
		gpuOverlay.startMs = overlay.startMs;
		gpuOverlay.endMs = overlay.endMs;
		gpuOverlay.x = overlay.x;
		gpuOverlay.y = overlay.y;
		gpuOverlay.width = overlay.width;
		gpuOverlay.height = overlay.height;
		requireRuntime(cudaMalloc(&gpuOverlay.pixels, bytes), "cudaMalloc overlay");
		requireRuntime(
			cudaMemcpy(gpuOverlay.pixels, data.data(), bytes, cudaMemcpyHostToDevice),
			"upload overlay");
		assets.overlays.push_back(gpuOverlay);
	}
	CUcontext poppedContext = nullptr;
	requireCuda(cuCtxPopCurrent(&poppedContext), "cuCtxPopCurrent after asset upload");
	return assets;
}

void releaseGpuAssets(ExportState &state, GpuAssets *assets) {
	if (!assets->wallpaper && assets->overlays.empty()) return;
	auto *deviceContext = reinterpret_cast<AVHWDeviceContext *>(state.deviceRef->data);
	auto *cudaContext = reinterpret_cast<AVCUDADeviceContext *>(deviceContext->hwctx);
	requireCuda(cuCtxPushCurrent(cudaContext->cuda_ctx), "cuCtxPushCurrent for asset release");
	if (assets->wallpaper) requireRuntime(cudaFree(assets->wallpaper), "cudaFree wallpaper");
	for (auto &overlay : assets->overlays) {
		if (overlay.pixels) requireRuntime(cudaFree(overlay.pixels), "cudaFree overlay");
		overlay.pixels = nullptr;
	}
	assets->wallpaper = nullptr;
	assets->overlays.clear();
	CUcontext poppedContext = nullptr;
	requireCuda(cuCtxPopCurrent(&poppedContext), "cuCtxPopCurrent after asset release");
}

struct WebcamSelectionState {
	FramePtr previousFrame{nullptr};
	FramePtr currentFrame{nullptr};
	FramePtr decodedFrame{av_frame_alloc()};
	PacketPtr inputPacket{av_packet_alloc()};
	double previousTimestampMs = 0.0;
	double currentTimestampMs = 0.0;
	bool inputEnded = false;
	bool flushSent = false;
	bool decoderEnded = false;
};

double webcamDecodedTimestampMs(const ExportState &state, const AVFrame *frame) {
	const int64_t timestamp =
		frame->best_effort_timestamp != AV_NOPTS_VALUE ? frame->best_effort_timestamp : frame->pts;
	if (timestamp == AV_NOPTS_VALUE) fail("Decoded webcam frame has no timestamp");
	const int64_t startTimestamp =
		state.webcamInputStream->start_time == AV_NOPTS_VALUE
			? 0
			: state.webcamInputStream->start_time;
	return static_cast<double>(timestamp - startTimestamp) *
		av_q2d(state.webcamInputStream->time_base) * 1000.0;
}

bool decodeNextWebcamFrame(ExportState &state, WebcamSelectionState *selection) {
	if (selection->decoderEnded) return false;
	if (!selection->decodedFrame || !selection->inputPacket) {
		fail("Could not allocate webcam decoder frame or packet");
	}
	while (true) {
		const int receiveResult =
			avcodec_receive_frame(state.webcamDecoder, selection->decodedFrame.get());
		if (receiveResult == 0) {
			verifyDecodedFrame(selection->decodedFrame.get());
			FramePtr nextFrame(av_frame_clone(selection->decodedFrame.get()));
			if (!nextFrame) fail("Could not retain decoded webcam CUDA frame");
			const double nextTimestampMs =
				webcamDecodedTimestampMs(state, selection->decodedFrame.get());
			av_frame_unref(selection->decodedFrame.get());
			selection->previousFrame = std::move(selection->currentFrame);
			selection->previousTimestampMs = selection->currentTimestampMs;
			selection->currentFrame = std::move(nextFrame);
			selection->currentTimestampMs = nextTimestampMs;
			return true;
		}
		if (receiveResult == AVERROR_EOF) {
			selection->decoderEnded = true;
			return false;
		}
		if (receiveResult != AVERROR(EAGAIN)) {
			requireAv(receiveResult, "receive CUDA webcam frame");
		}

		if (selection->inputEnded) {
			if (!selection->flushSent) {
				requireAv(
					avcodec_send_packet(state.webcamDecoder, nullptr),
					"flush CUDA webcam decoder");
				selection->flushSent = true;
				continue;
			}
			fail("CUDA webcam decoder requested more packets after flush");
		}

		while (true) {
			const int readResult =
				av_read_frame(state.webcamInputFormat, selection->inputPacket.get());
			if (readResult == AVERROR_EOF) {
				selection->inputEnded = true;
				break;
			}
			requireAv(readResult, "read webcam input packet");
			if (selection->inputPacket->stream_index == state.webcamInputStreamIndex) {
				requireAv(
					avcodec_send_packet(state.webcamDecoder, selection->inputPacket.get()),
					"send packet to CUDA webcam decoder");
				av_packet_unref(selection->inputPacket.get());
				break;
			}
			av_packet_unref(selection->inputPacket.get());
		}
	}
}

const AVFrame *selectWebcamFrameAt(
	ExportState &state,
	WebcamSelectionState *selection,
	double targetTimestampMs) {
	if (!selection->currentFrame && !decodeNextWebcamFrame(state, selection)) {
		fail("Webcam input contains no decodable video frames");
	}
	while (selection->currentTimestampMs + 0.001 < targetTimestampMs &&
		decodeNextWebcamFrame(state, selection)) {
	}
	if (selection->previousFrame &&
		fabs(selection->previousTimestampMs - targetTimestampMs) <
			fabs(selection->currentTimestampMs - targetTimestampMs)) {
		return selection->previousFrame.get();
	}
	return selection->currentFrame.get();
}

void renderOutputFrame(
	ExportState &state,
	const AVFrame *sourceFrame,
	AVPacket *encodedPacket,
	const ExportPlan &plan,
	const GpuAssets &assets,
	WebcamSelectionState *webcamSelection,
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
	const AVFrame *webcamFrame = nullptr;
	SceneTransform webcamTransform{};
	if (plan.webcam.enabled) {
		if (!webcamSelection) fail("Webcam export plan has no decoder state");
		webcamFrame = selectWebcamFrameAt(
			state,
			webcamSelection,
			plannedFrame.sourceTimestampMs);
		webcamTransform = plannedWebcamTransform(plan, plannedFrame);
	}
	*compositorMs += compositeFrame(
		state,
		plan,
		sourceFrame,
		webcamFrame,
		outputFrame.get(),
		transform,
		webcamFrame ? &webcamTransform : nullptr,
		plannedFrame.motionBlurX,
		plannedFrame.motionBlurY,
		assets,
		plannedFrame.sourceTimestampMs);
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
	WebcamSelectionState *webcamSelection,
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
				webcamSelection,
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
	if (plan.webcam.enabled && !std::filesystem::is_regular_file(plan.webcam.inputPath)) {
		fail("Webcam input file does not exist: " + plan.webcam.inputPath);
	}

	ExportState state;
	requireAv(
		av_hwdevice_ctx_create(&state.deviceRef, AV_HWDEVICE_TYPE_CUDA, "0", nullptr, 0),
		"create FFmpeg CUDA device");
	initializeInput(state, inputPath);
	if (plan.webcam.enabled) initializeWebcamInput(state, plan.webcam);
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
	WebcamSelectionState webcamSelection;
	WebcamSelectionState *webcamSelectionPtr =
		plan.webcam.enabled ? &webcamSelection : nullptr;
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
				webcamSelectionPtr,
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
			webcamSelectionPtr,
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
			webcamSelectionPtr,
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
