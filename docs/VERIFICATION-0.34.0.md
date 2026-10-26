# 0.34.0 发行验收

日期：2026-10-27，Windows x64。

- [正式 Release](https://github.com/MaidTendouAris/Muxivra/releases/tag/v0.34.0) 已公开并设为最新版本。
- [GitHub Actions 发行工作流](https://github.com/MaidTendouAris/Muxivra/actions/runs/40368314177) 构建、完整验收及发布全部成功。
- 标签源码：`236a6af34451e39c43708d1db440afaa51e7e4b7`。
- 附件为安装 EXE、便携 ZIP 及自动更新清单 `latest.yml`。功能说明由标签内的 `docs/RELEASE-0.34.0.md` 自动加入 Release。

## 构建与功能

本地 0.34.0 通过类型检查、三端构建、包内容与许可证检查、ZIP 逐文件比对、更新清单校验及安装器文件保留检查。打包后的项目生命周期测试覆盖已有工程字幕导入、SRT 转 ASS、取消/失败保护、旧字幕保留和工程切换。真实 GPU 的打包播放器测试确认原生视频像素、共享纹理、透明遮罩、DOM 滚动裁剪及完整播放控制正常，未出现应用错误；使用独立测试配置。

云端发行门禁还执行完整单元/集成测试、原生 ASR 适配器检查和打包界面回归。托管 Windows 的界面测试显式使用纹理接收端夹具和 libmpv null 音频输出；真实 GPU 合成依据上述本机检查。复杂动画素材的逐事件保存、21 个字体及 OP/ED 预览证据见[复杂 ASS 实测](COMPLEX-ASS-AUDIT-2026-10-27.md)。

## 公开文件与更新源

公开附件的 GitHub SHA-256 与本次工作流 `release-contents.json` 一致。实际从公开地址下载了 153,091,964 字节的安装程序，其 SHA-256 和更新清单中的 SHA-512 均匹配。公开 `latest.yml` 指向 0.34.0 安装 EXE，发布订阅源已包含 `v0.34.0`。

| 附件 | SHA-256 |
| --- | --- |
| Muxivra-0.34.0-win-x64-setup.exe | `0235e67dd72b3f13be76e451e6def4cf8e30a50f3b80a792683cfc262decbd0e` |
| Muxivra-0.34.0-win-x64-portable.zip | `eadf6a5ec0a886224aefcb6905c2bfc0d379b8ed4b520d65e8d5de05e79c3db7` |
| latest.yml | `08898392f4af4b6dfb1dd94c0a6dcd46ae758fc8ee883fcae809232ef113aa8b` |

本次更新源验收范围为发布可见性、清单与真实下载校验。安装升级链路的既有实测记录见[0.33.0 更新验收](UPDATE-VERIFICATION-0.33.0.md)。
