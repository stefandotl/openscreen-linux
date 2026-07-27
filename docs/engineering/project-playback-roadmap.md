# Project-wide scene playback

## Goal

Add a project preview mode that plays every populated scene in sidebar order. It must make
scene cuts easy to review without replacing the precise scene-local playback used while editing.

This first project-preview milestone covers direct cuts only. Configurable visual or audio
transitions such as crossfades, wipes, or overlap are a separate feature because the current MP4
export renders independent scene segments and concatenates them without overlap.

## Implementation status

Implemented in the editor:

- export-consistent effective duration and bidirectional project/source time mapping;
- the `Scene | Project` scope switch and segmented, duration-proportional project rail;
- deterministic boundary seeking, with an exact boundary selecting the later scene;
- automatic direct cuts across keyed player remounts, including terminal trims;
- bounded project-playback state across pause, switch, resume, and completion;
- eager screen/webcam preload with explicit media errors and metadata timeouts.

A real Electron desktop comparison against native Linux MP4 export remains a release check. Visual
or audio transition effects remain intentionally out of scope.

## Proposed interaction

- Keep the existing scene-local controls as the default editing mode.
- Show a `Scene | Project` scope switch when at least two populated scenes exist.
- In project mode, render one progress rail split into duration-proportional scene segments.
- Mark every scene boundary with a thin divider.
- Use each scene's stable user-defined name in hover and accessibility labels.
- Seeking on the project rail selects the owning scene and seeks to its local source time.
- Playback automatically advances to the next populated scene and keeps the sidebar selection in
  sync.
- Empty scenes remain visible as disabled segments or explicit gaps but are skipped by playback.
- Leaving project mode restores scene-local playback at the active scene's current time.

## Required model

Introduce a derived, non-persisted playback plan:

```ts
interface ProjectPlaybackSegment {
	sceneId: string;
	name: string;
	projectStartSeconds: number;
	projectEndSeconds: number;
	sourceStartSeconds: number;
	sourceEndSeconds: number;
}
```

The plan must be derived from scene order, source duration, trim regions, and speed regions. Do not
use raw media duration as the project duration when trims or speed changes alter the effective
timeline.

Provide narrow conversion helpers:

- project time to scene ID and local source time;
- scene-local source time to project time;
- effective scene duration after trims and speed regions.

These helpers should be unit tested independently from React and media playback.

## Playback orchestration

The current `VideoPlayback` instance is keyed by the active scene and is recreated on scene changes.
A project playback controller should own the cross-scene state so a remount does not accidentally
clear the user's play request.

The controller needs explicit states for:

- idle scene playback;
- project playback;
- switching to the next scene;
- paused project playback;
- completed project playback.

Scene selection for editing must remain separate from the project playhead calculation. Switching a
scene during automatic playback must snapshot the previous scene editor state just as a manual
selection does, but it must not clear the project playback state.

Preload at least the next scene's media metadata before playback starts. If a seamless cut cannot be
guaranteed with one keyed player, evaluate a bounded two-player preview where the next source is
prepared offscreen. A preload or decode failure must stop project playback and show a precise error;
it must not silently skip a populated scene.

## Export consistency

The initial project preview must match the existing export contract:

- scene order is the sidebar order;
- scene boundaries are direct cuts;
- per-scene editor state, trims, speed regions, captions, annotations, cursor, webcam, and audio are
  preserved;
- empty scenes are not exported;
- project duration agrees with the concatenated MP4 duration within normal frame rounding.

Actual transition effects require a separate persisted transition model plus matching preview,
native GPU export planning, renderer composition, audio overlap handling, validation, and tests.
They must not be implemented as preview-only behavior.

## Test and acceptance plan

- Unit-test time mapping with normal, trimmed, sped-up, empty, and reordered scenes.
- Component-test the segmented rail, scope switch, labels, and click-to-seek behavior.
- Browser-test automatic scene advancement and pause/resume across a keyed player remount.
- Verify that seeking exactly on a scene boundary selects the later scene consistently.
- Verify project playback with at least three scenes, including an empty scene between two populated
  scenes.
- Verify captions and overlapping annotations remain timed and layered correctly after an automatic
  scene change.
- Run a real Electron comparison between project preview and a native Linux MP4 export before
  release.

## Suggested delivery slices

1. Duration plan and time-mapping helpers.
2. Segmented project progress rail and manual project seeking.
3. Automatic direct-cut playback across scenes.
4. Next-scene preloading and desktop validation.
5. Separately scoped transition-effect model, only if direct cuts are no longer sufficient.
