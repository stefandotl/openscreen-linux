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
- **Export pipeline**: `StreamingVideoDecoder` decodes source frames, `FrameRenderer` composites PixiJS and Canvas effects, and Linux MP4 export converts the final canvas to packed I420 before sending it through a dedicated `MessagePort` to FFmpeg using `h264_nvenc`. The normal MP4 export rate is 30 fps.
- **GIF pipeline** is separate and has explicit 15/20/25/30 fps settings.
- **Linux recording** uses Electron/Chromium capture. The native Linux helper records cursor position and click timing; build it with `npm run build:native:linux-cursor`.
- **Captions** run locally using `@xenova/transformers`, ONNX Runtime Web, workers, and files under `src/lib/captioning/`.
- **Generated output** is written to `dist/` and `dist-electron/`. Never edit generated bundles such as `dist-electron/main.js` directly.

## Critical conventions

- **Fail fast and loud. No silent fallbacks for core behavior.** Do not add automatic codec downgrades, alternate export pipelines, empty return values, or `catch-and-continue` behavior that hides a required-path failure. When NVENC, the transferable frame port, media validation, or another required capability fails, stop and expose a precise error in logs and UI.
- **Linux Mint + X11 + NVIDIA RTX 4060 Ti is the primary performance target for current export work.** Make this path correct and fast first. Do not weaken it to preserve speculative or unverified behavior on other platforms unless explicitly requested.
- **Measure before optimizing.** For export performance, separate decode wait, frame rendering, Canvas readback, renderer-to-main transfer, FFmpeg pipe write, and NVENC utilization. Do not infer the bottleneck from total export time or GPU percentage alone.
- **NVENC means NVENC.** On the required Linux native path, OpenH264 or another software encoder is an error, not an acceptable fallback.
- **Avoid large payloads through `ipcRenderer.invoke`.** Raw video frames use the dedicated transferable `MessagePort`; ordinary request/response IPC remains appropriate for small control messages.
- **Do not put frame `ArrayBuffer`s in the `MessagePort` transfer list.** Electron can transfer the port to `MessagePortMain`, but transferring buffer ownership across that boundary stalls the frame message. Send the buffer as structured message data and verify receipt with the frame acknowledgement.
- **Preserve renderer/main/preload contracts.** Any bridge change must update the preload implementation, global TypeScript declarations, handler registration, cleanup behavior, and focused tests together.
- **Treat media paths as untrusted input.** Normalize and validate paths in the main process before filesystem or FFmpeg access. Do not move privileged filesystem or process access into the renderer.
- **Keep edits scoped.** Preserve unrelated work in a dirty tree and do not rewrite generated files or broad areas merely to support a narrow fix.
- **Desktop behavior needs a real desktop check.** Automated checks can validate types, tests, and builds; the user must verify capture, global shortcuts, dialogs, GPU activity, playback, and exports in the Electron app before release.

## Export performance workflow

1. Reproduce using `npm run dev` with the same project, output resolution, effects, trim regions, speed regions, and frame rate.
2. Capture renderer `[native-nvenc-perf]` logs and main-process `[native-nvenc-main-perf]` logs.
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
