#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const scriptsByPlatform = {
	darwin: ["build-macos-screencapturekit-helper.mjs"],
	linux: ["build-linux-cursor-helper.mjs", "build-linux-export-helper.mjs"],
	win32: ["build-windows-wgc-helper.mjs"],
};

const scripts = scriptsByPlatform[process.platform];
if (!scripts) {
	console.error(`OpenScreen does not have native helpers for platform ${process.platform}.`);
	process.exit(1);
}

for (const script of scripts) {
	const result = spawnSync(process.execPath, [path.join(root, "scripts", script)], {
		cwd: root,
		stdio: "inherit",
		env: process.env,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}
