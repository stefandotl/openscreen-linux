# Latest recording and export synchronization investigation

Date: 2026-09-23. Videtio: 3.8.1; CameraLab baseline: 0.4.6, fixed: 0.4.7.

## User report and inputs

The webcam initially looks synchronized, then appears delayed around 20 seconds,
including in the exported video. The subsequent clock test reproduced transient
capture latency and verified the CameraLab decoder improvement described below.

- Recording: `~/.config/videtio/recordings/recording-1790179686511/`
- Start: 18:08:06.511 local time; declared duration: 165.519 seconds.
- Export: `~/Downloads/test.mp4`, 136.167 seconds, 1080p.
- Saved webcam offset: +510 ms; webcam-only layout; multiple removed intervals.
- The project was edited during investigation. The playback reproduction used the
  earlier project copy; the export comparison used the later saved trim list that
  matched the export. Do not assume their trim lists are identical.

## Export comparison

Compared decoded exported webcam images with decoded source images, applying the
saved cuts and +510 ms offset. Fifteen samples between output seconds 3 and 60
matched the expected source content within approximately one 30 fps frame.

Compared short exported audio windows against the original screen recording using
normalized waveform cross-correlation, sampled every 0.5 seconds from output
seconds 2 to 60 and avoiding windows spanning cuts. All matches had correlation
above 0.8; no matched audio position differed by more than 100 ms from its expected
source position. Typical differences were -12 to -38 ms. The preliminary
unnormalized correlation produced a false match at 40 seconds; the normalized
comparison supersedes that result.

At output second 20, the expected screen source position was 23.967 seconds.
The exported image matched webcam source position approximately 24.500 seconds
(expected 24.477 including the offset), and the audio matched 23.942 seconds.
This does not support a large additional export timing jump at that position.
It does **not** establish that the source camera content is synchronized to speech.

## Editor playback reproduction

Opened a separate project copy in installed Electron 3.8.1 with an isolated profile.
Measured both media clocks and `requestVideoFrameCallback` presentation timestamps.
During automatic trim seeks the primary audio/video resumed before the webcam
finished seeking. For the 16.677–19.386 second cut, primary playback resumed about
110 ms before the webcam. Other observed cuts had roughly 15–200 ms differences.
While the webcam was seeking, its displayed image still belonged to the pre-cut
position; clocks realigned after playback resumed. This is a confirmed preview
artifact but does not explain the user's exported-video report by itself.

## Source recording and CameraLab

The source webcam packet timestamps advance continuously around the reported
position. Exact frame checksums found no long identical-image run there. A
freezedetect pass also reported low-motion stretches around source seconds 28–30,
which overlap a removed silence interval; low motion alone is not proof of a
capture freeze. Initial source frames have gaps up to 437 ms.

CameraLab logs show no recovery or stale decoded frame increase during the
18:08:02–18:08:32 interval. Existing 30-second counters do not resolve subsecond
latency variation and do not measure the complete sensor-to-recorder path.

Exploratory mouth-motion/audio-envelope correlations are not a calibrated lip-sync
measurement and must not be reported as confirmed offsets. Likewise, testing
FFmpeg `avioflags=direct` on a synthetic paced H.264 source dropped startup frames;
that option was not adopted.

## Confirmed clock-marker reproduction

The user aimed the phone at monitor 2. A temporary fullscreen window displayed a
clock, a 16-bit Gray-code frame counter, and four colored fiducials. Installed
Videtio recorded that screen, the actual virtual webcam, and the Blue Snowball
microphone in an isolated profile. Source camera settings stayed at 1920x1080,
30 Mbit/s, front camera, rotation 180 degrees.

The analyzer decoded screen and webcam at 10 samples per second, located fiducial
centroids, rectified perspective, and read the counter using local background
brightness. It matched camera image content to screen timestamps, independently
of the virtual camera's container timestamps. An earlier global brightness
threshold was unreliable and is superseded by this locally normalized analyzer.

