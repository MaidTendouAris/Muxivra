# 开发与维护

Node.js 22.12+，使用 `package-lock.json` 复现依赖。npm 11 推荐；本机 npm 10 在较新可选 peer dependency 图中出现过解析崩溃，不应使用 `--force` 跳过兼容检查。

## 安装依赖与运行

在 Windows x64 上，从项目根目录执行：

```powershell
npm ci
npm run prepare:mpv
npm run dev
```

构建后运行或生成安装包：

```powershell
npm run build
npm start
npm run package:win
```

`npm start` 运行本地构建。NSIS 安装包输出到 `release/`；源码归档与第三方许可说明见 [发行文档](DISTRIBUTION.md)。转码需要外部 FFmpeg/ffprobe，应用中的选择或下载流程见 [使用指南](USAGE.md)。

## 检查与维护

```powershell
npm test
npm run test:integration
npm run smoke:desktop
npm run smoke:player
npm run smoke:parameters
npm run smoke:ui
npm run smoke:mcp-setup
```

集成及桌面测试需要可调用的外部 FFmpeg，用于生成临时媒体。报告与截图保存到 `artifacts/qa/`，配置和数据在 `.test-data/` 中隔离。实际验收结果、安装版验证和下载测试开关见 [验收记录](VERIFICATION.md)。

`npm run prepare:mpv` 按固定清单下载与校验 Windows x64 播放器，只有 mpv.exe 被解压，原始许可证存放于独立目录并随包提供。下载文件缓存于 `.runtime/`，运行文件位于忽略目录 `resources/mpv/`。不使用 PATH 中的 mpv，也不运行上游安装或更新脚本。

`npm run dev` 准备播放器后启动 electron-vite；`npm run build` 包含类型检查和三端构建。`npm run package:win` 准备播放器并生成 Windows x64 NSIS 安装包及依赖许可清单。`scripts/icons.mjs` 可重新生成应用 PNG/ICO。

测试集中于参数/路径边界、字幕往返、真实转码、取消、恢复、MCP 及播放器异步消息。`npm run smoke:desktop` 在隔离配置中验证四个页面、转码、字幕编辑及 MCP/托盘。`npm run smoke:player` 验证播放器全部动作、原生键盘、无外部引擎播放和实际视频像素，短暂置顶自己的测试窗口以截图，随后恢复。普通 Chromium 页面截图无法捕获原生视频区域。设置 `MUXIVRA_EXECUTABLE` 可以测试打包或已安装 EXE。

`npm run smoke:mcp-setup` 验证保存并复制完整提示词、凭据预览隐藏、保存失败不更新剪贴板、实际 MCP 连接、6 份指南、音频示例计划和当前引擎参数查询。设置 `MUXIVRA_CODEX_PATH` 为本机 Codex CLI 路径时，还会在独立 `CODEX_HOME` 中验证连接配置命令，保留其他服务器配置；不会修改用户的 Codex 配置或持久环境变量。

`scripts/install-smoke.ps1` 检查已有安装与运行进程，在项目 `.test-data` 内临时安装当前版本 NSIS 包，运行桌面、播放器、参数/预设、界面/退出、MCP 接入五组验证，再卸载；发现已有安装或正式运行进程时停止。`scripts/source-archive.ps1` 生成应用源码包，排除播放器二进制、依赖缓存和用户数据，保留准备脚本、清单和许可。

内置指南位于 `resources/mcp-skills/<id>/SKILL.md`，由 `src/mcp/skills.ts` 导入并随安装包保留。调整请求字段、任务状态或引擎支持范围时，同步更新对应指南；参数参考直接来自共享定义。新增指南需要更新固定目录、连接入口和读取测试，不能将任意本机文件路径作为指南 ID。

环境变量仅用于开发/测试：

| 变量 | 作用 |
| --- | --- |
| `MUXIVRA_DATA_PATH` | 隔离的配置、任务与会话目录 |
| `MUXIVRA_ENGINE_PATH` | 独立引擎测试目录 |
| `MUXIVRA_SMOKE=1` | 自动测试退出时不弹出交互确认 |
| `MUXIVRA_EXECUTABLE` | 桌面验证所启动的 EXE |
| `MUXIVRA_CODEX_PATH` | MCP 接入测试中用于隔离配置验证的 Codex CLI 路径 |

新增引擎版本时，从发布方核对固定下载 URL、SHA-256、版本、架构、许可证与源码地址；更新固定清单后跑真实处理与下载验证，再发布。不要改用未固定的 latest 下载，也不要打包 `--enable-nonfree` 构建。

本地配置中的 MCP token 属于连接凭据，不应加入版本库、截图或源码包。测试数据、下载缓存、构建产物均不包含在源码归档中。

公开发布前补充签名、发布者元数据、发行说明、名称检查、硬件兼容矩阵，并核对 mpv 静态依赖的完整对应源码。上游提供的固定播放器包缺少完整的逐依赖版本清单；应用源码包不代表完整播放器源码，具体记录见 `resources/mpv-licenses/SOURCES.md`。不要把未经验证的平台写成已支持。
