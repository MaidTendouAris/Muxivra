# 0.23.0 验收记录

日期：2026-10-17。Windows x64、RTX 3060 Laptop 6 GB。本版修正 MOSS 长音频的异常显存占用；此前识别进度与字幕 MCP 验收见 [0.22.0](VERIFICATION-0.22.0.md)。

## 原因与修正

- 在本机实际复现：PyTorch 2.8.0+cu126 的 Windows wheel 没有编译 Flash Attention。Transformers 的 SDPA 调用对 Qwen3 GQA 使用 enable_gqa=True，默认排除不支持不同头数的 efficient kernel，随后退回 math。长序列的注意力矩阵随 Token 数平方增长，0.9B 权重大小不能代表推理峰值。
- 通过在缺少 Flash 的 CUDA SDPA 路径中展开 KV 头，使用等价 GQA，启用融合内核并禁止悄然回退 math；补丁仅作用于独立推理工作进程，结束或异常时恢复。Qwen/MOSS 的 Transformers 路径均使用此保护。
- MOSS 音频编码默认每批一个原生特征窗口；仅改变互相独立的特征窗口的计算批次，按原顺序合并后送入完整语言上下文，不截断或重新切分识别任务。
- 按当前空闲专用显存与预留余量限制 PyTorch allocator。MOSS 估算输入及生成上限的 KV 缓存，自动模式在预算不足时使用 CPU 缓存，不改变上下文；系统内存不足时提前报错。
- 识别配置的二级页提供显存预算比例、MOSS 编码批次及 KV 缓存位置。CUDA 分配/保留/峰值和缓存选择写入日志；超预算原因直接显示在失败任务中，仍不自动开启兼容分片。
- 硬件监控继续展示系统全部进程的 GPU 占用；Python 日志中的 allocated/reserved 指本次推理的 PyTorch allocator，两者不是同一口径。未通过修改监控读数掩盖实际内存分配。

## 真实 CUDA 验证

使用隔离测试环境、已下载的官方 MOSS 权重和 tests/media 下 TED 视频，不修改用户项目、已安装 Python 环境或模型。

- 2048 Token、16 个 Query 头 / 8 个 KV 头、FP16 的实际注意力对比：原 math 路径额外峰值 713,196,032 字节（约 680 MiB）；修正后的 efficient 路径 25,165,824 字节（24 MiB）。两者结果在 FP16 容差内一致，profiler 确认修正路径没有 math attention。
- 真实 24 层 Whisper 编码器的原三窗口批次与逐窗口批次使用 FP32 对比，最大差异约 0.00055；形状、全部窗口和顺序一致。FP16 批次 GEMM 的舍入差异不要求逐位一致。
- 将测试音频重复到 1420.044 秒（23 分 40 秒），一次准备 18,755 输入 Token，保留完整上下文，48 个原生特征窗口逐批编码，自动选择 offloaded KV 缓存。
- 完整上下文预填充及后续 64 Token 解码用时约 123.5 秒，PyTorch 峰值分配 2,705,180,672 字节（约 2.52 GiB）、峰值保留 3,921,674,240 字节（约 3.65 GiB），低于本次约 4.47 GiB 的 allocator 预算。数字不包含 CUDA 驱动及其他应用，也不等于整台机器的显存总占用。
- 长测试为受控内存回归，明确在 64 Token 停止，不把截断结果作为字幕初稿。没有把它称为完整 23 分钟字幕识别、语言准确度或所有硬件峰值保证。MOSS 原生语言偏差限制继续保留。

报告：artifacts/qa/asr-memory-validation.json；脚本 scripts/asr-memory-validation.py --long，使用独立 MOSS Python 环境运行。

## 回归与产物

26 个单元文件、184 项通过；集成 45 项通过、4 项默认跳过；Python 适配器 13 项通过。包含 GPU 预算/缓存估算、系统内存不足、后端非零退出时的原始错误传递、临时音频清理及整段不自动分片的回归。

真实应用中 Qwen 0.6B＋CPU ForcedAligner 的 15 秒区间识别完成，生成 2 条，用时约 59.1 秒；MOSS 同区间生成 3 条，用时约 53.5 秒。二级配置页的显存预算、CPU KV 缓存和编码批次可编辑，按模型保存并在重启后保留；浅色和深色布局无横向溢出。报告为 asr-progress-smoke.json、asr-config-smoke.json。

安装包内容检查通过：Python 适配器与最终源码逐字节一致，新增内存保护存在；版本、原生模块、mpv、许可、更新清单 SHA-512/blockmap 正常，未捆绑模型、环境或用户媒体。已打包 EXE 再次完成真实 MOSS 15 秒识别，生成 3 条，用时约 49.0 秒；默认动态 KV 缓存，PyTorch 峰值分配 1,869,679,616 字节（约 1.74 GiB）、保留 1,948,254,208 字节（约 1.81 GiB），在本次预算内，内存诊断随原生输出保留。报告：artifacts/qa/packaged-asr-memory-smoke.json。本版安装包位于 release/final-0.23.0，未发布 GitHub Release。

使用与资源策略见 [ASR 工作台](../ASR.md) 和 [本地适配器](../asr/ADAPTERS.md)。
