# OpenScreen Linux - AGENTS.md

## Quick commands

| Goal | Command |
|------|---------|
| Electron development mode | `npm run dev` |
| Type check | `npx tsc --noEmit` |
| Unit tests | `npm test` |
| Targeted test file | `npm test -- path/to/file.test.ts` |
| Browser tests | `npm run test:browser` |
| Playwright end-to-end tests | `npm run test:e2e` |
| i18n validation | `npm run i18n:check` |
| Renderer, main, and preload build | `npm run build-vite` |
| Build Linux cursor helper | `npm run build:native:linux-cursor` |
| Build Linux packages | `npm run build:linux` |

Run commands from the repository root unless the command says otherwise. Use targeted tests while iterating, then run the relevant wider suite and `npm run build-vite` for changes that affect Electron boundaries or production bundling.

## Architecture

- **Linux-first Electron desktop app** using Electron 41, React 18, TypeScript, Vite 7, PixiJS 8, and Tailwind CSS.
- **Main process**: `electron/main.ts`. Window setup lives in `electron/windows.ts`; IPC registration and native export orchestration live in `electron/ipc/handlers.ts`.
- **Preload bridge**: `electron/preload.ts`, exposed through `contextBridge`. Keep its public API synchronized with `electron/electron-env.d.ts`.
- **Renderer**: `src/main.tsx` and `src/App.tsx`. The main editor is `src/components/video-editor/VideoEditor.tsx`; preview rendering is centered in `VideoPlayback.tsx` and `videoPlayback/`.
- **Export pipeline**: On the required Linux MP4 path, `StreamingVideoDecoder` reads metadata only. Native FFmpeg decodes source video through CUDA/NVDEC, downloads packed NV12 frames, and sends them to the renderer through a bounded `MessagePort`. `FrameRenderer` composites PixiJS and Canvas effects, then a WebGL2 shader converts the final canvas to packed BT.709 I420 and a second `MessagePort` feeds FFmpeg using `h264_nvenc`. The normal MP4 export rate is 30 fps.
- **GIF pipeline** is separate and has explicit 15/20/25/30 fps settings.
- **Linux recording** uses Electron/Chromium capture. The native Linux helper records cursor position and click timing; build it with `npm run build:native:linux-cursor`.
- **Captions** run locally. NVIDIA Parakeet through `sherpa-onnx-node` is the primary engine; Whisper Tiny through `@xenova/transformers`, ONNX Runtime Web, and a worker remains an explicit alternative. Caption orchestration lives under `src/lib/captioning/`, while privileged Parakeet model and media handling lives under `electron/captioning/`.
- **Generated output** is written to `dist/` and `dist-electron/`. Never edit generated bundles such as `dist-electron/main.js` directly.

## Critical conventions

