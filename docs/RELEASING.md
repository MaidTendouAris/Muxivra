# GitHub Actions 构建与发布

应用仅面向 Windows x64 分发便携 ZIP 与 NSIS 安装 EXE。两种包来自同一次构建，包含相同的应用、mpv、原生模块和许可证；不会打包本机模型、Python 环境、项目或媒体。

## 日常检查与手动构建

推送 `main` 或向 `main` 提交 PR 后，`Build and test` 自动运行。也可以在仓库 Actions 页选择该工作流并点击 **Run workflow**，无需先创建版本或 Release。

它调用 `windows-build.yml`，在干净的 `windows-2025` 环境中依次执行：

1. 核对 `package.json`、`package-lock.json` 和 `src/shared/version.ts` 版本。
2. 准备 Node 22、npm 11、Python 3.12，使用 `npm ci` 安装锁定依赖。
3. 从应用固定的官方来源下载并校验 FFmpeg，用于真实集成测试；不会将 FFmpeg 引擎打进应用包。
4. 运行 TypeScript 单元测试、无模型下载的 Python ASR 适配器测试，以及 FFmpeg、任务、MCP、项目、更新等集成测试。需要真实 GPU/大模型或个人样本的专项测试保持可选，不在普通 runner 上冒充真实模型验收。
5. 核验并准备固定 mpv，执行类型检查、三端构建、第三方许可收集，生成便携 ZIP 和安装 EXE。
6. 验证打包内容、安装包 SHA-512、便携 ZIP 每个文件与解包构建一致，以及安装/卸载保留用户文件。
7. 上传 `windows-x64-<run>-<attempt>` 和 `verification-<run>-<attempt>` 两份 Actions artifacts，保存 14 天。前者包含两个应用包与 `latest.yml`；后者保存机器可读验证报告和 SHA-256。

普通提交与 PR 不会发布正式版本，也不具有仓库写入权限。Actions 依赖固定在已核对的完整提交 SHA。

## 正式发布

先完成并提交该版本的全部改动，确保三个版本位置一致。首次发布的示例：

```powershell
git push origin main
git tag v0.25.0
git push origin v0.25.0
```

推送稳定标签 `vMAJOR.MINOR.PATCH` 后，`Publish Windows release` 会对标签重新执行完整构建与验证，构建提交必须和标签完全一致。通过后，独立的发布任务下载本次构建的不可变 artifact，在草稿 Release 中上传：

| 附件 | 用途 |
| --- | --- |
| `Muxivra-<版本>-win-x64-portable.zip` | 用户完整解压后运行 `Muxivra.exe` |
| `Muxivra-<版本>-win-x64-setup.exe` | 安装版，提供开始菜单/桌面快捷方式 |
| `latest.yml` | 自动更新所需版本、大小与 SHA-512 元数据 |

`latest.yml` 是配套元数据，不是第三种应用分发格式。当前更新客户端使用完整 EXE 下载，不发布 blockmap。GitHub 自带的 Source code 下载由平台生成，不另附源码 ZIP。报告和额外校验清单仅存放于 Actions artifacts。

全部上传并核对文件名后，工作流才将草稿转为正式最新版本。发布使用仓库提供的 `GITHUB_TOKEN`，只给独立发布任务 `contents: write`；无需配置个人访问令牌或把任何发布凭据放入应用。

## 重试与失败处理

可从 Actions 手动运行 `Publish Windows release`，输入已经推送的稳定标签；应选择 `main` 或包含当前工作流的可信 ref。工作流不允许覆盖同标签已有 Release（包括草稿），API 查询失败也不会假定不存在旧版本。

构建失败时可查看步骤日志和已有验证报告，修复后重新运行。上传失败会留下草稿，维护者检查并处理这个草稿后再重试；已公开版本应使用新的版本号修正，不移动公开标签、不覆盖已下载的更新文件。

目前应用包未代码签名；来源和第三方许可证说明见 [发行文档](DISTRIBUTION.md)。便携 ZIP 与安装版共享用户配置格式，portable 不表示全部配置都在解压目录。便携版用户可下载新 ZIP，退出应用后在原应用目录更新程序文件并保留 `projects`、`outputs` 和 `asr`；切勿删除这些用户目录。应用内自动安装更新使用 NSIS 安装版。
