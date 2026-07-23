// electron-builder beforePack hook: validate release metadata and ensure the auto-caption assets
// (Whisper model + ORT wasm) exist before packaging. Runs on every package invocation (local
// `npm run build:*` and CI's bare `electron-builder`). The fetch script is idempotent, so it's a
// no-op once the assets are present.

const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function beforePack() {
	execFileSync("node", [path.join(__dirname, "check-release-version.mjs")], {
		stdio: "inherit",
		cwd: path.join(__dirname, ".."),
	});
	execFileSync("node", [path.join(__dirname, "fetch-caption-model.mjs")], {
		stdio: "inherit",
		cwd: path.join(__dirname, ".."),
	});
};
