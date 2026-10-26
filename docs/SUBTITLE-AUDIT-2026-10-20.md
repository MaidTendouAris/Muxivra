# 字幕编辑与 Aegisub 功能对照检查

> 本文为 0.25.0 的历史基线；后续八项补齐和验证见 [0.26.0 实施记录](SUBTITLE-IMPLEMENTATION.md)。

日期：2026-10-20。检查对象：Muxivra **0.25.0**，源码基线 `4915b5d`，Windows x64 打包版。参考用户指定的 [TypesettingTools/Aegisub](https://github.com/TypesettingTools/Aegisub) 官方源码和官方文档。

本次不检查 Lua/MoonScript 插件兼容，不将 ASR、外部 AI 或 MCP 的能力计为 Aegisub 原生功能的完成度。“已完成”只指表中明确列出的基础功能，不代表整个模块已经与 Aegisub 等价。没有按按钮数量计算完成百分比。

结论：已经具备 ASS 工程保护、常规字幕校改、基础样式、多语言字幕文件及视频导出的完整常用路径。主要缺口集中在专业音频打轴、帧/关键帧工作流、批量编辑细节和可视化排版。

## 已具备的对应基础功能

| 功能点 | 当前可以完成的操作 | 边界 |
| --- | --- | --- |
| ASS/SSA/SRT 文档 | 导入、编辑和导出；内部统一 ASS；保留常用脚本信息、样式、事件、注释和未知字段/章节 | 不是任意格式、编码或 ASS 扩展的全兼容承诺 |
| 字幕事件 | 编辑开始、结束、时长、正文、对话/注释、层、样式、角色、边距、Effect | 属性编辑目前作用于焦点条目，见后文多选限制 |
| 基础条目管理 | 新增、多选、复制、粘贴、批量删除、拆分和合并 | 拆分/合并只有部分模式；不是 Aegisub 的完整编辑菜单 |
| 批量时间偏移 | 全部、所选、当前及之后；同时偏移起止或只改一个边界 | 单位是整数毫秒，没有帧单位偏移 |
| 基础查找替换 | 文本搜索、区分大小写、全部/所选范围替换，显示替换数量 | 普通文字匹配，不是正则和多字段搜索 |
| 撤销与重做 | 编辑操作撤销/重做；合并连续输入；当前打开期间各 ASS 文件分别保留历史 | 约 100 份内存快照，不跨重启保留历史，也没有操作历史面板 |
| 文档内样式 | 新增、复制、重命名、删除样式；字体、字号、粗斜体、下划线、删除线、四组颜色及透明度、描边/阴影、对齐、边距、缩放、字距和旋转 | 字体按名称填写，尚无全局样式库或字体检查 |
| 脚本设置 | 标题、作者、脚本尺寸、换行方式、描边阴影缩放、色彩矩阵标记 | 改尺寸或矩阵字段不等于执行坐标重采样或视频色彩转换 |
| 常用局部格式 | 选区粗体、斜体、下划线、删除线、文字主颜色、字号、清除格式；插入换行/样式重置；顶部/中部/底部居中 | 不是完整 ASS 标签编辑器；其余标签仍需手写 |
| 媒体与字幕预览 | mpv 视频/音频播放、跳转、前后逐帧、倍速、音量、轨道、延迟、A–B 循环、截图；工程 ASS 更新预览 | 没有视频画面上的字幕编辑手柄 |
| 波形基础 | 48 kHz PCM 按视窗解码，显示跨声道正负峰值/RMS；默认 15 秒、横纵缩放、相邻视窗、点击定位、当前字幕区间和跟随播放 | 波形不是频谱；起止标记只能看，不能拖 |
| 平滑播放指示 | 显示时钟以动画帧补间进度，暂停、跳转、倍速时校正 | 补间只用于显示，编辑时间仍取播放器真实时间 |
| 播放跟随条目 | 可选自动选中当前显示字幕；跨页定位；编辑时暂缓跟随 | 与选区试听、提交后自动下一条是不同功能 |
| 快捷键 | 可配置播放/定位/逐帧、Q/E 设置起止和撤销重做，支持原生 mpv 区域分派 | 尚未覆盖 Aegisub 的完整编辑和打轴命令集合 |
| 自动保存与恢复 | 手动保存、60 秒自动保存、约 800 ms 恢复缓存、保留最近 20 份备份、原子保存和外部修改保护 | 没有可视化备份浏览、比较和还原管理器 |
| 字幕全文核查 | 二级页连续显示当前 ASS 文件全部条目，可搜索、显示标签和隐藏/包含注释 | 是文本/时间核查，不是全部字幕的排版渲染预览，也不是多语言并排对照 |
| 格式降级 | 以 ASS 为源，另行导出 SRT/SSA，并提示对应格式的损失 | ASS/SSA 文件时间量化为 10 ms；恢复缓存保留整数毫秒。SRT 导出按当前设计丢弃 ASS 局部排版/样式 |

Aegisub 对照依据：[条目编辑](https://aegisub.org/docs/latest/editing_subtitles/)、[样式](https://aegisub.org/docs/latest/styles/)、[时间偏移](https://aegisub.org/docs/latest/shift_times/)、[ASS 标签](https://aegisub.org/docs/latest/ass_tags/)。

## 已有基础、但仍不等价的部分

| 模块 | 当前缺口 | 实际影响 |
| --- | --- | --- |
| 多选后的统一编辑 | 文本、样式、角色、层、边距及 Q/E 起止操作仍只修改焦点条目；只有删除、复制、合并、偏移、范围替换等明确的批操作覆盖多选 | 选中多条不代表右侧属性修改会批量应用 |
| 表格操作 | 无按时间/样式/角色等排序、上移下移、交换条目、可配置列及拖动调整面板 | 大项目整理和对照效率仍低于 Aegisub；目前为每页 50 条，并非全表虚拟滚动 |
| 条目插入/剪贴板 | 新增为焦点之后、按当前播放时间创建；无完整的前/后插入模式、剪切和 Paste Over；复制条目为 Muxivra 自有 JSON 标记 | 不能作为 Aegisub ASS 文本行剪贴板的直接兼容实现 |
| 拆分/合并 | 拆分带覆盖标签的条目会被禁用；没有保留原时间、按字数估计、按音节等完整拆分模式；合并使用换行拼接并保留首条属性 | 有“拆分/合并”按钮仍不等于完整的字幕重组、保留首条文本、连续时间等能力 |
| 搜索与条件选择 | 无正则、逐个查找/替换、搜索样式/角色/Effect、跳过注释或 ASS 标签；无按条件组合选行、反选/交并差等选择工具 | 普通查找替换已可用，复杂批处理仍需外部处理或 MCP |
| 波形输入联动 | 波形固定取媒体第一条音轨，未跟随播放器音轨选择；最多读取 8 声道并合并峰值，没有声道选择界面 | 切换播放音轨后，看到的波形可能不是正在听的音轨 |
| 音频缓存 | 前后端各有最多 32 个波形结果的短期缓存；无持久 PCM/多级峰值缓存 | 多次缩放和重开长媒体仍可能重新解码；不能记为“无缓存”，也不能记为完整专业缓存 |
| 帧级操作 | 有 mpv 逐帧；设起止读取真实播放器毫秒并量化为 10 ms | 无当前帧编号、帧单位时间框、真实帧边界映射和关键帧标记；不能把逐帧按钮算作完整帧级打轴 |
| 样式与局部标签 | 仅当前文档样式表；局部 GUI 只覆盖少量标签 | 缺全局样式库、专用样式导入导出、Styling Assistant、标签高亮/补全，以及局部字体名称、其他三组颜色/透明度等完整控件 |
| 质检 | 检查非法时间、空文本、未知样式和按列表相邻对白的重叠，可定位问题，弹窗最多显示 200 项 | 缺 CPS 阅读速度、最长行字符数、可配置阈值和更完整的重叠分析；不能把基础校验称为完整质检 |
| 工程恢复体验 | 当前文件恢复与备份已有；历史主要在内存 | 没有备份管理/差异比较；多个字幕文件是切换，不是并列编辑 |
| 格式与编码范围 | 编辑器限 SRT/ASS/SSA；支持 UTF-8、带 BOM 的 UTF-16LE，保存 UTF-8 | 无传统编码选择/自动检测及更多格式的编辑器入口。符合此前首轮范围，不是本轮遗漏要求 |
| 参考媒体工作流 | 通过项目管理导入并复制媒体后编辑；可以导入外部字幕 | 无纯字幕无媒体工程、独立指定另一参考音频、空白视频/噪声音频等工作流。这部分也包含当前产品的有意设计取舍 |

Aegisub 对照依据：[编辑菜单与多选](https://aegisub.org/docs/latest/editing_subtitles/)、[Paste Over](https://aegisub.org/docs/latest/paste_over/)、[条件选行](https://aegisub.org/docs/latest/select_lines/)、[查找替换源码](https://github.com/TypesettingTools/Aegisub/blob/master/src/dialog_search_replace.cpp)、[CPS 列源码](https://github.com/TypesettingTools/Aegisub/blob/master/src/grid_column.cpp)、[音频与缓存](https://aegisub.org/docs/latest/audio/)、[视频与帧时间](https://aegisub.org/docs/latest/video/)。

## 尚未实现的 Aegisub 核心工具

| 工具 | 尚缺内容 | 对照 |
| --- | --- | --- |
| 专业音频打轴 | 拖动字幕起止、拖出音频选区、相邻字幕/关键帧吸附、选区/当前行播放、首尾及前后短片段试听、提交并跳转下一条、音频片段导出 | [音频打轴](https://aegisub.org/docs/latest/timing/) |
| 频谱显示 | 频谱/波形切换及对应显示调整 | [频谱与打轴](https://aegisub.org/docs/latest/timing/) |
| 关键帧与 VFR | 关键帧索引、导入/导出关键帧和 timecodes、可变帧率精确帧映射、关键帧跳转/吸附 | [视频](https://aegisub.org/docs/latest/video/) |
| 时间后处理 | Lead-in/Lead-out、相邻字幕自动衔接、按样式/选区处理、关键帧吸附 | [Timing Post-Processor](https://aegisub.org/docs/latest/timing_post-processor/) |
| 可视化排版 | 视频坐标十字、拖动定位/移动、旋转原点、Z/XY 旋转、缩放、矩形和矢量裁剪手柄 | [Visual Typesetting](https://aegisub.org/docs/latest/visual_typesetting/) |
| 分辨率重采样 | 按新画面尺寸重算字号、边距、位置、移动、裁剪等 ASS 参数 | [Resolution Resampler](https://aegisub.org/docs/latest/resolution_resampler/) |
| 字体工具 | 已安装字体/缺失字形检查、字体收集、按脚本准备字体集合 | [Fonts Collector](https://aegisub.org/docs/latest/fonts_collector/) |
| 附件管理 | 字体/图片附件导入、导出、删除与检查；未知章节保留或复制容器附件不等于该工具已完成 | [Attachment Manager](https://aegisub.org/docs/latest/attachment_manager/) |
| 人工翻译/校对辅助 | 原文对照、跳过标签翻译、原文恢复/插入、拼写检查、词典/同义词及样式快速分配助手 | [Translation Assistant](https://aegisub.org/docs/latest/translation_assistant/)、[Spell Checker](https://aegisub.org/docs/latest/spell_checker/)、[Styling Assistant](https://aegisub.org/docs/latest/styling_assistant/) |
| 卡拉 OK 制作 | 音节切分、音节级时间编辑、相关文字/读音对齐与专门工作区 | [Karaoke Timing](https://aegisub.org/docs/latest/karaoke_timing_tutorial/) |
| 复杂特效创作 | 覆盖标签的专用编辑/参数辅助、矢量路径创作和复杂动画的图形操作 | [标签参考](https://aegisub.org/docs/latest/ass_tags/)、[可视化工具](https://aegisub.org/docs/latest/visual_typesetting/) |
| 高级导出处理 | 独立的字幕内置导出处理链、帧率/时间码转换等工具；不包含本次排除的插件兼容要求 | [Exporting Subtitles](https://aegisub.org/docs/latest/exporting/) |

卡拉 OK、复杂特效/矢量、字体附件和人工翻译辅助是此前明确允许后续补齐的范围；这里记录为功能缺口，不将其当作首轮交付违约。

## 不能混为一谈的能力

- 手写、原样保存并预览 ASS 覆盖标签，不能据此认定已经拥有可视化特效编辑器；本次没有逐一验证所有复杂标签的渲染结果。
- Effect 字段是事件属性，不是一个效果制作面板。
- 脚本 PlayRes 编辑不重算已有坐标；色彩矩阵字段也不是视频颜色转换操作。
- 播放器 A–B 循环没有自动绑定当前字幕/波形选区，不能算作一键行试听。
- 正文全文核查不代替视频中的字体回退、遮挡、运动和排版核查。
- MCP 可以让 AI 修改当前稿件、样式和标签，但不等同于原文对照翻译、拼写检查、波形拖动等原生工具。

## 本项目额外已有的工作流

独立项目目录、导入副本校验/默认保留源媒体、项目复制/回收站、多 ASS 文件命名管理、ASR 初稿、多模型部署、MCP 当前稿件编辑、统一任务队列，以及字幕烧录/封装和转入单文件处理，都是已经存在的应用能力。其中不少超出 Aegisub 原生编辑范围，因此单列，不用它们抵消专业打轴和排版缺口。

字幕视频导出可直接烧录 ASS 或封装字幕轨；MKV 保留 ASS 样式，MP4 文本字幕会降级。提交任务保存独立字幕快照，之后切换/删除其他 ASS 不改变已提交任务。

## 本次实际验证

- `npm test`：31 个单元测试文件、206 项通过。
- 相关真实集成：`projects.test.ts`、`subtitle-media.test.ts`、`waveform.test.ts`、`shortcuts.test.ts`，4 个文件、9 项通过；包含 FFmpeg、字幕语言快照、波形与 mpv 原生按键。
- Windows 打包版 0.25.0 界面回归：`subtitle-files-smoke.mjs`、`subtitle-audio-smoke.mjs`、`subtitle-media-smoke.mjs`、`subtitle-mcp-smoke.mjs`、`projects-smoke.mjs`，五组通过。
- 多 ASS 新建/切换/重命名/删除保护、独立撤销/重做、125 条全文核查、系统语言、多窗口尺寸布局、播放位置保留、48 kHz 波形/横纵缩放/平滑进度、跟随选中、真实 MKV 导出、MCP 当前稿件编辑和项目管理均有对应回归检查。
- 波形 GUI 旧测试仍定位改版前标题，首次回归在该定位处超时；已将测试定位更新为当前字幕文件信息区，复跑通过。这是测试维护修正，未改应用运行代码。
- 没有重跑真实 ASR 模型推理，也未对 Aegisub 每个菜单/格式变体逐项进行双程序人工对照；本报告的缺口判断结合当前界面入口和源码，并以上述测试确认已有能力。

报告保存在 `artifacts/qa/subtitle-files-smoke.json`、`subtitle-audio-smoke.json`、`subtitle-media-smoke.json`、`packaged-subtitle-mcp-smoke.json`、`projects-smoke.json`。测试使用独立工程和合成媒体，不处理用户已有项目。

## 后续开发建议

1. 先补常用编辑效率：多选属性统一应用、排序/移动、正则/条件选择、Paste Over。
2. 补成真正的音频打轴工作区：音轨联动、起止拖动、选区/单句试听、首尾试听、提交后下一条，再完善持久缓存和频谱。
3. 建设帧/关键帧与 VFR 索引，再提供帧单位偏移、时间后处理和准确吸附。
4. 建设视频坐标编辑层、分辨率重采样、样式库和字体检查。
5. 最后按实际创作需求补卡拉 OK、矢量/复杂特效、附件与人工翻译工具；本次仍不包含 Lua/MoonScript 插件兼容。

## 本地源码证据

| 范围 | 主要文件 |
| --- | --- |
| 编辑界面、多选范围、条目操作、保存及导出入口 | [`Subtitles.tsx`](../src/renderer/pages/Subtitles.tsx) |
| 基础批操作与校验 | [`subtitle-editor.ts`](../src/renderer/lib/subtitle-editor.ts) |
| 局部格式与全文核查 | [`subtitle-format.ts`](../src/renderer/lib/subtitle-format.ts)、[`SubtitleReview.tsx`](../src/renderer/components/SubtitleReview.tsx) |
| 样式与脚本参数 | [`SubtitleStyles.tsx`](../src/renderer/components/SubtitleStyles.tsx) |
| 文档与格式降级 | [`subtitles.ts`](../src/shared/subtitles.ts)、[`ass.ts`](../src/core/subtitles/ass.ts)、[`srt.ts`](../src/core/subtitles/srt.ts) |
| 工程保存、恢复及托管项目 | [`project.ts`](../src/core/subtitles/project.ts)、[`projects/index.ts`](../src/core/projects/index.ts) |
| 波形、缓存与平滑进度 | [`waveform.ts`](../src/core/media/waveform.ts)、[`AudioWaveform.tsx`](../src/renderer/components/AudioWaveform.tsx)、[`playback-clock.ts`](../src/renderer/lib/playback-clock.ts)、[`service.ts`](../src/core/service.ts) |
| 播放与 MCP | [`MpvPlayer.tsx`](../src/renderer/components/MpvPlayer.tsx)、[`subtitles.ts`](../src/core/mcp/subtitles.ts) |
