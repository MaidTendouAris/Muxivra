# ASR 官方下载与网络诊断

0.23.2 起，针对部分设备能访问 PyPI/PyTorch，却无法连接 GitHub Releases 或 Hugging Face 的情况，提供以下官方备用下载。仍使用固定版本、大小和文件哈希；下载、Python、独立环境和临时文件均保存在应用安装目录的 `asr` 中。

## 下载渠道

| 资源 | 默认渠道 | 连接失败后的备用渠道 |
| --- | --- | --- |
| uv 0.13.1 Windows x64 安装工具 | Astral GitHub Release | Astral 官方 PyPI Windows wheel，直接提取 uv.exe，无需预装 Python |
| Python 3.12.13 | uv 固定版本内置的 Astral 分发地址 `releases.astral.sh` | 保留明确失败信息；不更换系统 Python |
| Qwen3-ASR 0.6B / 1.7B、ForcedAligner 0.6B | Qwen 官方 Hugging Face 固定提交 | Qwen 官方 ModelScope 固定提交 |
| MOSS 权重、Whisper 权重 | 原官方 Hugging Face | 当前无已核实的官方备用渠道 |
| MOSS Python 源码 | OpenMOSS 官方 GitHub codeload 固定提交 | 保留原错误 |
| CUDA 与 Python 依赖 | PyTorch 官方索引、PyPI | 不自动使用第三方索引 |

切换仅针对连接错误或暂时的 HTTP 服务错误。证书、校验、清单版本、磁盘写入错误以及用户取消不会触发换源。GitHub 和官方 PyPI 都失败时，保留两个入口的错误，而不是仅显示 `fetch failed`。

PyPI wheel 的固定 SHA-256 是 `4f693cd4feb52f08f30474c4612f24be2050472609be65b9960b635f286da284`，由 PyPI 官方发布元数据核对。两种 uv 包都是 0.13.1，未改动依赖版本或运行环境隔离方式。

Qwen 备用清单位于 `src/core/asr/modelscope-manifests.json`。权重 SHA-256 与现有 Hugging Face 固定提交一致，配置和分词器按原文件大小与 Git blob SHA-1 验证。清单在构建时随应用携带，Hugging Face 入口不可访问时无需再向它取清单，也不使用可变的 `master` 下载权重。文件通过校验后才提交到模型目录，来源记录写入模型目录的 `muxivra-download-source.json`。

维护者可运行 `node scripts/verify-asr-official-sources.mjs` 重新比对两个官方渠道。该脚本只下载小型配置，核对权重的官方清单哈希；更新清单需要显式 `--write` 并审核内容。它不会声称通过元数据核对就完成了所有权重下载。

## 使用诊断

在“ASR 工作台 → 下载与管理”点击“检查下载网络”。八项检查包含原入口、uv 官方 PyPI 备用包、Astral Python 及 Qwen 官方 ModelScope。使用 HEAD，不下载大模型正文。

展开“连接路径与详情”可查看每一跳的 HTTP 状态、地址、系统代理规则和本机 DNS 查询结果。GitHub 地址返回重定向后，失败可能发生在 `release-assets.githubusercontent.com`；不能仅凭原入口地址断定 GitHub 首页不可用。签名查询参数与 URL 凭据不写入复制报告。本机 DNS 查询结果不等于代理服务器实际解析的地址。

同一局域网内，各设备仍可能使用不同的代理规则、DNS、证书或安全软件。`ERR_CONNECTION_REFUSED` 表示连接遭拒绝，单凭它不能判定是哪一项配置导致。先检查新报告实际失败的一跳及其代理；不要禁用证书检查、替换为不明镜像或盲目修改 hosts。

若原入口失败而备用入口成功，Qwen 部署可继续。MOSS 权重及 Whisper 权重仍需要可用的 Hugging Face 连接，或使用应用已有的本地模型导入功能。不要把 Qwen 的官方备用渠道理解为全部模型均已实现备用下载。

## 官方依据

- [Astral uv 安装说明：GitHub 与 PyPI 分发](https://docs.astral.sh/uv/getting-started/installation/)
- [uv 0.13.1 PyPI 发布元数据](https://pypi.org/pypi/uv/0.13.1/json)
- [Qwen3-ASR 官方说明：Hugging Face 与 ModelScope 下载](https://github.com/QwenLM/Qwen3-ASR)
- [MOSS 官方仓库及权重链接](https://github.com/OpenMOSS/MOSS-Transcribe-Diarize)
- [Electron ClientRequest 重定向事件](https://www.electronjs.org/docs/latest/api/client-request)
