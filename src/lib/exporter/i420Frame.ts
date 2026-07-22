export interface PackedI420FrameBuffer {
	data: ArrayBuffer;
	view: Uint8Array;
}

const VERTEX_SHADER_SOURCE = `#version 300 es
const vec2 positions[3] = vec2[3](
	vec2(-1.0, -1.0),
	vec2(3.0, -1.0),
	vec2(-1.0, 3.0)
);

void main() {
	gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D sourceTexture;
uniform int sourceWidth;
uniform int sourceHeight;
uniform int outputWidth;

out vec4 outputColor;

vec3 sourceRgb(int x, int y) {
	return texelFetch(sourceTexture, ivec2(x, y), 0).rgb * 255.0;
}

vec3 chromaRgb(int chromaIndex) {
	int chromaWidth = sourceWidth / 2;
	int x = (chromaIndex % chromaWidth) * 2;
	int y = (chromaIndex / chromaWidth) * 2;
	return (
		sourceRgb(x, y) +
		sourceRgb(x + 1, y) +
		sourceRgb(x, y + 1) +
		sourceRgb(x + 1, y + 1)
	) * 0.25;
}

float packedByte(int byteIndex) {
	int yBytes = sourceWidth * sourceHeight;
	int chromaBytes = (sourceWidth / 2) * (sourceHeight / 2);
	if (byteIndex < 0 || byteIndex >= yBytes + chromaBytes * 2) {
		return 0.0;
	}

	if (byteIndex < yBytes) {
		vec3 rgb = sourceRgb(byteIndex % sourceWidth, byteIndex / sourceWidth);
		float y = 16.0 + dot(rgb, vec3(0.182586, 0.614231, 0.062007));
		return clamp(floor(y + 0.5), 16.0, 235.0);
	}

	int chromaIndex = byteIndex - yBytes;
	bool isV = chromaIndex >= chromaBytes;
	if (isV) {
		chromaIndex -= chromaBytes;
	}
	vec3 rgb = chromaRgb(chromaIndex);
	float chroma = isV
		? 128.0 + dot(rgb, vec3(0.439216, -0.398942, -0.040274))
		: 128.0 + dot(rgb, vec3(-0.100644, -0.338572, 0.439216));
	return clamp(floor(chroma + 0.5), 16.0, 240.0);
}

void main() {
	int pixelIndex = int(gl_FragCoord.y) * outputWidth + int(gl_FragCoord.x);
	int byteIndex = pixelIndex * 4;
	outputColor = vec4(
		packedByte(byteIndex),
		packedByte(byteIndex + 1),
		packedByte(byteIndex + 2),
		packedByte(byteIndex + 3)
	) / 255.0;
}
`;

export function createPackedI420FrameBuffer(width: number, height: number): PackedI420FrameBuffer {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
		throw new Error(`Invalid I420 frame dimensions: ${width}x${height}`);
	}
	if (width % 2 !== 0 || height % 2 !== 0) {
		throw new Error(`I420 frame dimensions must be even: ${width}x${height}`);
	}

	const yBytes = width * height;
	const chromaStride = width / 2;
	const chromaBytes = chromaStride * (height / 2);
	const data = new ArrayBuffer(yBytes + chromaBytes * 2);
	return {
		data,
		view: new Uint8Array(data),
	};
}

function compileShader(
	gl: WebGL2RenderingContext,
	type: typeof gl.VERTEX_SHADER | typeof gl.FRAGMENT_SHADER,
	source: string,
): WebGLShader {
	const shader = gl.createShader(type);
	if (!shader) throw new Error("Failed to allocate GPU I420 shader");
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const message = gl.getShaderInfoLog(shader) || "unknown shader compiler error";
		gl.deleteShader(shader);
		throw new Error(`Failed to compile GPU I420 shader: ${message}`);
	}
	return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
	const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
	const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
	const program = gl.createProgram();
	if (!program) {
		gl.deleteShader(vertexShader);
		gl.deleteShader(fragmentShader);
		throw new Error("Failed to allocate GPU I420 program");
	}

	gl.attachShader(program, vertexShader);
	gl.attachShader(program, fragmentShader);
	gl.linkProgram(program);
	gl.deleteShader(vertexShader);
	gl.deleteShader(fragmentShader);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const message = gl.getProgramInfoLog(program) || "unknown program linker error";
		gl.deleteProgram(program);
		throw new Error(`Failed to link GPU I420 program: ${message}`);
	}
	return program;
}

function getUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string) {
	const location = gl.getUniformLocation(program, name);
	if (!location) throw new Error(`GPU I420 shader is missing uniform: ${name}`);
	return location;
}

function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
	const texture = gl.createTexture();
	if (!texture) throw new Error("Failed to allocate GPU I420 texture");
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return texture;
}

export class GpuI420FrameConverter {
	readonly frame: PackedI420FrameBuffer;

	private readonly width: number;
	private readonly height: number;
	private readonly canvas: HTMLCanvasElement;
	private readonly gl: WebGL2RenderingContext;
	private readonly program: WebGLProgram;
	private readonly vertexArray: WebGLVertexArrayObject;
	private readonly sourceTexture: WebGLTexture;
	private readonly outputTexture: WebGLTexture;
	private readonly framebuffer: WebGLFramebuffer;
	private readonly outputWidth: number;
	private readonly outputHeight: number;
	private readonly paddedReadback: Uint8Array | null;
	private destroyed = false;

