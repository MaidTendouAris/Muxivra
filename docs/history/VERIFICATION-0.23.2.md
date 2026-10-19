# 0.23.2 验收记录

日期：2026-10-17，Windows x64。此前的系统网络修正见 [0.23.1](VERIFICATION-0.23.1.md)，显存修正见 [0.23.0](VERIFICATION-0.23.0.md)。

## 用户设备的诊断与结论

新设备提供的五项报告中，GitHub uv 下载地址和 Hugging Face API 返回 ERR_CONNECTION_REFUSED，GitHub codeload、PyPI 与 PyTorch 入口返回 HTTP 200。说明并非整机断网，也不能仅凭同一局域网推断两台机器的代理、DNS、安全软件设置相同。原报告没有重定向链，不能区分 GitHub 入口和 Release CDN 哪一跳失败；没有证据确定具体阻断原因。

本版增加经核实的官方备用渠道，并增加逐跳诊断。它不会修改用户系统代理、防火墙、DNS 或 hosts，也不会禁用 TLS 或自动启用第三方镜像。

## 变更

- uv 0.13.1 的 GitHub 下载遇到连接错误后，改用同一发布者在官方 PyPI 发布的 Windows x64 wheel，按固定 15,404,994 字节及 SHA-256 校验后直接提取 uv.exe。无须用户预先安装 Python。大小/哈希/证书错误和取消不触发换源；两个入口都失败时保留两处错误。
- Python 使用 uv 0.13.1 自带的 Astral 下载地址。Python 安装步骤改按该真实地址解析系统代理，避免按 github.com 的 PAC 规则错误推断其他域名的路由。
- Qwen 0.6B、1.7B 及 ForcedAligner 0.6B 的 Hugging Face 清单连接失败时，使用随应用携带的固定文件清单，从 Qwen 官方 ModelScope 固定提交下载；单文件建立连接失败也可尝试对应官方备用文件。配置与权重仍通过原固定版本的大小/哈希校验后才发布模型目录。
- 清单维护脚本逐项核对两个官方渠道：权重 SHA-256 对照官方元数据，小型配置和分词器从 ModelScope 实际下载并校验原 Hugging Face Git blob SHA-1。不是从可变 master 下载权重。模型目录保存下载来源记录。
- 网络检查扩展为八项，增加官方 PyPI 工具、Astral Python 以及 Qwen 官方 ModelScope。真实 Electron HEAD 请求记录每次重定向、HTTP 状态、Windows 代理规则及有时限的 DNS 查询结果；签名查询和 URL 凭据脱敏。界面详情与复制报告包含这些数据。
- 大型文件继续写到安装目录 asr；Chromium 专用会话无磁盘下载缓存，Python、虚拟环境、uv 缓存和临时文件均隔离到同一安装磁盘。

## 验证

- 构建、类型检查和 27 个单元文件通过，共 194 项。新增检查覆盖备用模型清单、固定 ModelScope 文件地址、损坏文件清理、MOSS 不错误换源、证书/取消/错误版本不换源、工具哈希失败不换源、来源记录及失败重定向定位。
- 完整集成 45 项通过、4 项按配置跳过。首次联合运行有一个模拟 ASR 子进程进度等待超时；暂停/取消两项单独复查均通过，随后完整复跑通过，未放宽断言或修改相关产品逻辑。
- 真实 Electron 空目录测试主动拒绝 GitHub uv 地址及所有 Hugging Face 请求，实际从官方 PyPI 下载并校验 uv，实际安装 Python 3.12.13、建立独立环境，并从 PyPI 安装 packaging==25.0 后执行成功。所有安装路径位于 D 盘测试应用目录。
- 在同一次空目录测试中，实际从 Qwen 官方 ModelScope 下载完整 0.6B 模型及其配置和分词器，共 1,880,560,703 字节，逐文件通过固定哈希并提交模型目录。不是从旧模型缓存复制，也没有用虚构权重验证成功。
- 真正请求 GitHub uv 地址，记录 302 到 release-assets.githubusercontent.com，再到 200；签名查询参数从报告中去除。证明逐跳诊断能区分原入口和最终下载目标。此处是当前开发设备的结果，不代表另一台设备已恢复连接。
- UI 故障测试使用独立测试代理，使八项 HEAD 请求失败，报告均包含失败地址和系统代理信息。真实点击 Qwen 一键部署后两个工具入口失败，完整日志保留两处原因和 runtime 阶段，未登记错误的环境或模型。
- 报告：artifacts/qa/asr-official-fallback-smoke.json、artifacts/qa/asr-network-smoke.json。测试脚本：npm run smoke:asr-fallback、npm run smoke:asr-network。

## 范围

MOSS、Whisper 权重仍使用其原官方 Hugging Face 渠道。MOSS 暂无已核实的官方备用权重仓库，不能声称其在 Hugging Face 被拒绝的设备上也可自动完成部署。已有本地模型导入功能保留。

本轮验证的是备用源、冷启动安装工具/Python、完整 Qwen 下载与诊断；没有在用户的新设备执行完整 CUDA 依赖部署，也没有重新做模型识别质量评估。Qwen 与 MOSS 的 CUDA 依赖版本、推理逻辑和整段模式不变。

## 本地发行

版本 0.23.2，输出目录 release/final-0.23.2。提供安装包、源码归档、blockmap、latest.yml 与 SHA256SUMS.txt；不发布 GitHub Release。最终打包检查包含备用源清单、诊断 IPC、许可、mpv、原生模块、版本及安装包更新清单校验。

打包应用的代理下载、八项网络诊断、Qwen 部署双入口失败详情及日志复制均通过；报告为 artifacts/qa/packaged-asr-network-smoke.json。包内容与更新清单 SHA-512/blockmap 检查通过。该次打包 UI 测试不重复下载模型；完整官方备用权重下载由前述冷启动测试覆盖。

使用方法和官方依据见 [ASR 官方下载与网络诊断](../asr/DOWNLOADS.md)。
