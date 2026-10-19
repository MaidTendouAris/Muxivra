# 0.23.1 验收记录

日期：2026-10-17。Windows x64。本版修正首次 ASR 部署的网络兼容和诊断；显存修正保留，见 [0.23.0](VERIFICATION-0.23.0.md)。

## 问题与范围

用户在新设备看到 fetch failed，截图中的 RTX 3060 Ti、驱动 616.56 与计算能力 8.6 已通过检测。仅凭该截图不能确定失败域名、DNS/代理/证书中的具体原因。

代码确认原下载使用 Node fetch，没有使用 Electron 对 Windows 系统代理和 PAC 的支持。原错误只保留 fetch failed，初始部署工具下载失败时尚未启动命令，因此完整部署日志也可能没有失败详情。已有下载缓存的电脑可能跳过这一请求，不能用老设备可用推断新设备网络完全相同。

## 修正

- 应用里的 ASR 工具、源码、模型清单/权重、Whisper 运行包以及 FFmpeg 下载统一通过专用 Chromium 网络会话，使用系统代理配置；非持久会话且关闭 HTTP 磁盘缓存，模型正文仍只流式写到指定安装磁盘。
- 部署命令按当前入口解析系统代理，转为该 uv 子进程的 HTTP/HTTPS/ALL_PROXY；已有 HTTPS_PROXY/ALL_PROXY 保留优先级。UV_SYSTEM_CERTS=true 使用系统根证书。没有改 Windows 或用户环境变量，没有关闭 TLS 验证或切换非官方镜像。
- 短暂连接错误和部分临时 HTTP 状态最多请求三次，重试显示状态，连接阶段单次最长 30 秒，整体超时保持原下载上限；用户取消立即停止。证书错误、403/404 不无谓重试。
- 网络错误包含资源名称、原始官方地址及嵌套底层错误，区分代理、DNS、超时和证书；地址的身份凭据与签名查询参数会移除。流传输失败也补上资源上下文，磁盘和校验错误保留原信息。
- 部署失败阶段和原因写入持久日志，包含初始工具下载失败；已完成模型和环境的保留规则不变，失败临时文件仍清理。
- 部署页新增“检查下载网络”，检查 GitHub 工具/源码、PyPI、PyTorch 和 Hugging Face 五个固定入口，提供复制诊断。使用 HEAD，不拉取大模型权重；入口成功不等于 CDN、全部文件、依赖或整次部署必然成功。

复杂 PAC 分流或需认证的代理在 uv 中不完全等同于浏览器；子进程按当前下载入口得到一个代理，仍可能需要使用固定系统代理或为依赖程序设置 HTTPS_PROXY。错误会保留实际失败地址。

## 验证

- 27 个单元文件、190 项通过；集成 45 项通过、4 项默认跳过。覆盖嵌套原因、敏感 URL 脱敏、重试、证书/403 不重试、取消、代理传递、下载校验及原有工作流。
- 真实 Electron 的隔离新配置和空缓存测试：Node 不能直接访问的 .invalid 测试地址，可通过专用会话的测试代理下载，并核对固定大小和 SHA-256 后提交。
- 模拟 HTTPS CONNECT 代理故障，五个入口均正确显示失败地址和代理原因；真实界面的一键 Qwen 部署在 runtime 阶段失败，模型/环境未错误登记。复制日志包含该阶段、官方 uv URL 与底层错误，而非单独 fetch failed。
- 恢复系统网络后，从 GitHub 官方地址真正下载全新 15,308,685 字节 uv 0.13.1 压缩包，校验固定 SHA-256，再运行工具从官方 PyPI 解析 packaging==25.0。没有利用旧 uv 下载缓存，也没有安装系统 Python 或向 C 盘转存依赖。
- 报告：artifacts/qa/asr-network-smoke.json；脚本 npm run smoke:asr-network。新设备本身尚未远程复测，测试不声称已经完成它的整套多 GB 模型部署。

## 发行

0.23.1 位于 release/final-0.23.1，安装包、源码、更新清单与校验文件一起生成。打包 EXE 的代理下载、五个入口诊断、一键部署网络失败详情与复制日志均通过复测，报告为 artifacts/qa/packaged-asr-network-smoke.json。该复测不重复拉取官方工具；真实空缓存官方工具和 PyPI 访问由前述开发构建验证。安装包内容检查确认专用下载会话、系统证书配置和诊断 IPC 已包含；许可、mpv、原生模块、版本及更新清单 SHA-512/blockmap 通过。未发布 GitHub Release。

实现依据：[Electron net](https://www.electronjs.org/docs/latest/api/net)、[Session 代理](https://www.electronjs.org/docs/latest/api/session)、[uv 环境变量](https://docs.astral.sh/uv/reference/environment/)。使用说明见 [ASR](ASR.md)。
