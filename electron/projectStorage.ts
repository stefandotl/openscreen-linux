import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKER = ".videtio-folder.json";
interface FolderMarker {
	kind: "videtio-recording" | "videtio-project";
	version: 1;
	projectFile?: string;
}

function within(file: string, directory: string): boolean {
	const relative = path.relative(directory, file);
	return (
		relative !== "" &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

async function markerAt(directory: string): Promise<FolderMarker | null> {
	try {
		const stat = await fs.lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
		const markerPath = path.join(directory, MARKER);
		const markerStat = await fs.lstat(markerPath);
		if (!markerStat.isFile() || markerStat.isSymbolicLink()) return null;
		const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
		if (marker.version !== 1 || !["videtio-recording", "videtio-project"].includes(marker.kind))
			return null;
		return marker;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export async function isManagedProject(projectPath: string): Promise<boolean> {
	const marker = await markerAt(path.dirname(projectPath));
	return marker?.kind === "videtio-project" && marker.projectFile === path.basename(projectPath);
}

export async function isRecordingFolder(directory: string): Promise<boolean> {
	return (await markerAt(directory))?.kind === "videtio-recording";
}

export function recordingOutputPath(recordingsRoot: string, fileName: string): string {
	if (
		!fileName ||
		fileName.trim() !== fileName ||
		fileName.includes("/") ||
		fileName.includes("\\") ||
		fileName === "." ||
		fileName === ".." ||
		fileName.includes("\0")
	) {
		throw new Error("Recording file name must not contain path segments");
	}
	const name = path.parse(fileName).name.replace(/-webcam$/, "");
	if (!name || name === "." || name === "..") throw new Error("Invalid recording file name");
	return path.join(recordingsRoot, name, fileName);
}

const recordingFolderPreparations = new Map<string, Promise<void>>();
export async function prepareRecordingFolder(filePath: string): Promise<void> {
	const directory = path.dirname(filePath);
	const pending = recordingFolderPreparations.get(directory);
	if (pending) return pending;
	const operation = initializeRecordingFolder(filePath);
	recordingFolderPreparations.set(directory, operation);
	try {
		await operation;
	} finally {
		recordingFolderPreparations.delete(directory);
	}
}

async function initializeRecordingFolder(filePath: string): Promise<void> {
	const directory = path.dirname(filePath);
	await fs.mkdir(directory, { recursive: true });
	const stat = await fs.lstat(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid recording directory");
	if (await markerAt(directory)) return;
	try {
		await fs.writeFile(
			path.join(directory, MARKER),
			JSON.stringify({ kind: "videtio-recording", version: 1 }),
			{ flag: "wx" },
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await markerAt(directory)))
			throw error;
	}
}

// Only asset fields are rewritten; annotation text, URLs and embedded images remain exact.
// All scenes pass through the same visitor, including inactive scenes and shared media.
const PATH_FIELDS = new Set(["screenVideoPath", "webcamVideoPath", "videoPath", "sourcePath"]);
function assetPath(key: string, value: string): string | null {
	if (value.startsWith("file://")) return fileURLToPath(value);
	if (PATH_FIELDS.has(key)) return value;
	if (key === "wallpaper" && path.isAbsolute(value) && !value.startsWith("/wallpapers/"))
		return value;
	return null;
}
function mapAssets(value: unknown, transform: (file: string, asUrl: boolean) => string): unknown {
	if (Array.isArray(value)) return value.map((item) => mapAssets(item, transform));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => {
			if (
				typeof item === "string" &&
				(PATH_FIELDS.has(key) || ["wallpaper", "imageContent", "content"].includes(key))
			) {
				const file = assetPath(key, item);
				if (file) return [key, transform(file, item.startsWith("file://"))];
				// Stored bundle images/wallpapers use an explicit relative prefix.
				if (item.startsWith("./")) return [key, transform(item, !PATH_FIELDS.has(key))];
			}
			return [key, mapAssets(item, transform)];
		}),
	);
}

export function resolveProjectAssets(project: unknown, projectPath: string): unknown {
	const directory = path.dirname(path.resolve(projectPath));
	return mapAssets(project, (file, asUrl) => {
		const absolute = path.isAbsolute(file) ? file : path.resolve(directory, file);
		if (!path.isAbsolute(file) && !within(absolute, directory))
			throw new Error("Project asset escapes its project folder");
		return asUrl ? pathToFileURL(absolute).href : absolute;
	});
}

export async function approveContainedProjectAssets(
	project: unknown,
	projectPath: string,
	approve: (file: string) => void,
) {
	const directory = await fs.realpath(path.dirname(projectPath));
	const files = new Set<string>();
	mapAssets(project, (file) => {
		files.add(file);
		return file;
	});
	for (const file of files) {
		try {
			const real = await fs.realpath(file);
			if (within(real, directory) && (await fs.stat(real)).isFile()) {
				approve(file);
				approve(real);
			}
		} catch (error) {
			// Existing projects may contain missing media; the editor can still open their settings.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export async function removeEmptyRecordingFolder(directory: string) {
	if (!(await isRecordingFolder(directory))) return;
	const entries = await fs.readdir(directory);
	if (entries.length === 1 && entries[0] === MARKER) {
		await fs.unlink(path.join(directory, MARKER));
		await fs.rmdir(directory);
	}
}

async function atomicJson(file: string, value: unknown) {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
		await fs.rename(temporary, file);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

export interface SaveStandaloneOptions {
	isApprovedSource: (file: string) => boolean;
	reuseRecordingFolder?: boolean;
}

/** A new destination must be empty/new. Existing ordinary folders are never adopted. */
export async function saveStandaloneProject(
	project: unknown,
	requestedPath: string,
	options: SaveStandaloneOptions,
) {
	if (!project || typeof project !== "object" || Array.isArray(project))
		throw new Error("Invalid project data");
	requestedPath = path.resolve(requestedPath);
	const updating = await isManagedProject(requestedPath);
	const reuse =
		options.reuseRecordingFolder && (await isRecordingFolder(path.dirname(requestedPath)));
	const directory =
		updating || reuse
			? path.dirname(requestedPath)
			: path.join(path.dirname(requestedPath), path.parse(requestedPath).name);
	const projectPath = path.join(directory, path.basename(requestedPath));
	const finalDirectory = reuse
		? path.join(path.dirname(directory), path.parse(requestedPath).name)
		: directory;
	if (finalDirectory !== directory) {
		try {
			await fs.lstat(finalDirectory);
			throw new Error(
				`A folder named ${path.basename(finalDirectory)} already exists. Choose another project name.`,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	let newDirectory = false;
	const copied: string[] = [];
	try {
		if (!updating && !reuse) {
			await fs.mkdir(directory); // EEXIST deliberately prevents merging unrelated folders.
			newDirectory = true;
		}
		const realDirectory = await fs.realpath(directory);
		const mappings = new Map<string, string>();
		mapAssets(project, (file) => {
			mappings.set(file, "");
			return file;
		});
		for (const file of mappings.keys()) {
			if (!path.isAbsolute(file) || !options.isApprovedSource(file))
				throw new Error(`Project media is not approved: ${file}`);
			const realSource = await fs.realpath(file);
			if (!options.isApprovedSource(realSource))
				throw new Error(`Project media resolves to an unapproved path: ${file}`);
			if (!(await fs.stat(realSource)).isFile())
				throw new Error(`Project media is not a file: ${file}`);
			if (within(realSource, realDirectory)) {
				mappings.set(
					file,
					`./${path.relative(realDirectory, realSource).split(path.sep).join("/")}`,
				);
				continue;
			}
			const assets = path.join(directory, "assets");
			await fs.mkdir(assets, { recursive: true });
			if ((await fs.lstat(assets)).isSymbolicLink())
				throw new Error("Project assets directory must not be a symbolic link");
			const name = `${createHash("sha256").update(realSource).digest("hex").slice(0, 16)}-${path.basename(file)}`;
			const target = path.join(assets, name);
			// Copy to an owned temporary file and rename: never follow a destination symlink.
			const temporary = `${target}.${randomUUID()}.tmp`;
			copied.push(temporary);
			await fs.copyFile(realSource, temporary);
			await fs.rename(temporary, target);
			mappings.set(file, `./assets/${name}`);
			try {
				const cursor = `${file}.cursor.json`;
				const cursorStat = await fs.lstat(cursor);
				if (!cursorStat.isFile() || cursorStat.isSymbolicLink())
					throw new Error("Invalid cursor sidecar");
				await atomicJson(`${target}.cursor.json`, JSON.parse(await fs.readFile(cursor, "utf8")));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const stored = mapAssets(project, (file) => {
			const relative = mappings.get(file);
			if (!relative) throw new Error(`Unresolved project asset: ${file}`);
			return relative;
		});
		await atomicJson(projectPath, stored);
		await atomicJson(path.join(directory, MARKER), {
			kind: "videtio-project",
			version: 1,
			projectFile: path.basename(projectPath),
		});
		if (finalDirectory !== directory) await fs.rename(directory, finalDirectory);
		const finalProjectPath = path.join(finalDirectory, path.basename(projectPath));
		return { path: finalProjectPath, project: resolveProjectAssets(stored, finalProjectPath) };
	} catch (error) {
		if (newDirectory) await fs.rm(directory, { recursive: true, force: true });
		throw error;
	} finally {
		await Promise.all(copied.map((file) => fs.rm(file, { force: true })));
	}
}

export async function inspectProjectFolder(
	projectPath: string,
): Promise<{ directory: string; bytes: number }> {
	projectPath = path.resolve(projectPath);
	if (!(await isManagedProject(projectPath)))
		throw new Error(
			"Save this project into a project folder first using Save As / Collect project. Existing loose files will be kept.",
		);
	const directory = path.dirname(projectPath);
	const count = async (folder: string): Promise<number> => {
		let bytes = 0;
		for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
			const file = path.join(folder, entry.name);
			if (entry.isSymbolicLink())
				throw new Error("Cannot trash a project folder containing symbolic links");
			if (entry.isDirectory()) bytes += await count(file);
			else if (entry.isFile()) {
				if (
					[".videtio", ".videtly", ".openscreen"].includes(path.extname(file)) &&
					file !== projectPath
				)
					throw new Error(
						"This folder contains another project. Move it out before deleting this project.",
					);
				bytes += (await fs.stat(file)).size;
			} else throw new Error("Unexpected file in project folder");
		}
		return bytes;
	};
	return { directory, bytes: await count(directory) };
}
