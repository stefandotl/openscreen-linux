# Project folders

New recordings use one directory per recording under the configured recordings
root. Screen video, optional webcam video, cursor sidecar, and session manifest
stay together. Session manifests use paths relative to their directory.

On the first save in that recording directory, Videtio adopts the directory as a
project folder and renames it to the chosen project name. Imported or legacy
projects are collected into a new folder beside the chosen save path. Existing
ordinary directories are never adopted or overwritten. Saving an existing managed
project updates its project file; Save As / **Collect project…** creates an
independent copy. Original files outside the destination folder are retained.

Example:

```text
recordings/
  Tutorial/
    .videtio-folder.json
    Tutorial.videtio
    recording-1789500000000.webm
    recording-1789500000000.webm.cursor.json
    recording-1789500000000.session.json
    assets/
      <source-hash>-music.wav
```

`electron/projectStorage.ts` owns folder markers, collection, relative path
resolution, and deletion checks. Project loading resolves paths to absolute local
paths before passing data to the renderer. Every scene uses the same asset
visitor, including inactive scenes, shared screen/webcam media, audio clips, and
local background/image files. Embedded images, annotations, and remote font
configuration remain embedded/configured as before. New scene recordings inside
a managed project are created in subdirectories of that project.

The project-name menu in the editor provides **Collect project…** and **Move
project to trash**. Trash operates on the active managed project only, confirms
the folder name and total size, and uses Electron's `shell.trashItem`. Cancel or
failure preserves the active project. Loose legacy projects must first be
collected; their old files are not deleted automatically. Folders containing
symlinks or another project file are rejected for whole-folder deletion.

Saving and trashing share a main-process operation lock. Project JSON writes are
atomic. New destination folders are removed if collection fails; original source
files are retained. The UI blocks editing during a save while copied media paths
are applied. No export-frame or GPU pipeline changes are involved.

## Regression coverage

- `electron/projectStorage.test.ts`: multiple scenes, three sequential captions
  and two overlapping annotations, audio/cursor assets, folder moves, deduplication,
  Save As independence, ownership and traversal checks, and recording cleanup.
- `tests/e2e/project-storage.spec.ts`: real main/preload save/load calls, cancel and
  failed trash operations, simulated trash of temporary fixtures, recording-folder
  adoption, and the editor's project menu.
- `tests/e2e/native-content-tracks.spec.ts` with `VIDETIO_E2E_CONTENT_TRACKS=1`:
  collects and reloads a captioned project before a native GPU export, then checks
  output pixels, annotation order/timing, and imported audio timing.

## Remembered cameras

Device enumeration and webcam acquisition share `selectPreferredCameraDevice`.
A default is chosen only when no preference exists. If a remembered camera is
temporarily absent, its ID and name are preserved and acquisition retries. A
changed Chromium device ID is recovered by the saved camera name. Preference
hydration finishes before automatic camera selection starts; generated display
labels do not replace a known device name.

The delayed virtual-camera case is exercised by
`tests/e2e/recording-preferences.spec.ts` using a simulated camera stream and
incomplete device lists. Physical/virtual device integration still requires a
check on the target desktop after restarting Electron.
