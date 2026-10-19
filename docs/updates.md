# 应用更新

Muxivra 的 Windows x64 安装版从 [GitHub Releases](https://github.com/MaidTendouAris/Muxivra/releases) 获取正式版本。“启动时自动检查更新”默认开启，每次启动检查一次。设置页最底部“软件信息”提供版本、应用/FFmpeg/mpv 许可、仓库、问题反馈、自动检查开关和手动检查/下载/安装。开关保存后在下次启动生效，关闭自动检查后仍可手动检查。“手动更新”打开 GitHub Releases 供用户下载安装包。

发现新版本后，点击“下载更新”。下载状态显示进度、速度与大小，失败后可重试。下载时可以继续播放、编辑和处理媒体。下载完成后点击“重启并安装”，应用会先显示确认窗口，再保存字幕工程并停止播放器、MCP 服务和处理队列。确认后安装新版本并重新启动；未确认时继续使用当前版本。关闭主窗口仍然隐藏到托盘。

自动检测不会自动下载或强制重启。应用更新保留用户设置、预设、任务记录及外部 FFmpeg/ffprobe 引擎。0.13.0 起的卸载程序只移除构建时记录的应用文件，保留安装目录下的 `outputs` 和其他未随应用安装的文件；有应用文件被占用时中止操作并恢复已移动的应用文件。更新前仍应先让需要完成的处理任务结束。

## 检查失败

网络不可用、GitHub 无法访问或发行文件缺失时，设置页会显示失败原因。恢复网络后使用“检查更新”重试，也可以从正式 Release 下载 NSIS 安装包手动安装到原目录。

开发模式不进行真实更新。未包含更新功能的旧版本需要先手动安装 0.13.0 或更新版本，此后才能通过应用内更新。

0.12.0 及更早版本的卸载程序会递归删除安装目录。首次安装新版本时，如检测到已注册旧版本的 `outputs` 中有内容，安装程序会在执行旧卸载程序之前停止，并显示路径。先将该 `outputs` 文件夹和安装目录中的其他个人文件移到安装目录之外，安装后再移回。仅复制而保留原位置的非空 `outputs` 会继续触发保护；安装程序不会替你移动或删除这些文件。直接运行旧版本自己的卸载程序仍不受新版本保护。

## Release 文件要求

每个稳定版使用 `v<版本>` 标签，例如 `v0.17.0`，并在同一个 GitHub Release 中包含同一次构建生成的文件：

| 文件 | 用途 |
| --- | --- |
| `Muxivra-<版本>-win-x64-setup.exe` | Windows x64 NSIS 安装包 |
| `Muxivra-<版本>-win-x64-portable.zip` | 完整便携版，解压运行 |
| `latest.yml` | 版本、下载文件名、大小与 SHA-512 校验信息 |

当前客户端禁用了差量下载，使用完整安装包，因此无需将 `.blockmap` 上传到 Release。源码使用 GitHub 自动提供的标签归档，不另上传源码包；SHA-256 清单保存在 Actions 验证报告中。`latest.yml` 可以包含 ZIP 的校验信息，但安装版更新始终选择 EXE。

不能只上传安装包，也不能把不同构建生成的安装包与 `latest.yml` 混合。应用只读取公开的正式版本，草稿和预发行版本不会成为更新源。发布过程见 [发行文档](DISTRIBUTION.md)。

## 实现依据

更新使用 `electron-updater` 和 electron-builder 26 的 NSIS/GitHub provider。打包时将固定仓库写入 `resources/app-update.yml`，下载按 `latest.yml` 中的 SHA-512 校验；NSIS include 使用构建时编译的应用文件清单保留输出文件，而非默认的安装目录递归删除。当前安装包仍未配置代码签名，许可证及发行限制见 [发行文档](DISTRIBUTION.md)。参考 [electron-builder 26 更新文档](https://www.electron.build/v26/docs/features/auto-update/)、[发布配置](https://www.electron.build/v26/docs/publish/) 和 [NSIS include 文档](https://www.electron.build/v26/docs/nsis/)。
