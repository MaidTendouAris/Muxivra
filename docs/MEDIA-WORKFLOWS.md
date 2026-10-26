# Video and audio processing

The Media section contains independent **Video processing**, **Audio processing**, and **Batch processing** pages. Video and audio retain separate files, parameters and playback sessions. Editing steps does not reload the preview.

The compact dock at the top right, aligned with the page title, switches the active configuration card. It has no numeric badges and reserves no space beneath the workspace. Until a file is selected, all steps except Choose file are disabled.

| Workflow | Steps |
| --- | --- |
| Video | Choose file, Metadata, Dimensions, Filters, Encoding, Audio, Subtitles, Container, Delivery |
| Audio | Choose file, Metadata, Encoding, Lyrics, Gain, Container, Delivery |

Metadata is parsed locally by MediaInfoLib through `mediainfo.js`. The WebAssembly module is bundled and read in a background worker; no upload, external MediaInfo installation or runtime CDN is required. Track tabs show the useful technical/tag fields first; Show all raw fields reveals the complete result. Search covers all fields. FFprobe remains the source of FFmpeg stream indices used for processing.

The Lyrics card imports UTF-8 LRC/TXT or accepts pasted text. It writes a multiline `lyrics` metadata tag, preserving LRC timestamps. This is an embedded tag, not a separate subtitle stream; player support varies by container. Gain uses the engine's audio filters, including volume, loudness normalization and limiting.

## Delivery and command editing

Delivery selects the output directory/name and generates the FFmpeg command from the current form. **All parameters** opens the existing full parameter editor, including dynamic encoder options. Form changes regenerate the command and invalidate any prior check.

The command text uses JSON-quoted tokens so Unicode paths, Windows backslashes, filters and multiline lyrics round-trip without a shell. Users can edit encoding, stream mapping, time range, inline filters and supported FFmpeg arguments. Check the command, then start processing. The checked arguments are stored in the queue and used for execution; a failed job's retry retains manual edits.

The configured FFmpeg executable, selected input files, managed protocol/format restrictions, progress pipe, overwrite policy, and single output destination remain protected. Change input/output paths through the corresponding cards. File-reading filters and extra file outputs are configured through the application's file controls, rather than arbitrary shell or file-operation commands. The main process enforces these restrictions.

Queue execution substitutes a temporary file in the destination directory for the final output argument. On success it commits the final file. The task detail/log records the actual executed arguments, including that temporary path. Existing output files are never overwritten.

## Workspace scrolling and ASR

Video, audio, batch, subtitle editing and ASR workspaces fill the window. Scrolling stays inside their cards. Resource management uses the same header dock for Home, ASR and Environments.

ASR draft rows use the compact subtitle table style: index, start → end on one line, text and duration. Long text truncates visually and remains available in its tooltip and exported result. Untimed/estimated annotations remain explicit. The shortened recognition history card contains the task-queue button, individual selection and select-all across finished records; batch deletion uses the existing record/artifact cleanup path. Running, queued and paused records cannot be deleted. Source media, saved project subtitles and exports are preserved.
