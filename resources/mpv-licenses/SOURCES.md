# Bundled mpv playback runtime

Muxivra ships the unmodified Windows x64 libmpv DLL identified by
`resources/mpv-manifest.json`. Its DLL and download archive are checked
against fixed SHA-256 hashes. No vendor installer, updater, script, configuration,
or FFmpeg/ffprobe command-line executable is shipped.

The matching CLI is prepared for headless development tests only and is not shipped.

mpv includes FFmpeg libraries and other playback dependencies statically linked into
the DLL. These libraries are separate from Muxivra's user-installed processing
engine. This build enables GPL and version-3 dependencies; it is not an LGPL-only
mpv build. Component licenses and copyright statements remain applicable.

Upstream binary and build recipes:

- https://github.com/shinchiro/mpv-winbuild-cmake/releases/tag/20261021
- https://github.com/shinchiro/mpv-winbuild-cmake/actions/runs/39518569492

Versions reported by the binary and their source trees:

- mpv v0.41.0-1227-ge471496c5: https://github.com/mpv-player/mpv/tree/e471496c56
- FFmpeg N-127893-g9a861e968: https://github.com/FFmpeg/FFmpeg/tree/9a861e968
- libplacebo v7.377.0 (v7.360.0-176-g285d1cc-dirty): https://code.videolan.org/videolan/libplacebo/-/tree/285d1cc

The original mpv Copyright/GPL/LGPL texts and FFmpeg license texts are preserved
in this directory. The build recipes identify additional libraries and their
upstream source repositories. The binary publisher's package does not supply
a complete per-library revision manifest; these references are not represented
as a complete reproducible source bundle. Before public binary redistribution,
obtain and provide the complete corresponding sources for this static runtime,
including its dependencies and build patches. Muxivra's application source archive
contains the application, lock file, preparation script and runtime manifest;
it does not contain the source of every statically linked mpv dependency.