	constructor(width: number, height: number) {
		this.frame = createPackedI420FrameBuffer(width, height);
		this.width = width;
		this.height = height;
		this.outputWidth = width;
		const outputPixels = Math.ceil(this.frame.data.byteLength / 4);
		this.outputHeight = Math.ceil(outputPixels / this.outputWidth);

		this.canvas = document.createElement("canvas");
		this.canvas.width = this.outputWidth;
		this.canvas.height = this.outputHeight;
		const gl = this.canvas.getContext("webgl2", {
			alpha: false,
			antialias: false,
			depth: false,
			desynchronized: true,
			powerPreference: "high-performance",
			premultipliedAlpha: false,
			preserveDrawingBuffer: false,
			stencil: false,
		});
		if (!gl) {
			throw new Error("Required WebGL2 GPU I420 conversion is unavailable");
		}
		this.gl = gl;

		const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
		if (width > maxTextureSize || height > maxTextureSize || this.outputHeight > maxTextureSize) {
			throw new Error(
				`GPU I420 conversion exceeds the WebGL2 texture limit (${maxTextureSize}px): ${width}x${height}`,
			);
		}

		this.program = createProgram(gl);
		const vertexArray = gl.createVertexArray();
		if (!vertexArray) throw new Error("Failed to allocate GPU I420 vertex array");
		this.vertexArray = vertexArray;

		this.sourceTexture = createTexture(gl);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

		this.outputTexture = createTexture(gl);
		gl.texImage2D(
			gl.TEXTURE_2D,
			0,
			gl.RGBA8,
			this.outputWidth,
			this.outputHeight,
			0,
			gl.RGBA,
			gl.UNSIGNED_BYTE,
			null,
		);

		const framebuffer = gl.createFramebuffer();
		if (!framebuffer) throw new Error("Failed to allocate GPU I420 framebuffer");
		this.framebuffer = framebuffer;
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
		gl.framebufferTexture2D(
			gl.FRAMEBUFFER,
			gl.COLOR_ATTACHMENT0,
			gl.TEXTURE_2D,
			this.outputTexture,
			0,
		);
		if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
			throw new Error("Required GPU I420 framebuffer is incomplete");
		}

		// biome-ignore lint/correctness/useHookAtTopLevel: WebGL API, not a React hook
		gl.useProgram(this.program);
		gl.uniform1i(getUniform(gl, this.program, "sourceTexture"), 0);
		gl.uniform1i(getUniform(gl, this.program, "sourceWidth"), width);
		gl.uniform1i(getUniform(gl, this.program, "sourceHeight"), height);
		gl.uniform1i(getUniform(gl, this.program, "outputWidth"), this.outputWidth);
		gl.disable(gl.BLEND);
		gl.disable(gl.DITHER);
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.SCISSOR_TEST);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
		gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

		const readbackBytes = this.outputWidth * this.outputHeight * 4;
		this.paddedReadback =
			readbackBytes === this.frame.data.byteLength ? null : new Uint8Array(readbackBytes);
	}

	convert(
		sourceCanvas: HTMLCanvasElement,
		target: PackedI420FrameBuffer = this.frame,
	): PackedI420FrameBuffer {
		if (this.destroyed) throw new Error("GPU I420 converter was already destroyed");
		if (sourceCanvas.width !== this.width || sourceCanvas.height !== this.height) {
			throw new Error(
				`GPU I420 source dimensions changed: ${sourceCanvas.width}x${sourceCanvas.height} (expected ${this.width}x${this.height})`,
			);
		}
		if (this.gl.isContextLost()) {
			throw new Error("Required WebGL2 context was lost during GPU I420 conversion");
		}
		if (
			target.data.byteLength !== this.frame.data.byteLength ||
			target.view.buffer !== target.data
		) {
			throw new Error(
				`Invalid GPU I420 target buffer: ${target.data.byteLength} bytes (expected ${this.frame.data.byteLength})`,
			);
		}

		const gl = this.gl;
		const readback = this.paddedReadback ?? target.view;
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
		try {
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
		} catch (error) {
			throw new Error(
				`Failed to upload the rendered canvas for GPU I420 conversion: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
		gl.viewport(0, 0, this.outputWidth, this.outputHeight);
		// biome-ignore lint/correctness/useHookAtTopLevel: WebGL API, not a React hook
		gl.useProgram(this.program);
		gl.bindVertexArray(this.vertexArray);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.readPixels(0, 0, this.outputWidth, this.outputHeight, gl.RGBA, gl.UNSIGNED_BYTE, readback);

		const glError = gl.getError();
		if (glError !== gl.NO_ERROR) {
			throw new Error(`GPU I420 conversion failed with WebGL2 error 0x${glError.toString(16)}`);
		}
		if (this.paddedReadback) {
			target.view.set(this.paddedReadback.subarray(0, target.data.byteLength));
		}
		return target;
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		const gl = this.gl;
		gl.deleteFramebuffer(this.framebuffer);
		gl.deleteTexture(this.outputTexture);
		gl.deleteTexture(this.sourceTexture);
		gl.deleteVertexArray(this.vertexArray);
		gl.deleteProgram(this.program);
		this.canvas.width = 0;
		this.canvas.height = 0;
	}
}
