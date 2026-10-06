import type { Preset, TranscodeOptions } from '../../shared/types'
export const defaultOptions: TranscodeOptions = { container: 'mp4', video: 'libx264', audio: 'aac', quality: 22, speed: 'medium', audioBitrate: 192, subtitles: 'none', conflict: 'reject' }
export const builtInPresets: Preset[] = [
  { id: 'h264-1080', name: 'H.264 MP4', description: 'MP4 · 最高 1080p · CRF 22 · AAC 192 kbps', options: { ...defaultOptions, maxHeight: 1080 } },
  { id: 'h265', name: 'H.265 MP4', description: 'MP4 · H.265 · CRF 26 · AAC 192 kbps', options: { ...defaultOptions, video: 'libx265', quality: 26 } },
  { id: 'remux', name: '复制轨道 MKV', description: '复制视频、音频与字幕轨道，不重新编码', options: { ...defaultOptions, container: 'mkv', video: 'copy', audio: 'copy', subtitles: 'copy' } },
  { id: 'aac', name: 'AAC M4A', description: 'M4A · AAC 192k', options: { ...defaultOptions, container: 'm4a', video: 'none' } },
  { id: 'mp3', name: 'MP3', description: 'MP3 · 192k', options: { ...defaultOptions, container: 'mp3', video: 'none', audio: 'libmp3lame' } },
  { id: 'flac', name: 'FLAC', description: 'FLAC · 无损编码', options: { ...defaultOptions, container: 'flac', video: 'none', audio: 'flac' } },
  { id: 'srt', name: '字幕 SRT', description: '将一条文本字幕轨导出为 SRT，不支持图像字幕', options: { ...defaultOptions, container: 'srt', video: 'none', audio: 'none', subtitles: 'copy' } }
]
