# OpenRouter captions and shared settings

Open **Settings → OpenRouter settings** in the editor to add or remove the common API key. The same dialog is available from AI Cut and, after choosing OpenRouter, Auto captions. The key stays in the main process. The existing `openrouter.json` and encrypted key are reused; older files acquire caption defaults on read without replacing the saved AI Cut model. Linux systems without a secure keyring keep newly entered keys only for the current session.

AI Cut chooses its own chat model. Auto captions and AI Cut share the persisted speech engine/model selection. Local Parakeet and Whisper Tiny remain available. Cloud transcription sends source-video audio, including audio in trimmed ranges, to OpenRouter and the selected provider, and uses the user's OpenRouter credits. Trim filtering happens on the returned word timestamps.

## Shared transcript

Auto captions stores the full source transcript in the scene editor’s `sourceTranscript` alongside its engine/model, source path and duration. Caption grouping and current trims are applied to a copy; they do not discard words from the saved transcript. This allows AI Cut to reuse it after cuts change or captions are edited/deleted. It is included in project snapshots, scene save/load and standalone-project asset relocation. Replacing scene media clears its transcript; source-path and duration checks prevent borrowing another recording’s analysis. Scene splits retain the full transcript with their existing source-time trims.

AI Cut defaults to **Use existing transcript** when a complete, nonempty matching transcript exists. Otherwise it exposes the same Parakeet/Whisper Tiny/OpenRouter picker as Auto captions, with the saved choice preselected. **Create a new transcript** explicitly reruns transcription. Newly created AI Cut transcripts are stored before the model’s cut analysis so reopening the dialog does not retranscribe. Closing/changing the source aborts cloud transcription. No model switches occur automatically.

Legacy projects contain only caption annotations, not a full source transcript. They require one initial transcription with the chosen engine. Editable annotation text and adjusted display timing are not used to invent a source transcript. Truncated transcripts remain usable for partial captions but are not accepted by AI Cut; select an engine capable of processing the full recording.

## Model review, 2026-10-04

| Model | Auto captions | Evidence |
| --- | --- | --- |
| `assemblyai/universal-3-5-pro` | Selectable; word timestamps | [OpenRouter model](https://openrouter.ai/assemblyai/universal-3-5-pro) documents synchronous word timing, 16-bit WAV and a 120-second clip limit. |
| `fish-audio/transcribe-1` | Selectable; word timestamps | [OpenRouter model](https://openrouter.ai/fish-audio/transcribe-1) documents word alignment. |
| `fish-audio/transcribe-1-pro` | Selectable; word timestamps | [OpenRouter model](https://openrouter.ai/fish-audio/transcribe-1-pro) documents word alignment. |
| `openai/whisper-1` | Selectable; word timestamps | [OpenAI speech guide](https://developers.openai.com/api/docs/guides/speech-to-text) documents `verbose_json` and word granularity for Whisper. |
| `openai/gpt-transcribe` | Disabled; word timing unconfirmed | The current OpenAI speech guide directs timestamp use to Whisper; it does not document word timestamps for GPT Transcribe. This is distinct from GPT-4o Transcribe. |
| `qwen/qwen3-asr-flash-2026-02-10` | Disabled; no documented timing on this API path | [Alibaba file transcription guide](https://help.aliyun.com/en/model-studio/non-realtime-speech-recognition-user-guide) says the compatible Qwen ASR Flash API lacks timestamp fields. The separate asynchronous `qwen3-asr-flash-filetrans` endpoint supports them. |

The public OpenRouter catalog and model endpoints were fetched during implementation. Those metadata responses do not prove a successful transcription. Paid live-provider transcription and NVIDIA desktop export must be checked separately before release.

## Contract

Requests use [OpenRouter's transcription API](https://openrouter.ai/blog/tutorials/transcription-on-openrouter/) with raw base64 WAV, `response_format: "verbose_json"`, and `timestamp_granularities: ["word"]`. The main process extracts mono 16 kHz S16LE PCM through FFmpeg to a temporary file. It reads bounded 60-second core windows with two seconds of context on each side, producing at most 64 seconds per upload. Each returned word is assigned to one core by its midpoint and offset by the window's actual sample position. Files are removed on success, errors and cancellation.

The parser requires finite, ordered word times in seconds. Text without word timestamps causes an explicit error. There is no automatic model switch or synthesized timing. HTTP errors expose status and a safe explanation, not raw provider responses. The editor applies annotations only after all chunks have succeeded, using its existing history, caption layout, trims and native export machinery.

The shared `openRouter` preload API replaces settings methods previously under `aiCut`. Cloud transcription uses the existing caption request channel plus a correlated request ID, progress messages and cancellation. The main handler authorizes the active editor's main frame and requires an already approved video path. Concurrent cloud requests from the same editor are rejected. Destruction, renderer termination, navigation and renderer cancellation abort extraction and network work. Audio bytes and credentials never pass through renderer request/response IPC.

## Verification

- Unit tests cover actual FFmpeg extraction with simulated provider responses, all supported request IDs, malformed/missing timing, overlap ownership, final short chunks, trims, cancellation, settings migration and IPC authorization.
- `tests/e2e/openrouter-captions.spec.ts` exercises the real editor, shared settings, FFmpeg, main handler and preload with a simulated external provider. `tests/e2e/ai-cut.spec.ts` checks the existing AI Cut flow against shared settings.
- The native export plan test includes three cloud captions plus two overlapping annotations and checks timing and z-order. `tests/e2e/native-content-tracks.spec.ts` remains the NVIDIA output-versus-preview comparison; run with `VIDETIO_E2E_CONTENT_TRACKS=1` on the target desktop.
- For live verification, restart Electron, use a short recording containing speech, generate captions with each cloud model, inspect word timing, save/reopen the project and export MP4 on the NVIDIA target. Confirm the selected model remains selected and no provider/body/key is logged.
