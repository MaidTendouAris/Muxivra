# Bundled mpv playback runtime

Muxivra ships the unmodified Windows x64 mpv executable identified by
`resources/mpv-manifest.json`. Its executable and download archive are checked
against fixed SHA-256 hashes. No vendor installer, updater, script, configuration,
or FFmpeg/ffprobe command-line executable is shipped.

mpv includes FFmpeg libraries and other playback dependencies inside the static
binary. These libraries are separate from Muxivra's user-installed processing
engine. This build enables GPL and version-3 dependencies; it is not an LGPL-only
mpv build. Component licenses and copyright statements remain applicable.

Upstream binary and build recipes:

- https://github.com/shinchiro/mpv-winbuild-cmake/releases/tag/20260928
- https://github.com/shinchiro/mpv-winbuild-cmake/tree/05a60b3
- https://github.com/shinchiro/mpv-winbuild-cmake/actions/runs/36360543178

Versions reported by the binary and their source trees:

- mpv v0.41.0-1087-ge470f8986: https://github.com/mpv-player/mpv/tree/e470f8986e
- FFmpeg N-126918-g939c2c733: https://github.com/FFmpeg/FFmpeg/tree/939c2c733
- libplacebo v7.372.0 (v7.360.0-132-gc42968d-dirty): https://code.videolan.org/videolan/libplacebo/-/tree/c42968d

The original mpv Copyright/GPL/LGPL texts and FFmpeg license texts are preserved
in this directory. The build recipes identify additional libraries and their
upstream source repositories. The binary publisher's package does not supply
a complete per-library revision manifest; these references are not represented
as a complete reproducible source bundle. Before public binary redistribution,
obtain and provide the complete corresponding sources for this static runtime,
including its dependencies and build patches. Muxivra's application source archive
contains the application, lock file, preparation script and runtime manifest;
it does not contain the source of every statically linked mpv dependency.
