# 0.21.0 验收记录

日期：2026-10-16。Windows x64、RTX 3060 Laptop 6 GB、NVIDIA 616.56。本版新增 NVIDIA 一键 ASR 部署，运行工具、Python、依赖、模型和缓存全部置于应用安装目录；Qwen/MOSS 隔离，手动配置作为兼容入口。MiMo 支持暂时移除。此前字幕与 Media 互通验收见 [0.20.0](history/VERIFICATION-0.20.0.md)。

## 实际安装与存储

- 从官方渠道真实下载并校验 uv 0.13.1，由其安装独立 CPython 3.12.13；创建两个全新虚拟环境，未使用或升级既有系统 Python。
- Qwen：PyTorch/torchaudio 2.8.0+cu126、qwen-asr 0.0.6、Transformers 4.57.6、accelerate 1.12.0。
- MOSS：固定官方源码 e3bdd93f8ad58418e04659818efd5fd87a0bc486、PyTorch/torchaudio 2.8.0+cu126、Transformers 5.19.0、accelerate 1.15.0。
- 两个环境分别完成依赖一致性检查、适配器检查、实际 CUDA FP16 矩阵运算。报告为 artifacts/qa/asr-deployment-real-validation.json。
- 测试安装根目录为 D:/github/Muxivra/.runtime/asr-deployment-validation/installation/asr。Python、虚拟环境、uv、pip/HF/Torch/Numba/CUDA 缓存与临时目录均指向该位置。软件不修改全局环境变量、PATH、驱动或系统 CUDA。
- 单元验证继承的 Python 路径与安装源被忽略、依赖采用复制、容量检查、下载包哈希失败不发布、损坏缓存修复、失败保留已完成环境并重用、取消后的记录可编辑。MiMo 旧配置归入 disabled，原模型文件与配置内容保留。

## 桌面部署与实际识别

- 实际检测 GPU 型号、6 GB 总显存、UUID、驱动和计算能力。一键部署为默认入口，手动配置折叠；1440×900 浅色和 1040×720 深色无横向溢出。
- 从按钮启动部署，取消真实 Python 检查并重试成功；三个模型均绑定到所选 GPU。部署日志可复制，状态和取消反馈可见，失败不声明就绪。
- 复用此前已完整下载的官方权重，在测试安装目录内复制并校验后进行桌面验证；没有为本次测试重复下载数 GiB 模型。官方四个固定版本文件清单与 config.json 哈希另行通过真实网络验证。
- 使用用户指定 TED 视频的前 15 秒，应用提取音频后整段提交一次，运行刚安装的环境。Qwen＋ForcedAligner 生成 2 条带时间条目，MOSS 生成 3 条，Whisper large-v3 生成 5 条；全部任务完成且保留原生结果。耗时分别约 64、47、13 秒，包含首次模型加载，不能作为性能基准。
- 用户测试视频 SHA-256 仍为 666b7f9c1cfe8304bab8348c6d280032238a7c159d371bec78edd0c1c170a9cd。
- 报告为 artifacts/qa/asr-deployment-smoke.json。模型导入/下载、Python 检测、选择、提示词、绑定、取消、校验失败及原件保留的手动兼容回归也通过，报告为 asr-assets-smoke.json。

## 自动检查与发布产物

类型检查、main/preload/renderer 构建通过。25 个单元文件、178 项通过；集成 43 项通过、4 项默认跳过；Python 适配器 8 项通过。跳过项不计入通过。

安装包位于 release/final-0.21.0，内容检查确认一键部署 IPC 和存储逻辑已打包，MiMo 加载器已移除，安装包未包含 Python、PyTorch、ASR 权重或用户测试视频。应用/第三方许可证、mpv 校验、原生模块及更新清单 SHA-512/blockmap 检查通过。打包后的部署界面检查结果另存 packaged-asr-deployment-smoke.json；该复测显式跳过重复识别，不将其计为第二次推理验证。

## 范围与限制

实际设备只有上述 RTX 3060 Laptop。Blackwell 的 cu128 分支、其他 GPU/驱动组合、Qwen 1.7B 真实推理、vLLM 和 FlashAttention 未实机验证。Whisper 的固定 CUDA 12.4 原生包会执行真实 GPU 检查，检查失败保留错误并提供兼容入口。

一键部署不代表任意显存都能运行任意模型或长音频。大权重首次下载不支持断点续传，取消保留完整资源并清理本次未完成环境。MOSS 既有全片语言偏差与 6 GB 显存限制仍保留，本次短片正常不能视为长音频准确度保证。识别精度、模型内部的音频窗口及生成限制由上游模型决定。

本轮未发布 GitHub Release，也未修改用户系统环境。完整配置、官方来源及存储说明见 [ASR 部署](asr/SETUP.md)。
