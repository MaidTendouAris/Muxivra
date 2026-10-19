# 0.24.0 验收记录

日期：2026-10-17，Windows x64；RTX 3060 Laptop 6 GB。前版网络修复见 [0.23.2](VERIFICATION-0.23.2.md)。

## 交付范围

- Qwen/MOSS 的识别参数二级页提供自动、FP4、NF4、FP8、INT8、FP16、BF16、FP32；低位权重可另选计算/未量化层精度，FP4/NF4 可调整嵌套量化。首页概览、每模型保存及重启恢复已实现，旧 dtype 配置保持兼容。
- FP4/NF4/INT8 使用 bitsandbytes 0.50.2，FP8 使用 optimum-quanto 0.2.7 的权重量化。只转换符合条件的线性层，保护音频编码器、输出层和共享嵌入；Qwen ForcedAligner 不量化。不会将所有计算、激活、KV 缓存一起标成 4/8 位。
- 任务加载时转换，原模型不覆盖，不生成一套新的磁盘权重。验证实际层类型、FP4/NF4 编码、FP8 冻结状态及 INT8 权重；未转换、类型不匹配、受保护模块被转换会停止。显式高精度也不把已有预量化检查点误报为未量化模型。
- 一键部署使用 nvidia-v2 新独立环境，自动安装量化依赖，验证真实 FP4/FP8 CUDA 运算。已有官方模型和缓存可复用，旧环境保留；手动环境不自动修改。Python、依赖、模型、临时目录及编译缓存位于安装磁盘。
- CPU 的 FP4/NF4/INT8 被明确拒绝；FP8 可用于 CPU。当前 vLLM 低位配置不提交，保留自动/FP16/BF16/FP32，并实际传递其 dtype。Whisper 仍按 GGML 文件精度使用，不把 Q4/Q8 标成 FP4/FP8；自定义后端自行管理。
- 原 CUDA 显存预算、完整上下文、CPU KV 缓存和编码批次限制继续生效；没有因量化开启自动分片或擅自降精度。

## Windows 环境检查修复

界面验证时重复出现“无法绑定 ASR 子进程”。除了旧实现仅凭父 PID 识别后代的缺口，Windows venv 启动器还可能预先把实际 Python 放入私有 Job Object，无法并入已经非空的启动器 Job。

现在逐代校验进程创建时间，并在遍历中保留句柄，排除 PID 复用造成的无关旧进程及其后代。已在私有 Job 中的合法子进程通过新的空白自有 Job 嵌套跟踪；暂停/继续使用去重后的所有成员，取消与关闭覆盖所有自有 Job，保留 KILL_ON_JOB_CLOSE。暂停前再次验证成员归属。

模拟 PID 复用及已退出启动器的单元测试通过；真实 Windows 的普通启动器、带私有 Job 的启动器均通过暂停、继续、取消测试。实际环境检查和精度设置界面随后通过，没有通过跳过进程保护来规避故障。

## 验证结果

- 28 个单元文件、197 项通过；Python 适配器 17 项通过。
- 完整集成 46 项通过、4 项按配置跳过。
- 实际为两个后端创建 nvidia-v2 环境，安装固定依赖，通过包一致性、Torch CUDA、FP4 与 FP8 小矩阵验证；未升级其他应用环境。报告 artifacts/qa/asr-deployment-real-validation.json。
- 使用用户 tests/media 中的 TED 视频，提取 8 秒音频，两个模型的七档精度全部完成真实识别。另补验 GPU FP32 和 CPU FP8，共 18 个精度/设备组合通过。原视频 SHA-256 保持 666b7f9c1cfe8304bab8348c6d280032238a7c159d371bec78edd0c1c170a9cd。
- 报告 artifacts/qa/asr-precision-qwen3-asr.json 和 asr-precision-moss-transcribe-diarize.json；保留每次请求、标准输出、标准错误及内存记录。脚本 python scripts/asr-precision-validation.py。
- 真实 Electron 界面测试遍历七档选项，验证低位计算精度与嵌套量化的显隐、CPU 不兼容提示、每模型保存、重启恢复、环境诊断及明暗主题/窄窗口无横向溢出。报告 artifacts/qa/asr-config-smoke.json。
- 打包后的 0.24.0 应用完成 Qwen/MOSS 的真实 FP4 识别，验证当前实际权重类型校验、原生进度和结果输出；Qwen 同时完成 CPU 词级对齐，MOSS 保留原生时间戳及显存预算检查。报告 artifacts/qa/packaged-asr-precision-smoke.json。

加载后 PyTorch allocated 采样如下，单位 GiB。它不是全进程显存、reserved、峰值或长音频显存预测：

| GPU 精度 | Qwen 0.6B | MOSS 0.9B |
| --- | ---: | ---: |
| FP4 | 0.856 | 1.077 |
| NF4 | 0.856 | 1.077 |
| FP8 | 1.106 | 1.327 |
| INT8 | 1.067 | 1.304 |
| FP16 | 1.465 | 1.692 |
| BF16 | 1.463 | 1.692 |
| FP32 | 2.922 | 3.385 |

低位模式表中计算精度为 FP16。此轮验证执行和字幕输出，不是识别准确率评测；部分结果存在文字差异，保留原生输出。MOSS 既有语言提示限制仍保留。没有声称任意长度、模型或硬件都满足预算。

## 本地发行

0.24.0 位于 release/final-0.24.0，提供 Windows 安装包、源码、blockmap、latest.yml 与 SHA256SUMS.txt；不发布 GitHub Release。打包检查验证当前适配器字节、量化实现、固定依赖、进程创建时间校验、许可证、mpv、原生模块和更新清单。

使用、限制与官方实现依据见 [精度与量化](../asr/PRECISION.md)。
