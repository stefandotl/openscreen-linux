#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
	console.log("Skipping Linux GPU export helper build: host platform is not Linux.");
	process.exit(0);
}
if (process.arch !== "x64") {
	console.error(`Linux GPU export helper currently requires x64, got ${process.arch}.`);
	process.exit(1);
}

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const sourcePath = path.join(root, "electron", "native", "linux-export-helper", "src", "main.cu");
const buildDir = path.join(root, "electron", "native", "linux-export-helper", "build");
const outputPath = path.join(buildDir, "openscreen-linux-export-helper");
const distributableDir = path.join(root, "electron", "native", "bin", "linux-x64");
const distributablePath = path.join(distributableDir, "openscreen-linux-export-helper");

function resolveCommand(command) {
	if (path.isAbsolute(command)) return command;
	const result = spawnSync("which", [command], { encoding: "utf-8" });
	if (result.status !== 0 || !result.stdout.trim()) {
		throw new Error(`Required command was not found: ${command}`);
	}
	return result.stdout.trim();
}

function isCurrent(targetPath, inputPaths) {
	if (!fs.existsSync(targetPath)) return false;
	const targetMtime = fs.statSync(targetPath).mtimeMs;
	return inputPaths.every((inputPath) => targetMtime >= fs.statSync(inputPath).mtimeMs);
}

function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

const ffmpegCommand = process.env.OPENSCREEN_FFMPEG_PATH || "ffmpeg";
const ffmpegPath = resolveCommand(ffmpegCommand);
const ffmpegPrefix = process.env.OPENSCREEN_FFMPEG_PREFIX
	? path.resolve(process.env.OPENSCREEN_FFMPEG_PREFIX)
	: path.dirname(path.dirname(fs.realpathSync(ffmpegPath)));
const includeDir = path.join(ffmpegPrefix, "include");
const libraryDir = path.join(ffmpegPrefix, "lib");
const requiredPaths = [
	path.join(includeDir, "libavcodec", "avcodec.h"),
	path.join(includeDir, "libavformat", "avformat.h"),
	path.join(includeDir, "nlohmann", "json.hpp"),
];
for (const requiredPath of requiredPaths) {
	if (!fs.existsSync(requiredPath)) {
		console.error(
			`Missing native export dependency: ${requiredPath}\nSet OPENSCREEN_FFMPEG_PREFIX to the FFmpeg development prefix.`,
		);
		process.exit(1);
	}
}

fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(distributableDir, { recursive: true });
const inputs = [sourcePath, scriptPath];
if (!isCurrent(outputPath, inputs)) {
	const nvcc = resolveCommand(process.env.CUDACXX || "nvcc");
	const defaultHostCompiler = fs.existsSync("/usr/bin/g++-12") ? "/usr/bin/g++-12" : "g++";
	const hostCompiler = resolveCommand(process.env.CXX || defaultHostCompiler);
	run(nvcc, [
		"-ccbin",
		hostCompiler,
		"-std=c++17",
		"-O3",
		"-lineinfo",
		`-I${includeDir}`,
		sourcePath,
		`-L${libraryDir}`,
		"-lavformat",
		"-lavcodec",
		"-lavutil",
		"-lcuda",
		"-lcudart",
		"-Xlinker",
		"-rpath",
		"-Xlinker",
		libraryDir,
		"-o",
		outputPath,
	]);
	fs.chmodSync(outputPath, 0o755);
} else {
	console.log(`Linux GPU export helper is up to date: ${outputPath}`);
}

if (!isCurrent(distributablePath, [outputPath])) {
	fs.copyFileSync(outputPath, distributablePath);
	fs.chmodSync(distributablePath, 0o755);
}
console.log(`Linux GPU export helper: ${outputPath}`);
console.log(`Redistributable helper: ${distributablePath}`);
