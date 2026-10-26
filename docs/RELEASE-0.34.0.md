# Muxivra 0.34.0

## Import subtitles into existing projects

- Import ASS, SSA or SRT from **Projects → Project files → Subtitle files**. Each import creates and selects a separate ASS file, with automatic numbering for duplicate names. Existing project subtitles and original source files are preserved.
- SRT imports become editable ASS projects, retaining their text and timing without keeping SRT editing restrictions.
- **Find embedded subtitles** lists supported text tracks with language and title information. Import different languages as separate subtitle files, then open them directly in the subtitle editor or switch between files for export.

## Complex ASS, fonts and preview

- Preserve imported ASS events, styles, script information, override tags, vector drawings and additional sections through editing, saving and reopening.
- Extract and validate MKV font attachments into the project directory. Fonts remain local to the project and are not installed into Windows.
- Preview external editor ASS with the loaded media's embedded fonts. Empty projects display no subtitles, and preview reloads respect the selected embedded track or subtitle-off state.
- Burn subtitles using project font resources. Project MKV exports and transfers to video processing retain font attachments; switching to an incompatible container removes attachment copying automatically.

ASS preview uses libass. SRT and MP4 text-subtitle exports simplify ASS styling and effects.

## Verification

The local real-MKV audit covered separate CHS/JP and CHT/JP tracks containing **10,112 and 10,506 events**, including **5,493 and 5,887 drawing events**, 13 original styles per track and 21 font attachments. Text edits, saving and reopening preserved every other event and the original styles and script data. External SRT import added a fourth ASS file while retaining the original blank track and both imported tracks; the source video's hash and modification time remained unchanged.

Six source-versus-saved FFmpeg/libass frame comparisons matched at OP karaoke, animated drawings and ED samples. Six additional native GPU previews were visually checked. Development validation passed 296 unit tests and 96 integration tests, with 8 integration tests skipped by configuration.

Windows x64 downloads include a portable ZIP and NSIS installer. Builds are unsigned; `latest.yml` supports application updates.
