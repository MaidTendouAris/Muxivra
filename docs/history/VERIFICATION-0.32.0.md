# 0.32.0 验收记录

日期：2026-10-26，Windows x64，RTX 3060 Laptop / Intel 混合显卡。上一版见 [0.31.0](history/VERIFICATION-0.31.0.md)。

## 本轮变更

保留 mpv，使用 libmpv D3D11 Render API、共享 GPU 纹理和 DOM Canvas。移除 HWND 子窗口、手工滚动同步、浮层枚举和 GDI 挖洞。继续开启隔离 preload 和 sandbox，不暴露句柄或原始命令。

三张纹理池受 GPU 完成查询和 Chromium 资源释放回调约束，物理分辨率限制至 4K；渲染在专用 Worker，关闭时清空画布、释放 GPU 和文件资源。运行时固定为 mpv v0.41.0-1227-ge471496c5；CLI 仅用于开发测试，不随应用分发。

选色器改为 Canvas 实际挂载时绘制，修复 Portal 首次挂载未绘制的白色画布，并补充首次打开像素检查。

## 验证

- 单元测试：39 个文件、270 项通过；固定 mpv CLI 的命名管道与快捷键兼容集成测试通过。沙箱禁止硬链接的测试在正常 Windows 文件权限下复核通过。
- 最终打包程序 0.32.0 的 player-smoke 通过：实际 Canvas 视频像素、无原生视频子窗口、半透明网页遮罩正确合成、滚动裁剪、音量、倍速、前后逐帧、A–B 循环、多音轨、外部音轨/字幕、延迟、截图、全屏、播放列表、竖屏与旋转均正常。
- player-composition-smoke 使用 HEVC Main 10 / MKV。慢消费者下连续 16 次窗口缩放，纹理池及在途帧上限均为 3；恢复后继续显示。十次页面往返保留位置与暂停状态。四次工程关闭/重开耗时 119–274 ms；关闭后可立即重命名媒体，证明文件句柄已释放，ASS 保持完整。
- 关闭中的会话拒绝迟到的字幕预览请求，避免资源重建；关闭后在一个合并快照周期内立即打开同一工程，也会恢复已释放的播放后端。
- subtitle-fullscreen-smoke 通过：字幕页浮动设置覆盖、快速滚动、全屏脱离卡片、退出恢复比例与播放位置均正确。
- subtitle-color-smoke 10 组通过，首次打开且未改变色相时画布已经完成绘制；本地拖动不写字幕、单次应用、撤销、屏幕取色取消、四种样式颜色及明暗主题正常。
- waveform-shortcuts-smoke 6 组通过；Canvas 获得焦点时快捷键仍在 Chromium 内执行。通用 ui-smoke 通过，包括菜单滚轮/滑条、设置离页确认、异步反馈及托盘退出确认。
- package-check / verify-release 通过：DLL 哈希与固定清单一致，渲染 Worker 和隔离 preload 完整，未分发 mpv.exe；158 个便携文件与解包目录一致。

## 发行包

- 安装版：release/Muxivra-0.32.0-win-x64-setup.exe，153,076,777 字节，SHA-256 a1b4ac9e42598b652c9ade9ededced79ccbc651191eeef9c562c0524290c45ca。
- 便携版：release/Muxivra-0.32.0-win-x64-portable.zip，209,345,010 字节，SHA-256 af9b1e837ae1760c22deeea59ed4310116236388eac052e9928ccb1cd8eac7ba。

## 限制

Electron sharedTexture 与 mpv D3D11 Render API 需要固定版本和实际 GPU 回归。当前实际验证平台为上述 Windows/D3D11 设备，其他显卡厂商与无硬件 GPU 环境不记为已验证。没有回退到旧 HWND 嵌入。

当前预览纹理使用 BGRA8；HDR 直通与显示器 ICC 自动匹配未纳入本轮验证。共享纹理 API 的实验性状态见 [Electron 文档](https://www.electronjs.org/docs/latest/api/shared-texture)，mpv 渲染接口见[固定版本源码](https://github.com/mpv-player/mpv/blob/e471496c56/include/mpv/render.h)。

生产安装目录和真实用户项目未修改，未提交、推送或发布 GitHub Release。
