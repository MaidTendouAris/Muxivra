# 发行与许可证

## 仓库与本地产物

当前应用版本为 0.7.0。GitHub 仓库保存应用源码、锁文件、测试、构建脚本与许可证。安装包、构建缓存、测试产物和个人媒体不纳入 Git；打包后在本机 `release/` 中生成安装文件。

安装包目前未签名。实际验证范围与限制见 [验收记录](VERIFICATION.md)，构建方式见 [开发文档](DEVELOPMENT.md)。

## 源码归档

```powershell
& .\scripts\source-archive.ps1
```

脚本生成 `release/Muxivra-<版本>-source.zip`，包含应用源码、两份 README、docs、锁文件与构建脚本；排除播放器二进制、依赖缓存、测试数据和用户文件。

可用 PowerShell 检查交付文件的 SHA-256：

```powershell
Get-FileHash -Algorithm SHA256 .\release\Muxivra-0.7.0-win-x64-setup.exe
Get-FileHash -Algorithm SHA256 .\release\Muxivra-0.7.0-source.zip
```

## 应用与第三方许可

Muxivra 采用 **GPL-3.0-only**，完整文本见 [LICENSE](../LICENSE)。第三方组件保留各自许可和版权声明，见 [THIRD-PARTY-NOTICES.txt](../THIRD-PARTY-NOTICES.txt)。

内置 mpv 含 FFmpeg 等播放依赖；来源、版本与校验值在 [播放器清单](../resources/mpv-manifest.json)，对应许可及源码记录在 [播放器来源说明](../resources/mpv-licenses/SOURCES.md)。Electron 所需 `ffmpeg.dll` 保留在运行时，应用媒体播放使用 mpv。转码使用外部 FFmpeg/ffprobe，安装包不捆绑这两个命令行处理引擎。

应用源码归档不包含上游静态播放器全部依赖的完整对应源码。公开发行二进制包前需补齐对应源码、依赖版本及构建补丁，并完成代码签名和硬件兼容验证；现有上游链接不代表完整的可复现播放器源码包。此限制不改变应用源码的 GPL-3.0-only 许可。
