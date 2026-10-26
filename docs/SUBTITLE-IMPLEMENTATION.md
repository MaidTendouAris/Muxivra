# Subtitle editor implementation plan

This plan implements the eight gaps selected from the 2026-10-20 audit. Lua/MoonScript compatibility, karaoke authoring, vector drawing and attachment management remain outside this work.

| Priority | Delivery | Acceptance criteria | Status |
| --- | --- | --- | --- |
| P0 | Atomic multi-line editing | Text, event properties and timing apply to all selected lines; duration remains relative to each start; one undo restores the batch; mixed values are visible. | Delivered |
| P1 | Grid and search | Stable sort, selected block movement and swap; saved column/layout preferences; regex, individual/all replacement, fields, tag exclusion and conditional selection with cancellable execution. | Delivered |
| P1 | Split, join and Paste Over | Cursor/preserve-time/proportional/line-break splits preserve static ASS state; unsafe time-dependent tags are rejected explicitly; join, DVD fragment recombination, overlap expansion and selectable-field Paste Over are atomic. | Delivered |
| P2 | Audio track and durable cache | Waveform follows the actual player audio track, including disabled audio; cache validates media identity and survives restarts; obsolete work is cancelled. | Delivered |
| P2 | Video timing | Build a presentation-timestamp frame index asynchronously; show/edit frame numbers; navigate keyframes; VFR boundaries use real timestamps, never nominal FPS conversion. | Delivered |
| P3 | Styles and ASS editing | Persistent reusable style library with import/export; tag highlighting, completion and local property controls preserve existing text. | Delivered |
| P3 | Quality checks | Configurable CPS, line length/count and duration limits; chronological overlap detection; tags and drawing commands excluded from reading metrics. | Delivered |

## Delivery procedure

Each delivery adds pure operation tests, integrates with the existing document history, runs TypeScript and relevant regression suites, then receives a real Electron workflow check. Source media and existing project isolation must be preserved. The workspace remains fixed-height with independent panel scrolling. Preferences are separate from subtitle content; background analysis must show progress and cancellation.

Changes to timing, tags and multi-line operations must be transactional: compute and validate the whole result before committing it. Unsupported constructs must produce an actionable message rather than silently corrupting the script. No estimated frame timestamps are presented as exact VFR data.

## References

