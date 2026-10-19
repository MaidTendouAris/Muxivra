# 模型精度与权重量化

0.24.0 起，在“ASR 工作台 → 配置识别参数 → 精度与量化”按模型保存精度。工作台首页显示概览。默认仍是自动：CUDA GPU 使用 FP16，CPU 使用 FP32；已有 dtype 配置保持原含义。

| 选项 | 实现 | 当前可用设备 |
| --- | --- | --- |
| FP4 | bitsandbytes 4 位浮点权重 | NVIDIA CUDA |
| NF4 | bitsandbytes 4 位归一化权重 | NVIDIA CUDA |
| FP8 | Quanto float8 权重量化 | CUDA / CPU |
| INT8 | bitsandbytes LLM.int8 | NVIDIA CUDA，计算能力至少 7.5 |
| FP16 | PyTorch float16 | CUDA / CPU，具体运算由后端支持 |
| BF16 | PyTorch bfloat16 | NVIDIA GPU 至少 Ampere；CPU 依 PyTorch 支持 |
| FP32 | PyTorch float32 | CUDA / CPU |

这些是离散精度选项，不是任意 4 到 32 位的滑块。FP4 是 bitsandbytes 的 FP4 权重编码，不等同于 NVIDIA Blackwell 的 NVFP4 全计算路径，也不等同于整数 INT4。

## 量化范围与计算精度

Qwen 和 MOSS 符合条件的线性层在任务加载时转换，包含 MOSS 的音频到文本投影桥接。音频编码器、输出层及共享嵌入不量化；Qwen ForcedAligner 保持原配置：默认 CPU FP32，或使用与识别相同设备上的计算精度。原始权重与配置文件不改写，也不会每次识别在磁盘生成一套量化副本。

选择 FP4/NF4/FP8/INT8 后，可设置“计算／未量化层精度”：自动、FP16、BF16、FP32。FP4/NF4 还可调整嵌套量化。FP8 使用 float8 权重存储和 Quanto 的混合计算路径，不要求原生 FP8 Tensor Core；它不意味着整个模型用 FP8 做矩阵乘法。INT8 中异常值由库保留高精度处理。

权重量化不量化 KV 缓存、全部激活或整个音频输入，也不会按 4/16、8/16 的简单比例减少整项任务显存。原有专用显存预算、整段上下文、MOSS 自动 CPU KV 缓存与受限编码批次继续生效。内存不足会停止，不会自动切换精度或分片。

量化可能改变转写结果，也可能增加首次加载或推理耗时。FP32 不会恢复源模型文件中已经丢失的精度。日志的 asr-precision 记录请求精度、实际计算类型、已转换层数和实际权重类型，asr-memory 记录 PyTorch 分配、保留和峰值。两者都不等于系统全部 GPU 进程的总显存。

如果后端没有实际转换、实际类型不匹配或意外转换了受保护的音频/输出层，任务会报错，不伪装成量化成功。导入已预量化模型时，显式 FP16/BF16/FP32 不会将它错误标记为未量化模型；请导入原始权重或使用自动模式。

## 环境与兼容性

一键部署清单升级至 nvidia-v2。固定新增 bitsandbytes==0.50.2 和 optimum-quanto==0.2.7，保留 torch/torchaudio==2.8.0 与各后端原版本。部署完成前会检查 Torch CUDA 以及 FP4/FP8 小矩阵运算。

旧环境继续用于原有精度。需要量化但缺少依赖时，在“模型下载与部署”执行“检查与修复部署”，为官方模型创建新独立环境；已有官方权重、下载缓存和 Python 可复用，旧环境保留。自定义/手动环境不会自动被修改，可通过环境配置提示词安装依赖。所有环境、包缓存、模型和临时文件仍放在安装目录 asr 下。

当前 Qwen vLLM 路径只应用自动/FP16/BF16/FP32；低位选项由 Transformers 实现，切到 vLLM 后不可提交这些选项，避免参数被忽略。FlashAttention 2 和 BF16 仍受具体硬件及环境限制。

Whisper 使用现有 whisper.cpp / GGML 后端，精度由导入的模型文件决定。Q4/Q8 是 GGML 整数分组量化，不能在界面将其改称 FP4/FP8，亦不能通过识别参数改变文件精度。自定义 JSONL 后端自行管理精度，应用不会向未知后端注入这些参数。

## 验证

脚本 python scripts/asr-precision-validation.py 使用 tests/media 的 TED 视频，提取 8 秒 16 kHz 音频，在独立进程逐档识别并保存实际类型、内存记录和原始结果。Qwen 0.6B、MOSS 0.9B 的七档精度均已完成识别；FP32 在 CPU 与 RTX 3060 Laptop 6 GB 上都通过。此测试验证执行与结果输出，不是量化后的识别准确率评测，也不代表任意时长/硬件必然满足内存预算。

CPU 的 FP8 权重量化也已在两个模型上补测通过。报告：artifacts/qa/asr-precision-qwen3-asr.json、artifacts/qa/asr-precision-moss-transcribe-diarize.json。新环境的实际安装与 CUDA 量化检查见 artifacts/qa/asr-deployment-real-validation.json。

## 实现依据

- [Transformers bitsandbytes 配置与计算精度](https://huggingface.co/docs/transformers/v4.57.0/en/quantization/bitsandbytes)
- [bitsandbytes Windows/CUDA 支持](https://huggingface.co/docs/bitsandbytes/main/en/installation)
- [Transformers Quanto 权重量化](https://huggingface.co/docs/transformers/v4.57.1/quantization/quanto)
- [Quanto 官方实现与设备支持](https://github.com/huggingface/optimum-quanto)