- **Fail fast and loud. No silent fallbacks for core behavior.** Do not add automatic codec downgrades, alternate export pipelines, empty return values, or `catch-and-continue` behavior that hides a required-path failure. When NVENC, the transferable frame port, media validation, or another required capability fails, stop and expose a precise error in logs and UI.
- **Linux Mint + X11 + NVIDIA RTX 4060 Ti is the primary performance target for current export work.** Make this path correct and fast first. Do not weaken it to preserve speculative or unverified behavior on other platforms unless explicitly requested.
- **Measure before optimizing.** For export performance, separate decode wait, frame rendering, Canvas readback, renderer-to-main transfer, FFmpeg pipe write, and NVENC utilization. Do not infer the bottleneck from total export time or GPU percentage alone.
- **NVDEC/NVENC mean NVIDIA hardware.** On the required Linux native path, source decode must use FFmpeg CUDA/NVDEC and output encode must use `h264_nvenc`. WebCodecs/OpenH264, VAAPI experiments, or another software codec are errors, not acceptable fallbacks.
- **Avoid large payloads through `ipcRenderer.invoke`.** Raw video frames use the dedicated transferable `MessagePort`; ordinary request/response IPC remains appropriate for small control messages.
- **Do not put frame `ArrayBuffer`s in either native `MessagePort` transfer list.** Electron can transfer the port to `MessagePortMain`, but transferring buffer ownership across that boundary stalls frame messages. Send buffers as structured message data and verify every decoded NV12 and rendered I420 frame with an acknowledgement.
- **The native NVDEC input port allows one unacknowledged frame.** Main must wait until the renderer wraps the NV12 payload in a `VideoFrame`; the renderer may then process that frame while Main prepares the next. Preserve this bounded backpressure and strict frame order.
- **The native frame port uses a bounded two-frame pipeline.** One packed I420 buffer may be acknowledged by Main/FFmpeg while the GPU fills the other. Preserve strict request order, per-frame acknowledgements, bounded backpressure, and the final flush before closing FFmpeg stdin.
- **Do not use `VideoFrame.copyTo({ format: "I420" })` for the rendered RGB canvas.** The Electron Chromium build does not support that pixel-format conversion. The required Linux path uses `GpuI420FrameConverter`; conversion failure must stop the export.
- **Keep the native NVENC export canvas GPU-backed on the primary X11 target.** Enabling `useLinuxCpuReadback` there forces a full GPU-to-CPU readback followed by an immediate CPU-to-GPU upload into the I420 shader.
- **Keep editor analysis features off the GPU export hot path.** Silence detection, waveform generation, caption analysis, and similar preprocessing must run only on explicit editor actions or during media preparation. They may produce ordinary timeline metadata such as `trimRegions`, but must not add per-frame work, alternate codecs, extra frame copies, IPC traffic, or behavioral changes to the required CUDA/NVDEC -> renderer -> I420 shader -> NVENC pipeline. Verify that these features preserve the existing native export plan and performance.
- **The required native GPU export must support ordinary editor projects, not a reduced feature subset.** A feature is incomplete if it works in the editor preview but causes the required Linux MP4 path to reject the project. When adding or changing an editor feature, update its native export plan, assets/protocol, renderer composition, validation, and tests in the same task. Do not leave a permanent blocker for state the editor normally creates.
- **Annotations are an unbounded timeline collection.** Auto-captions routinely create dozens of text annotations, and users may also create sequential or overlapping annotations. The native GPU export must preserve every active annotation's timing, position, style, and z-order for zero, one, or many annotations. Do not assume `annotationRegions[0]`, collapse the collection into one static overlay, or reject a project merely because `annotationRegions.length > 1`.
- **Fail-fast rules are not permission to reject supported editor state.** Fail loudly for genuine runtime or capability failures such as unavailable NVENC, invalid media, broken frame IPC, or failed composition. An implementation limitation for normal editor output—especially multiple caption annotations—is unfinished product work and must be implemented before the feature is considered complete.
- **Caption and annotation changes require native-export coverage.** At minimum, test a project with three sequential captions plus two overlapping annotations, verify `getNativeGpuExportBlockers` accepts it, and verify the native output matches preview timing and z-order. For release confidence, run a real Electron export of an auto-captioned recording; unit tests that only cover a single annotation are insufficient.
- **Preserve renderer/main/preload contracts.** Any bridge change must update the preload implementation, global TypeScript declarations, handler registration, cleanup behavior, and focused tests together.
- **Treat media paths as untrusted input.** Normalize and validate paths in the main process before filesystem or FFmpeg access. Do not move privileged filesystem or process access into the renderer.
- **Keep edits scoped.** Preserve unrelated work in a dirty tree and do not rewrite generated files or broad areas merely to support a narrow fix.
- **Desktop behavior needs a real desktop check.** Automated checks can validate types, tests, and builds; the user must verify capture, global shortcuts, dialogs, GPU activity, playback, and exports in the Electron app before release.

## Export performance workflow

1. Reproduce using `npm run dev` with the same project, output resolution, effects, trim regions, speed regions, and frame rate.
2. Capture renderer `[native-nvenc-perf]` logs and main-process `[native-nvdec-main-perf]` plus `[native-nvenc-main-perf]` logs.
3. Check GPU engines with `nvidia-smi dmon` or `nvidia-smi pmon`; distinguish SM load, decoder load, and encoder load.
4. Change only the measured bottleneck, then compare fps and per-stage timings against the same export.
5. Keep diagnostic output readable as one-line JSON while profiling. Remove noisy instrumentation only after the behavior is stable.

For a 1080x1920 I420 export, one raw frame is 3,110,400 bytes. At 30 fps that is roughly 93 MB/s before encoding, so copies across process boundaries remain performance-critical.

## Testing quirks

- Vitest uses jsdom by default. Exporter tests can print the expected `HTMLCanvasElement.getContext()` not-implemented warning without failing.
- Canvas/WebCodecs behavior that depends on a real browser belongs in `*.browser.test.ts` and runs with `npm run test:browser`.
- End-to-end Electron coverage lives under `tests/e2e/`; fixtures live under `tests/fixtures/`.
- `npm run build-vite` builds renderer, Electron main, and preload. The ONNX dependency can emit an existing warning about `eval`; do not confuse that warning with a failed build.
- Main/preload changes require a full Electron restart. Renderer-only changes may hot reload, but restart when validating export timing so the measured code version is unambiguous.

## Code style

- Use ES modules, TypeScript, async/await, and the existing `@/` alias.
- Biome is authoritative for formatting and linting. Run `npx biome check <changed files>`; use `--write` only for intended formatting fixes.
- Follow existing tabs, semicolons, naming, and local module boundaries.
- Prefer narrow typed helpers over duplicated IPC or export logic.
- Comments should explain intent, constraints, or non-obvious platform behavior, not restate the code.
- Do not leave dead code, commented-out alternatives, compatibility branches, or unused fallback implementations behind.
