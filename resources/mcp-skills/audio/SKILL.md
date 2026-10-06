---
name: muxivra-audio
description: AAC M4A、MP3、FLAC 音频转码，采样率、声道和音频滤镜。
---

# 音频转码

先 inspect_media 并复制 list_presets 返回的音频预设。AAC M4A 的内置预设 ID 为 aac：M4A 容器、AAC 编码、目标 192 kbps、关闭视频。MP3 使用 mp3 预设，FLAC 使用 flac 预设。

## AAC M4A 请求示例

以下路径仅是示例，替换为用户已授权目录；输出父目录必须存在。

```json
{
  "inputPath": "D:\\Media\\song.mp3",
  "outputPath": "D:\\Outputs\\song.m4a",
  "options": {
    "container": "m4a", "video": "none", "audio": "aac",
    "quality": 22, "speed": "medium", "audioBitrate": 192,
    "subtitles": "none", "conflict": "reject", "presetId": "aac"
  }
}
```

quality 和 speed 是结构中的通用字段，此处不控制 AAC 品质；audioBitrate 的单位是 kbps。AAC 原生编码的实际平均码率可能与目标稍有差异。默认保留采样率、声道、常见音乐元数据；音频预设不输出视频或封面轨道。

## 采样率、声道与滤镜

可在 options.advanced 中设置 sampleRate 和 channels。数字范围及允许值以 read_skill(parameters) 的 parameterReference 和当前工具 schema 为准。不需要改变采样率或声道时不填这两项。

音频滤镜位于 options.filters，每项包含 id、name、enabled、options。支持的滤镜名字来自内置 filterLibrary，并须存在于 get_engine_capabilities 的 filters 中。volume、loudnorm、highpass、lowpass、afftdn、aresample、atempo、afade 等都有本应用支持范围；滤镜的实际选项用 get_component_capabilities 的 kind = filter 查询。AAC 专用参数用 kind = audioEncoder、name = aac 查询。

复制音频 audio = copy 时不能应用音频滤镜、采样率、声道或重新编码参数。音频容器仅支持单条音轨，多音轨输入应明确 streamIndices。M4A 不是音频编码名称，必须同时选择 aac 或其他兼容编码。

## 结果核验

completed 后读取输出：M4A 容器、AAC 音轨、非零文件大小、预期声道/采样率和时长。若有本机工具，完整解码核对文件有效性。不要仅根据扩展名宣称编码成功。
