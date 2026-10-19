# 发行与许可证

## 仓库与本地产物

GitHub 仓库保存应用源码、锁文件、测试、构建脚本与许可证，版本以 `package.json` 为准。安装包、构建缓存、模型、环境与个人媒体不纳入 Git；打包后在本机 `release/` 中生成发行文件。

面向用户只分发两种 Windows x64 应用包：`Muxivra-<版本>-win-x64-portable.zip`（完整解压后运行 `Muxivra.exe`）和 `Muxivra-<版本>-win-x64-setup.exe`（NSIS 安装版）。不要仅复制 ZIP 中的 EXE。便携版不需要安装，但应用设置仍保存在 Windows 用户配置目录；项目、输出和 ASR 环境继续位于应用目录。请选择具有写入权限的位置。

安装包目前未签名。实际验证范围与限制见 [验收记录](VERIFICATION.md)，构建方式见 [开发文档](DEVELOPMENT.md)。

## 源码归档

```powershell
& .\scripts\source-archive.ps1
```

脚本生成 `release/Muxivra-<版本>-source.zip`，供本地源码快照使用，自动发布不上传该文件。GitHub Release 自带对应标签的源码下载。快照排除播放器二进制、依赖缓存、测试媒体和用户文件。

可用 PowerShell 检查交付文件的 SHA-256：

```powershell
Get-FileHash -Algorithm SHA256 .\release\Muxivra-0.25.0-win-x64-setup.exe
Get-FileHash -Algorithm SHA256 .\release\Muxivra-0.25.0-win-x64-portable.zip
```

## GitHub Releases 与更新

正式版本发布到 [MaidTendouAris/Muxivra Releases](https://github.com/MaidTendouAris/Muxivra/releases)。安装版默认每次启动自动检查，可在设置底部软件信息卡片关闭，手动检查继续可用；使用方法与发行文件要求见 [应用更新](updates.md)。

维护者先同步 `package.json`、锁文件和 `src/shared/version.ts` 中的版本号，再提交并推送对应 `v<版本>` 标签。日常提交、PR、手动构建和标签发布共用 Windows 构建验证工作流；完整说明见 [GitHub Actions 构建与发布](RELEASING.md)。验证通过后才会上传便携 ZIP、安装 EXE 与自动更新必需的 `latest.yml`，最后发布草稿为正式最新版本。blockmap、单独源码包、校验清单不作为 Release 附件发布；校验结果保留在 Actions 验证报告中。

```powershell
git tag v0.25.0
git push origin v0.25.0
```

工作流使用仓库提供的 `GITHUB_TOKEN`，只在发布步骤作为 `GH_TOKEN` 提供；应用安装包和更新客户端不包含发布凭据。工作流拒绝覆盖任何已有同标签 Release。上传失败时留下草稿供维护者检查，重跑前应检查并处理草稿；已公开的版本应通过新的版本号修正。

本地 `npm run package:win` 使用 `--publish=never`，会生成更新文件但不发布。手动创建 Release 时，将 [更新文件表](updates.md#release-文件要求) 中的文件一起上传，核对安装包的 SHA-512 与 `latest.yml` 一致后再发布。不要将草稿标为正式版后再补传更新元数据。

## 应用与第三方许可

Muxivra 采用 **GPL-3.0-only**，完整文本见 [LICENSE](../LICENSE)。第三方组件保留各自许可和版权声明，见 [THIRD-PARTY-NOTICES.txt](../THIRD-PARTY-NOTICES.txt)。

内置 mpv 含 FFmpeg 等播放依赖；来源、版本与校验值在 [播放器清单](../resources/mpv-manifest.json)，对应许可及源码记录在 [播放器来源说明](../resources/mpv-licenses/SOURCES.md)。Electron 所需 `ffmpeg.dll` 保留在运行时，应用媒体播放使用 mpv。转码使用外部 FFmpeg/ffprobe，安装包不捆绑这两个命令行处理引擎。

应用源码归档不包含上游静态播放器全部依赖的完整对应源码。公开发行二进制包前需补齐对应源码、依赖版本及构建补丁，并完成代码签名和硬件兼容验证；现有上游链接不代表完整的可复现播放器源码包。此限制不改变应用源码的 GPL-3.0-only 许可。
