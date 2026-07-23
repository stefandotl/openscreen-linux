import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
	return JSON.parse(readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

function fail(message) {
	console.error(`[release-version] ${message}`);
	process.exit(1);
}

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const version = packageJson.version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
	fail(`package.json contains an invalid version: ${JSON.stringify(version)}`);
}

const lockVersions = [
	["package-lock.json version", packageLock.version],
	['package-lock.json packages[""] version', packageLock.packages?.[""]?.version],
];

for (const [source, lockVersion] of lockVersions) {
	if (lockVersion !== version) {
		fail(`${source} is ${JSON.stringify(lockVersion)}, but package.json is ${version}`);
	}
}

let releaseTags = [];
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME) {
	releaseTags = [process.env.GITHUB_REF_NAME];
} else {
	try {
		releaseTags = execFileSync("git", ["tag", "--points-at", "HEAD", "--list", "v*"], {
			cwd: projectRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split(/\r?\n/)
			.filter(Boolean);
	} catch {
		// Source archives and packaged build environments may not contain Git metadata.
	}
}

if (releaseTags.length > 0 && !releaseTags.includes(`v${version}`)) {
	fail(
		`release tag ${releaseTags.join(", ")} does not match package.json version ${version} (expected v${version})`,
	);
}

console.log(`[release-version] package metadata is consistent at ${version}`);
