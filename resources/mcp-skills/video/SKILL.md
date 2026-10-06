---
name: muxivra-video
description: 视频转码、无损封装与硬件编码能力判断。
---

# 视频转码与封装

inspect_media 确认视频轨道、音轨、字幕和时长。list_presets 返回完整选项：h264-1080 为 H.264 MP4 / 最高 1080p / CRF 22 / AAC 192；h265 为 H.265 MP4 / CRF 26；remux 为复制轨道 MKV。

## 编码选择

- libx264、libx265 是软件编码；质量与速度根据用户目标选择。H.264/H.265 的质量值范围为 0–51。
- h264_nvenc、hevc_nvenc 等硬件编码器必须存在于当前引擎，并依赖设备和驱动。读取到 NVIDIA 型号或 FFmpeg 编码器列表不能代替实际试编码。硬件信息 missing/error 或 accelerationValidation = not-tested 时，如实保留状态。
- maxHeight 不放大原始视频。精确宽高使用 advanced.width/height；不要同时设置 maxHeight。源帧率默认保留，设置 advanced.frameRate 需有效数字或分数。
- 裁剪、旋转、调色、降噪、逐帧率等属于重新编码操作。options.video = copy 不能同时修改画面或应用滤镜。相关参数和滤镜名单从 parameters 指南读取。

## 无损封装与轨道

无需改变音视频编码时，使用 remux 预设并选择容器及 streamIndices。容器有编解码兼容性；先 plan_transcode，出现不兼容时向用户说明可改用 MKV 或重新编码。

subtitles = copy 才输出字幕；MP4/MOV 中兼容的文本字幕会转换为 mov_text，图片字幕可能不兼容。SRT 导出必须选择一条文本字幕轨道。外部字幕烧录使用 subtitleFile，路径也必须被授权；不能与内嵌烧录来源同时设置。

高级参数优先使用工具 schema 和 read_skill(parameters) 返回的实际参数定义。编码器专用选项还需实际引擎支持，plan_transcode 会校验；不要把任意 FFmpeg 命令拼到字段中。
