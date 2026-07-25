#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
	console.error("The macOS package must be built on macOS.");
	process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetArch = process.arch === "arm64" ? "arm64" : "x64";

function runNode(relativeScript, args = [], env = process.env) {
	const result = spawnSync(process.execPath, [path.join(root, relativeScript), ...args], {
		cwd: root,
		stdio: "inherit",
		env,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

runNode("scripts/build-macos-screencapturekit-helper.mjs", [], {
	...process.env,
	OPENSCREEN_MAC_HELPER_ARCHS: targetArch,
});
runNode("node_modules/typescript/bin/tsc");
runNode("node_modules/vite/bin/vite.js", ["build"]);
runNode(
	"node_modules/electron-builder/cli.js",
	["--mac", `--${targetArch}`, "--config.electronDist=node_modules/electron/dist"],
	{
		...process.env,
		CSC_IDENTITY_AUTO_DISCOVERY: "false",
	},
);
