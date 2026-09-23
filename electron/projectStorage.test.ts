// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	approveContainedProjectAssets,
	inspectProjectFolder,
	isManagedProject,
	prepareRecordingFolder,
	recordingOutputPath,
	removeEmptyRecordingFolder,
	resolveProjectAssets,
	saveStandaloneProject,
} from "./projectStorage";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "videtio-project-storage-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});
const options = { isApprovedSource: () => true };
async function asset(name: string, data = name) {
	const file = path.join(root, name);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, data);
	return file;
}
async function read(file: string) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

describe("standalone project storage", () => {
	it("collects every scene, audio and cursor data, deduplicates shared media, and survives a folder move", async () => {
		const screen = await asset("source/screen.webm");
		const second = await asset("other/screen.webm");
		const webcam = await asset("source/camera.webm");
		const audio = await asset("source/music.wav");
		const wallpaper = await asset("source/bg.png");
		await asset(
			"source/screen.webm.cursor.json",
			JSON.stringify({ samples: [{ time: 42, x: 0.5, y: 0.4 }] }),
		);
		const annotations = [0, 1, 2].map((i) => ({
			id: `caption${i}`,
			content: `Caption ${i}`,
			startMs: i * 1000,
			endMs: (i + 1) * 1000,
			zIndex: i,
		}));
		annotations.push(
			{ id: "overlap1", content: "Lower", startMs: 500, endMs: 2500, zIndex: 4 },
			{ id: "overlap2", content: "Upper", startMs: 1200, endMs: 2700, zIndex: 5 },
		);
		const editor = {
			annotationRegions: annotations,
			audioRegions: [{ sourcePath: audio }],
			wallpaper: pathToFileURL(wallpaper).href,
		};
		const project = {
			version: 2,
			media: { screenVideoPath: screen, webcamVideoPath: webcam },
			editor,
			scenes: [
				{ id: "first", media: { screenVideoPath: screen, webcamVideoPath: webcam }, editor },
				{ id: "second", media: { screenVideoPath: second }, editor: { annotationRegions: [] } },
			],
		};
		const saved = await saveStandaloneProject(project, path.join(root, "Demo.videtio"), options);
		const stored = await read(saved.path);
		expect(stored.media.screenVideoPath).toBe(stored.scenes[0].media.screenVideoPath);
		expect(stored.media.screenVideoPath).not.toBe(stored.scenes[1].media.screenVideoPath);
		expect(JSON.stringify(stored)).not.toContain(root);
		expect(stored.editor.annotationRegions).toEqual(annotations);
		const moved = path.join(root, "Moved");
		await fs.rename(path.dirname(saved.path), moved);
		const movedFile = path.join(moved, "Demo.videtio");
		const loaded = resolveProjectAssets(await read(movedFile), movedFile) as typeof project;
		expect(await fs.readFile(loaded.media.screenVideoPath, "utf8")).toBe("source/screen.webm");
		expect(await read(`${loaded.media.screenVideoPath}.cursor.json`)).toEqual({
			samples: [{ time: 42, x: 0.5, y: 0.4 }],
		});
		expect(await fs.readFile(loaded.scenes[1].media.screenVideoPath, "utf8")).toBe(
			"other/screen.webm",
		);
		expect(loaded.editor.annotationRegions).toEqual(annotations);
		expect(loaded.editor.wallpaper).toContain("/Moved/assets/");
		expect(await fs.readFile(loaded.editor.audioRegions[0].sourcePath, "utf8")).toBe(
			"source/music.wav",
		);
		const approved: string[] = [];
		await approveContainedProjectAssets(loaded, movedFile, (file) => approved.push(file));
		expect(approved).toContain(loaded.scenes[1].media.screenVideoPath);
		expect(approved).toContain(loaded.editor.audioRegions[0].sourcePath);
		const before = await fs.readdir(path.join(moved, "assets"));
		await saveStandaloneProject(loaded, movedFile, options);
		expect(await fs.readdir(path.join(moved, "assets"))).toEqual(before);
		expect((await inspectProjectFolder(movedFile)).bytes).toBeGreaterThan(0);
		// Collecting a legacy project preserves all originals for projects sharing them.
		expect(await fs.readFile(screen, "utf8")).toBe("source/screen.webm");
	});
	it("keeps new recordings together and adopts/renames their folder without duplicating the video", async () => {
		const screen = recordingOutputPath(root, "recording-123.webm");
		const webcam = recordingOutputPath(root, "recording-123-webcam.webm");
		expect(path.dirname(webcam)).toBe(path.dirname(screen));
		await Promise.all([prepareRecordingFolder(screen), prepareRecordingFolder(webcam)]);
		await fs.writeFile(screen, "screen");
		await fs.writeFile(webcam, "camera");
		const saved = await saveStandaloneProject(
			{ media: { screenVideoPath: screen, webcamVideoPath: webcam } },
			path.join(path.dirname(screen), "Tutorial.videtio"),
			{ ...options, reuseRecordingFolder: true },
		);
		expect(saved.path).toBe(path.join(root, "Tutorial", "Tutorial.videtio"));
		expect(await isManagedProject(saved.path)).toBe(true);
		expect(await fs.readdir(path.dirname(saved.path))).toEqual(
			expect.arrayContaining(["recording-123.webm", "recording-123-webcam.webm"]),
		);
		expect(await read(saved.path)).toEqual({
			media: {
				screenVideoPath: "./recording-123.webm",
				webcamVideoPath: "./recording-123-webcam.webm",
			},
		});
		await expect(fs.stat(path.join(root, "recording-123"))).rejects.toThrow();
	});
	it("preserves existing projects when Save As creates an independent copy", async () => {
		const screen = await asset("original.webm");
		const first = await saveStandaloneProject(
			{ media: { screenVideoPath: screen } },
			path.join(root, "First.videtio"),
			options,
		);
		const second = await saveStandaloneProject(
			first.project,
			path.join(root, "Second.videtio"),
			options,
		);
		await fs.rm(path.dirname(first.path), { recursive: true });
		const data = second.project as { media: { screenVideoPath: string } };
		expect(await fs.readFile(data.media.screenVideoPath, "utf8")).toBe("original.webm");
	});
	it("keeps a newly recorded scene inside its saved project when updating the project", async () => {
		const original = await asset("source/first.webm");
		const saved = await saveStandaloneProject(
			{ media: { screenVideoPath: original } },
			path.join(root, "Scenes.videtio"),
			options,
		);
		const fileName = "recording-456.webm";
		const sceneRecording = recordingOutputPath(path.dirname(saved.path), fileName);
		await prepareRecordingFolder(sceneRecording);
		await fs.writeFile(sceneRecording, "second scene");
		const updated = await saveStandaloneProject(
			{
				media: { screenVideoPath: original },
				scenes: [{ id: "second", media: { screenVideoPath: sceneRecording } }],
			},
			saved.path,
			options,
		);
		const stored = await read(updated.path);
		expect(stored.scenes[0].media.screenVideoPath).toBe(
			`./${fileName.replace(/\.webm$/, "")}/${fileName}`,
		);
		expect(await fs.readFile(sceneRecording, "utf8")).toBe("second scene");
	});
	it("stores the first recording of an empty project in its project folder", async () => {
		const saved = await saveStandaloneProject(
			{ version: 2, editor: {}, scenes: [{ id: "first", media: null, editor: {} }] },
			path.join(root, "New Project.videtio"),
			options,
		);
		const fileName = "recording-789.webm";
		const recording = recordingOutputPath(path.dirname(saved.path), fileName);
		await prepareRecordingFolder(recording);
		await fs.writeFile(recording, "first recording");
		const updated = await saveStandaloneProject(
			{
				version: 2,
				media: { screenVideoPath: recording },
				editor: {},
				scenes: [{ id: "first", media: { screenVideoPath: recording }, editor: {} }],
			},
			saved.path,
			options,
		);
		expect(await read(updated.path)).toMatchObject({
			scenes: [{ media: { screenVideoPath: `./recording-789/${fileName}` } }],
		});
		expect(await fs.readFile(recording, "utf8")).toBe("first recording");
	});
	it("does not adopt an existing ordinary directory or remove it after a failed save", async () => {
		await asset("Keep/important.txt");
		await expect(
			saveStandaloneProject({}, path.join(root, "Keep.videtio"), options),
		).rejects.toThrow();
		expect(await fs.readFile(path.join(root, "Keep/important.txt"), "utf8")).toBe(
			"Keep/important.txt",
		);
	});
	it("cleans up a failed new bundle and rejects unapproved sources", async () => {
		const screen = await asset("original.webm");
		await expect(
			saveStandaloneProject(
				{ media: { screenVideoPath: screen } },
				path.join(root, "Failed.videtio"),
				{ isApprovedSource: () => false },
			),
		).rejects.toThrow(/approved/);
		await expect(fs.stat(path.join(root, "Failed"))).rejects.toThrow();
		expect(await fs.readFile(screen, "utf8")).toBe("original.webm");
	});
	it("rejects traversal in recording names and relative project references", () => {
		for (const name of [
			"../other.webm",
			"dir/video.webm",
			"..\\video.webm",
			"..",
			".",
			"/tmp/video.webm",
		])
			expect(() => recordingOutputPath(root, name)).toThrow();
		expect(() =>
			resolveProjectAssets(
				{ media: { screenVideoPath: "../../secret" } },
				path.join(root, "Demo/project.videtio"),
			),
		).toThrow(/escapes/);
	});
	it("refuses trash for loose projects, symlinks and folders containing another project", async () => {
		const loose = await asset("legacy.videtio", "{}");
		await expect(inspectProjectFolder(loose)).rejects.toThrow(/Save/);
		const saved = await saveStandaloneProject({}, path.join(root, "Managed.videtio"), options);
		await fs.symlink(loose, path.join(path.dirname(saved.path), "link"));
		await expect(inspectProjectFolder(saved.path)).rejects.toThrow(/symbolic/);
		await fs.unlink(path.join(path.dirname(saved.path), "link"));
		await fs.writeFile(path.join(path.dirname(saved.path), "another.videtio"), "{}");
		await expect(inspectProjectFolder(saved.path)).rejects.toThrow(/another project/);
	});
	it("removes an empty recording folder only after all recording files were discarded", async () => {
		const screen = recordingOutputPath(root, "recording-1.webm");
		await prepareRecordingFolder(screen);
		await fs.writeFile(screen, "screen");
		await removeEmptyRecordingFolder(path.dirname(screen));
		expect(await fs.readFile(screen, "utf8")).toBe("screen");
		await fs.unlink(screen);
		await removeEmptyRecordingFolder(path.dirname(screen));
		await expect(fs.stat(path.dirname(screen))).rejects.toThrow();
	});
});