- [Aegisub editing behavior](https://aegisub.org/docs/latest/editing_subtitles/)
- [Paste Over](https://aegisub.org/docs/latest/paste_over/)
- [ASS override tags](https://aegisub.org/docs/latest/ass_tags/)

The dated audit is a baseline, not a live inventory. Delivery evidence and remaining limits are recorded here as implementation progresses.

## 0.26.0 交付与操作入口

开发顺序按依赖安排：P0 先统一多选命令与撤销；P1 完成表格、搜索、拆分和合并；P2 建设音轨、持久缓存及真实视频帧基础；P3 接入样式库、标签辅助与可配置质检。以上阶段已落地，保留下面明确的边界。

| 对应缺口 | 现在可以完成的操作 |
| --- | --- |
| 多选编辑 | 文本、样式、角色、层、边距、效果、注释、起止时间修改作用于全部所选条目；修改时长按各条自身起点计算；显示批量数量与混合字段；整批撤销。Q/E 和播放器原生快捷键使用同一语义。 |
| 表格整理 | “字幕工具 → 表格整理”提供上移、下移、置顶、置底、两条交换及稳定排序，可仅排序所选位置；“列与面板”保存可见列、左右宽度与预览/列表高度比例，保留列表最小空间。 |
| 查找替换 | “高级查找替换”支持普通/正则、大小写、跳过标签、文本/样式/角色/效果字段、对白/注释、时间范围、选中范围、逐项与全部替换；匹配选行支持替换、并集、交集、减去及反选。正则在独立 Worker 中运行，可取消，超时自动终止。 |
| 拆分合并 | 光标配合播放位置、保留时间、按文本长度分配时间、按换行拆分；已建帧索引时可从当前帧前/后复制拆分。支持连接文本、保留首条文本、合并相同字幕、DVD 重复片段重组、展开重叠区间。Paste Over 可选择字段，一对一或一对多，单个目标加多条剪贴板时向下覆盖。 |
| 波形联动 | 跟随 mpv 选中的音轨或关闭状态，通过 `ff-index` 映射真实流；外部音轨使用其路径。创建项目时预处理全部音轨，1ms 分箱与多级峰值/RMS 保存在项目 `analysis`，编辑时按视窗读取，不实时解码。波形支持连续跟随、拖动选区、边界微调、空格平移、右键终点及下方滑条。 |
| 帧级打轴 | 创建项目时建立索引，显示进度并可取消；起始、结束及持续帧数与时间字段整合，支持单帧微调和前后关键帧定位。读取 FFprobe 的真实显示时间戳，支持 VFR；项目缓存位于 `analysis/video-timing.json`。 |
| 样式与标签 | 样式页新增全局库，支持存入、载入、删除、ASS/SSA 导入和 ASS 导出；覆盖同名需确认，导入自动编号。库的导入不会替换项目字幕。文本区高亮 ASS 标签，输入标签或 Ctrl+Space 补全；局部面板提供字体、缩放、间距、四种颜色/透明度、描边、阴影、模糊、旋转、倾斜、定位、原点、对齐、换行及重置控件。 |
| 质检 | 可保存 CPS、最长行字符数、行数、最短/最长显示时长、空白计数及重叠检查设置；保留原有非法时间、空文本和未知样式检查；按时间排序检测包含关系和非相邻重叠；阅读指标不统计覆盖标签与矢量指令。 |

## 边界与数据安全

- 编辑器内部保留整数毫秒；ASS 文件的时间精度仍为 10ms。帧索引使用真实时间戳，不能提高 ASS 文件本身的精度。结束帧为不包含的边界，不会把结束帧当作最后显示帧。
- 帧索引最多 2,000,000 帧，单次分析上限 30 分钟；长视频首次建立索引可能较慢，随后复用缓存。索引不是关键帧近似或固定帧率推算。
- 拆分延续静态 ASS 状态，拒绝自动调整依赖原始时间的变换、移动、淡入淡出与卡拉 OK。复杂效果与矢量编辑仍在原定排除范围内，已有文本原样保留。
- DVD 片段重组针对纯文本且事件属性相同的字幕；包含标签时要求先分别整理。区间展开要求事件属性一致，拒绝动态效果，避免将不同层、角色和排版静默混合。连接模式保留首条事件属性，必要时插入样式重置以隔离后续文本。
- 跳过标签搜索不会跨过标签边界拼接文本；命中列表最多保留前 10,000 处，全部替换与条件选行仍处理整个范围。复杂正则在 2 秒后终止，可缩小范围或简化表达式。
- 样式库、质检及布局保存在应用配置目录的 `subtitle-tools.json`，不写入字幕正文。项目分析缓存为可重新生成的数据，清理仅触及缓存目录内的哈希 JSON，不触及媒体、ASS 或导出文件。
- 字幕主页面继续禁止整体滚动，列表与属性面板分别滚动；工程栏展开仍为悬浮形式。

## 验收证据

- 新增 `tests/unit/subtitle-operations.test.ts`：批量属性与相对时长、稳定移动/排序、字段覆盖、标签边界与状态延续、拆分模式、DVD 片段重组、20,000 条重复重叠记录、正则捕获/零宽匹配/条件选行、局部格式恢复及 VFR 边界。
- 新增 `tests/integration/subtitle-analysis.test.ts`：真实双音轨、VFR 显示时间戳、关键帧、分析取消、持久缓存与损坏缓存回退。
- 新增 `npm run smoke:subtitle-tools`：真实 Electron 交互、独立配置、合成媒体、重启恢复；报告 `artifacts/qa/subtitle-tools-smoke.json`。GitHub Windows 构建工作流增加打包版执行步骤。
- 原有多字幕、播放跟随与平滑波形、MCP 字幕编辑、Sub → Media 导出回归继续保留。

本次完成的是用户选定八项缺口的上述操作范围，不将插件兼容、频谱打轴、视觉排版工具、附件管理或人工翻译助手计为完成。
