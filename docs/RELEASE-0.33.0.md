# Muxivra 0.33.0

## Resources and ASR deployment

- Separate Deployment and Network pages alongside Home, ASR and Environments.
- Check reusable model, Python, dependency and alignment resources before deployment. Download missing components, then install isolated environments from verified local resources.
- Official sources by default, with user-managed HTTPS mirrors and a copyable network report including actual endpoints, redirects, proxy and DNS diagnostics.
- MCP source changes always require explicit approval in MCP Interaction. Revision checks prevent stale requests from replacing newer user settings.

## MCP interaction

- Durable, paginated history of authenticated AI requests, including discovery, reads, edits and failures.
- Request and response details, status and duration; credential redaction and bounded summaries for large content.

## Subtitle editing

- Empty subtitle lines remain selectable and editable. Manual selection takes precedence over playback following.
- Dedicated multi-selection tools for styles, event properties, comment state and relative timing. Batch changes preserve unrelated text and timing and support atomic undo.
- Selected subtitle ranges are visible in the waveform. Boundary dragging previews locally and commits once on release.

This release also includes the previously developed changes since 0.25.0, including composited libmpv GPU rendering, source editing, expanded subtitle tools, media workflow pages and resource management. See the feature documents under `docs/` for details.

Windows x64 distribution consists of a portable ZIP and NSIS EXE. `latest.yml` is published for automatic updates. Builds are unsigned.
