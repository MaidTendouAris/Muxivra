---
name: muxivra-parameters
description: 阅读随应用代码生成的实际参数、滤镜与编码器内部参数参考，构造合法结构化 options。
---

# 参数参考

本指南的 read_skill 响应包含 parameterReference，由当前应用的共享参数定义生成。资源 muxivra://reference/parameters 返回相同参考，包含 groups、parameters、filters 和 codecParameters。这份参考是本应用支持范围，不是整套 FFmpeg 命令行选项。

## 字段位置

- options 顶层字段：container、video、audio、quality、speed、audioBitrate、maxHeight、streamIndices、subtitles、conflict、presetId，以及以下高级结构。required 字段按工具 inputSchema 填写，最稳妥的起点是 list_presets 中的完整 options。
- options.advanced：使用 parameters 列表的 key；遵守 type、min、max、integer、choices。flag 是对应 FFmpeg 参数的说明，不能把 flag 当作 advanced 的 key。
- options.filters：使用 filters 列表中的 name；每项必须含 id、name、enabled、options。options 的值为合法字符串；允许的滤镜仍需实际引擎 filters 支持。
- options.encoderOptions：每项为 scope（video/audio）、name、value，须属于当前编码器帮助提供的 AVOption。先调用 get_component_capabilities，kind 为 videoEncoder/audioEncoder/filter，name 为实际编码器或滤镜名称；它读取本机 FFmpeg 帮助，返回选项范围、默认值与枚举。应用会在计划阶段核对，不支持的专用选项需说明。
- options.codecParameters：仅支持 codecParameters 列表中的 key，适用于重新编码的 x264/x265 输出。不要把任意内部参数或 Shell 片段传入。
- options.metadata：key/value 数组；options.subtitleFile：已授权外部字幕的完整路径。

## 参数分类

输出与剪辑、解码、视频编码、质量与码率、色彩与画面、视频滤镜、音频、音频滤镜、图像输出、流与元数据、编码器专用参数。根据用户要求选相关组，无须一次填满全部参数。

省略可选项意味着保持默认行为。先 plan_transcode 校验组合，尤其是复制轨道与滤镜、硬件解码格式、裁剪尺寸、帧率分数及字幕路径。不支持的参数或不明确的用户目标应提出问题，不能静默丢弃设置或凭网上示例猜测。
