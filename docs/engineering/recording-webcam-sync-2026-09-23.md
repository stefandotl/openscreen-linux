# Webcam sync investigation — 2026-09-23

## Observed recording and running software

- Latest project: `~/.config/videtio/recordings/Intro kompletter Kurs`.
- Recording ID `1790170671986`; both containers declare 277.223 seconds; stored webcam offset is +510 ms.
- Screen video: 10,027 packets, PTS 0–277.180 seconds, largest gap 107 ms.
- Webcam video: 6,983 packets, PTS 0–277.384 seconds, largest gap 154 ms.
- Container timestamps therefore do not show a multi-second discontinuity. They do not measure the age of the image supplied by the virtual camera.
- CameraLab reception log: 900-frame intervals took about 41, 51, 71 and 42 seconds before returning to about 30 seconds. The old live path discarded the phone PTS, so this log alone cannot distinguish source frame loss from buffered old content or determine a correction curve for the saved take.
- Actual app: `/home/seroega/.local/share/cameralab/app/desktop.py`, matching the source checkout before changes.
- Two CameraLab ffplay preview processes were simultaneously alive. `WebcamPreview.open()` and the decoder's `push()` could both enter `_spawn()`. Feeders used mutable `self.proc` and `self.queue`, allowing duplicate players and writes/cleanup to act on the wrong pipe. The new concurrency regression fails against the old implementation.

## Corrections

CameraLab (`../droid-cam-new`, also copied to the installed user app):

- Serialize preview open/close/spawn. Decoder pushes never wait on UI lifecycle work; a busy preview drops its frame.
- Each preview feeder owns its process and queue; closing a full queue still delivers its stop sentinel.
- Pass original phone PTS/flags into the webcam output. Track source clock progression and outstanding decoded frames with bounded storage. Reject timestamp regressions, unaccounted output, excessive decoder backlog, or image age growth beyond one second.
- Fail immediately when the encoded queue is full instead of repeatedly blocking phone reception for up to a second per packet.
- Preserve one decoded output per source frame using FFmpeg `fps_mode=passthrough` on both outputs. This correspondence relies on CameraLab's existing no-B-frame Android encoder configuration. See [FFmpeg documentation](https://ffmpeg.org/ffmpeg.html#Advanced-Video-options).
- Preserve the original timing failure when terminating FFmpeg causes secondary broken-pipe errors.
- Include the new timing module in Linux packaging.
- Installed-file backup: `~/.local/share/cameralab/backups/2026-09-23-webcam-sync`.

Videtio:

- Detect a full second without a source frame callback during recording; the stable canvas repeating its last frame no longer hides this condition from the stop callback.
- Run recording-lag notifications only while recording dimensions are locked, avoiding idle-preview notifications.
- Virtual-camera frames can be retimestamped upstream. The Videtio watchdog alone cannot detect old image content arriving with fresh timestamps; CameraLab must enforce freshness before that boundary.

## Validation and limits

- CameraLab: 36 unit/integration tests, including actual FFmpeg decoding through the production filter/output arguments (V4L2 output replaced by a null sink), plus Tk UI smoke under Xvfb.
- Videtio: 40 focused unit tests; 4 real Chrome browser tests, including a frozen source with a still-live canvas track; Biome; TypeScript and renderer/main/preload build; diff whitespace checks.
- The old CameraLab concurrency test fails; the fixed version passes.
- No phone/USB/V4L2 capture under concurrent workload has yet been run with these changes. The existing recording was not rewritten: its original phone timestamps were never saved, and an exact variable correction cannot be inferred from the containers alone.
- CameraLab must fully restart to load its updated installed Python files. Videtio changes are in the checkout/build, not the installed `/opt/Videtio` application; validate with this checkout's development build.
- Desktop acceptance: record a spoken count with a visible hand clap at the start and end, repeat with the original parallel workload, and check saved playback plus export. Confirm one CameraLab preview process; excessive lag should now give an explicit CameraLab error rather than continue accumulating silently.