| Clock measurement | Baseline, 90 seconds | Fixed decoder, 30 seconds |
| --- | ---: | ---: |
| Valid matched samples | 865 | 296 |
| Median image latency | 567 ms | 300 ms |
| 95th percentile | 956 ms | 360 ms |
| Maximum | 1660 ms | 650 ms |

Baseline peaks around 13.7 and 28.7 seconds coincided with CameraLab catch-up log
events. This reproduces the reported temporary delay followed by recovery.

## Root cause and CameraLab 0.4.7 change

The desktop uses `/usr/bin/ffmpeg` 6.1.1; the development shell defaults to Conda
FFmpeg 8.0.1. Tests must explicitly use the desktop binary. The decoder had been
limited to one worker and used `-flags low_delay`. Raising the thread count alone
did not help: FFmpeg's frame-thread selection excludes low-delay mode. See the
[FFmpeg 6.1 threading implementation](https://ffmpeg.org/doxygen/6.1/libavcodec_2pthread_8c_source.html).

CameraLab 0.4.7 removes that decoder flag and sets `-threads:v 2 -thread_type frame`
before the H.264 input. The rawvideo encoder remains explicitly single-threaded.
Resolution, bitrate, bounded queues, timestamp association, recovery behavior,
and genuine failure guards are preserved. Videtio's export pipeline is unchanged.

Separate live pipeline probes, each about 48 seconds including startup and stop,
recorded these stage measurements using system FFmpeg and the real phone:

| Pipeline measurement | Baseline | Fixed decoder |
| --- | ---: | ---: |
| Decoded frames | 962 | 1452 |
| Dropped packets | 491 | 0 |
| Catch-up recoveries | 18 | 0 |
| Stale decoded frames | 61 | 0 |
| Median input age | 85 ms | 83 ms |
| Median decoded age | 264 ms | 166 ms |
| Maximum decoded age | 1372 ms | 487 ms |

Stage ages are relative to the fastest packet arrival, not absolute sensor age.
New CameraLab diagnostic counters expose input age, decoded age, their maxima,
and pending decoder frames. These distinguish transport delay from decoder work.

All 39 CameraLab tests passed using system Python and FFmpeg 6.1.1, including real
FFmpeg tests with injected decoder/output stalls and packet bursts that compare
output frame hashes with the original timestamp-associated frames. Android and
Linux packages were built. Installed Linux source matches tested source; Android
reports version 0.4.7 / code 407.

## Calibration, rollout, and limits

CameraLab 0.4.7 was installed on Linux and the connected Mi A3. With the user's
explicit confirmation that the project was saved, Videtio was restarted and its
future-recording correction changed from 510 to 300 ms. The saved project and
original media were not rewritten. A constant correction cannot repair a variable
delay already embedded in an older recording.

After the user unlocked the phone, the installed desktop app restarted streaming
at 18:56:19. Its first 30-second report had 896 decoded frames, zero dropped packets,
zero recoveries, zero stale decoded frames, and a maximum relative decoded age of
221 ms. The live process arguments confirmed two frame-decoding workers and no
decoder low-delay flag. Videtio was running and its saved future offset was 300 ms.

The fixed live recording still had a brief 650 ms peak. These measurements verify
a substantial improvement, not zero jitter or a guarantee under every workload.
Background load was not controlled identically across takes. The clock measures
image latency; microphone latency and subjective lip synchronization require a
normal speaking recording. The separate brief editor seek artifact above remains
outside this CameraLab fix.

Diagnostic scripts, the copied project, and machine-readable measurements are in
`/tmp/videtio-latest-diagnosis/`. Clock recordings and the corrected analyzer are in
`/tmp/videtio-clock-test/`; stage probes and fixed clock results are in
`/tmp/videtio-camera-stage/` and `/tmp/videtio-camera-stage-parallel/`. These `/tmp`
artifacts are temporary; this document preserves the principal results.
