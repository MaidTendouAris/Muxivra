# 界面语言 / Interface languages

Muxivra 0.25.0 提供简体中文和英文界面。默认“跟随系统”，启动时读取 Windows 的首选界面语言列表，按顺序选择受支持语言；没有匹配时使用英文。中文地区及文字变体目前统一使用简体中文，不提供繁体中文语言包。

在“设置 → 外观与任务 → 界面语言”中可手动选择。语言与其他设置一样，未保存时显示变更标记；保存或离开时应用后立即切换，不需要重启应用，也不重新创建播放器。设置会保留至下次启动。“跟随系统”在下次启动重新读取系统偏好。

字幕正文、字幕文件名、项目名、自定义预设、媒体路径、模型原始输出、执行参数及完整日志保留原文。界面切换不会翻译或修改 ASS 文件。服务器内置 Markdown 指南保持原文；指南入口名称和说明随界面切换。MCP 协议字段及模型参数值保持稳定。

英文资源位于 `src/shared/locales/en.json`，中文消息作为稳定键。界面及原生文件选择框使用同一消息表；带参数的消息使用 `{0}`、`{1}` 等插槽，不对字幕文本作 DOM 替换。`tests/unit/locale.test.ts` 检查界面消息覆盖和插槽一致性。添加新界面消息时同时提供英文，并用实际窗口验证长度、换行和滚动空间。

The interface supports Simplified Chinese and English. **Follow system** is the default: Windows UI-language preferences are checked at startup, with English as the fallback. Choose a language in **Settings → Appearance and tasks → Interface language**, then save or apply when leaving. Switching the interface keeps the active media and subtitle content intact.

Project names, filenames, subtitle text, custom presets, raw model output and execution logs remain unchanged. Built-in Markdown guides retain their source language. Developers can extend `src/shared/locales/en.json`; interface keys and interpolation slots are covered by the locale tests.
