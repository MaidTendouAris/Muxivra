export type ParameterValue = string | number | boolean
export interface ParameterDefinition {
  key: string; group: string; label: string; type: 'number' | 'select' | 'text'
  flag?: string; scope?: 'input' | 'video' | 'audio' | 'output'; min?: number; max?: number; integer?: boolean
  choices?: string[]; hint?: string
}
export const parameterGroups = [
  ['output','输出与剪辑'],['decode','解码'],['encoder','视频编码'],['quality','质量与码率'],
  ['color','色彩与画面'],['videoFilters','视频滤镜'],['audio','音频'],['audioFilters','音频滤镜'],
  ['image','图像输出'],['streams','流与元数据'],['private','编码器专用参数']
] as const
const n = (key:string,group:string,label:string,flag?:string,scope?:ParameterDefinition['scope'],min=0,max=1000000,integer=false):ParameterDefinition => ({key,group,label,type:'number',flag,scope,min,max,integer})
const s = (key:string,group:string,label:string,choices:string[],flag?:string,scope?:ParameterDefinition['scope'],hint?:string):ParameterDefinition => ({key,group,label,type:'select',choices,flag,scope,hint})
const t = (key:string,group:string,label:string,flag?:string,scope?:ParameterDefinition['scope'],hint?:string):ParameterDefinition => ({key,group,label,type:'text',flag,scope,hint})
export const parameters:ParameterDefinition[] = [
  n('start','output','开始时间（秒）',undefined,undefined,0,359999),n('end','output','结束时间（秒）',undefined,undefined,0,359999),
  s('seekMode','output','剪辑定位',['accurate','fast'],undefined,undefined,'精确定位会解码到开始时间；复制轨道仍受关键帧限制'),
  n('duration','output','输出时长上限（秒）',undefined,undefined,0.001,359999),n('fileSize','output','文件大小上限（MB）','fs','output',1,1000000),
  s('faststart','output','MP4 网络播放优化',['on','off']),
  s('hwaccel','decode','硬件解码',['auto','d3d11va','dxva2','cuda','qsv','vulkan','none'],'hwaccel','input'),
  n('decodeThreads','decode','CPU 解码线程数','threads','input',0,256,true),
  s('hwFormat','decode','硬件解码输出格式',['nv12','p010le','yuv420p','cuda','qsv','d3d11'],'hwaccel_output_format','input'),
  t('hwDevice','decode','解码设备编号','hwaccel_device','input','例如 0 或 1'),
  t('decoder','decode','指定视频解码器','c:v','input'),n('probeSize','decode','探测数据量（字节）','probesize','input',32,2147483647,true),
  n('analyzeDuration','decode','探测时长（微秒）','analyzeduration','input',0,2147483647,true),
  s('autorotate','decode','自动旋转',['on','off']),
  t('profile','encoder','Profile','profile:v','video'),t('tune','encoder','Tune','tune:v','video'),t('level','encoder','Level','level:v','video'),
  n('encodeThreads','encoder','编码线程数','threads:v','video',0,256,true),n('gpu','encoder','NVIDIA 编码设备','gpu','video',-1,128,true),
  n('gop','encoder','关键帧间隔（帧）','g','video',1,1000000,true),n('bFrames','encoder','B 帧数','bf','video',0,16,true),
  n('refs','encoder','参考帧数','refs','video',1,16,true),n('keyintMin','encoder','最小关键帧间隔','keyint_min','video',0,1000000,true),
  s('rateControl','quality','质量控制',['auto','crf','cq','qp','bitrate','manual']),
  n('videoBitrate','quality','视频码率（kbps）','b:v','video',1,1000000),n('minrate','quality','最低码率（kbps）','minrate','video',0,1000000),
  n('maxrate','quality','最高码率（kbps）','maxrate','video',1,1000000),n('bufsize','quality','码率缓冲区（kbit）','bufsize','video',1,10000000),
  n('qmin','quality','最小量化值','qmin','video',0,63,true),n('qmax','quality','最大量化值','qmax','video',0,63,true),
  n('qcomp','quality','量化曲线压缩','qcomp','video',0,1),n('globalQuality','quality','全局质量','global_quality','video',0,1000),
  n('width','color','输出宽度（像素）',undefined,undefined,2,32768,true),n('height','color','输出高度（像素）',undefined,undefined,2,32768,true),
  s('scaleAlgorithm','color','缩放算法',['bicubic','bilinear','lanczos','spline','neighbor','area','fast_bilinear']),
  s('aspectMode','color','尺寸适配',['fit','stretch'],undefined,undefined,'只填宽或高时自动保持比例'),
  t('pixelFormat','color','输出像素格式','pix_fmt','video'),
  s('colorspace','color','色彩矩阵',['bt709','bt470bg','smpte170m','smpte240m','bt2020nc','bt2020c','rgb'],'colorspace','video'),
  s('primaries','color','色域',['bt709','bt470m','bt470bg','smpte170m','smpte240m','bt2020','smpte431','smpte432'],'color_primaries','video'),
  s('transfer','color','传输特性',['bt709','gamma22','gamma28','smpte170m','linear','iec61966-2-1','smpte2084','arib-std-b67'],'color_trc','video'),
  s('colorRange','color','色彩范围',['tv','pc'],'color_range','video'),
  s('colorMode','color','色彩处理',['metadata','convert'],undefined,undefined,'转换像素使用 colorspace；HDR 色调映射在滤镜中设置'),
  t('frameRate','color','输出帧率','r','video','例如 25、60 或 24000/1001'),
  s('fpsMode','color','帧率模式',['cfr','vfr','passthrough'],'fps_mode','video'),n('videoFrames','image','输出帧数上限','frames:v','video',1,100000000,true),
  n('imageQuality','image','JPEG / WebP 质量','q:v','video',1,100),s('imageLoop','image','动画循环',['forever','once'],'loop','video'),
  n('audioQuality','audio','音频质量（q:a）','q:a','audio',-1,10),n('sampleRate','audio','采样率（Hz）','ar','audio',8000,384000,true),
  n('channels','audio','声道数','ac','audio',1,32,true),
  s('sampleFormat','audio','采样格式 / 位深',['u8','s16','s32','s64','flt','dbl','u8p','s16p','s32p','fltp','dblp'],'sample_fmt','audio'),
  n('compressionLevel','audio','压缩等级','compression_level','audio',0,12,true),
  s('metadata','streams','原文件元数据',['keep','remove']),s('chapters','streams','章节',['keep','remove']),
  s('attachments','streams','原文件附件',['none','copy'],undefined,undefined,'附件复制仅适用于 MKV'),
  n('audioDelay','streams','音轨延迟（秒）',undefined,undefined,-3600,3600),
  n('burnSubtitle','streams','烧录内嵌字幕序号',undefined,undefined,0,63,true),
  t('subtitleFont','streams','烧录字幕字体'),n('subtitleSize','streams','烧录字号',undefined,undefined,1,200),
  n('subtitleOutline','streams','字幕描边宽度',undefined,undefined,0,20),n('subtitleMargin','streams','字幕底部边距',undefined,undefined,0,2000,true),
  s('subtitleAlignment','streams','字幕对齐',['1','2','3','4','5','6','7','8','9']),
  s('subtitleBold','streams','字幕粗体',['on','off']),s('subtitleItalic','streams','字幕斜体',['on','off']),
  s('subtitleBorder','streams','字幕边框样式',['outline','box']),n('subtitleShadow','streams','字幕阴影距离',undefined,undefined,0,20),
  n('subtitleMarginL','streams','字幕左边距',undefined,undefined,0,2000,true),n('subtitleMarginR','streams','字幕右边距',undefined,undefined,0,2000,true),
  n('subtitleSpacing','streams','字幕字距',undefined,undefined,-20,100),
  t('subtitleColor','streams','字幕颜色（#RRGGBB）'),t('subtitleOutlineColor','streams','字幕描边颜色（#RRGGBB）'),t('subtitleBackColor','streams','字幕背景颜色（#RRGGBB）')
]
export interface FilterDefinition { name:string; label:string; kind:'video'|'audio'; category:string }
export const filterLibrary:FilterDefinition[] = [
  ...[['crop','裁剪','尺寸'],['pad','填充边框','尺寸'],['scale','缩放','尺寸'],['setsar','像素比例','尺寸'],['setdar','画面比例','尺寸'],
  ['fps','帧率','帧处理'],['mpdecimate','抽帧 / 去重复帧','帧处理'],['minterpolate','运动插帧','帧处理'],['tmix','帧混合 / 动态模糊','帧处理'],
  ['zscale','色彩转换 / 缩放','色彩'],['colorspace','色彩空间转换','色彩'],['libplacebo','GPU 色彩 / 超分 / 色调映射','色彩'],['tonemap','HDR 色调映射','色彩'],['eq','亮度 / 对比度 / 饱和度 / 伽马','色彩'],['format','像素格式转换','色彩'],
  ['hqdn3d','时空降噪','降噪'],['nlmeans','非局部均值降噪','降噪'],['atadenoise','自适应降噪','降噪'],['bm3d','BM3D 降噪','降噪'],
  ['unsharp','锐化 / 模糊','效果'],['cas','对比度自适应锐化','效果'],['noise','胶片颗粒','效果'],['deband','去色带','效果'],['gradfun','渐变平滑','效果'],['boxblur','方框模糊','效果'],['gblur','高斯模糊','效果'],
  ['yadif','反交错','扫描'],['bwdif','高质量反交错','扫描'],['tinterlace','转隔行','扫描'],['fieldmatch','反胶片场匹配','扫描'],['decimate','反胶片抽帧','扫描'],['pullup','反胶片拉回','扫描'],
  ['transpose','旋转','翻转'],['hflip','水平镜像','翻转'],['vflip','垂直镜像','翻转'],['rotate','任意角度旋转','翻转']].map(([name,label,category])=>({name,label,category,kind:'video' as const})),
  ...[['volume','音量'],['loudnorm','响度标准化'],['dynaudnorm','动态响度'],['aresample','重采样'],['aformat','音频格式'],['atempo','音频倍速'],['adelay','音频延迟'],['highpass','高通'],['lowpass','低通'],['equalizer','均衡器'],['afftdn','频域降噪'],['acompressor','压缩器'],['alimiter','限幅'],['afade','淡入淡出']].map(([name,label])=>({name,label,category:'音频',kind:'audio' as const}))
]
export interface AvOption { name:string; type:string; description:string; defaultValue?:string; min?:number; max?:number; choices:{value:string;label:string}[]; aliases?:string[] }
export interface ComponentCapabilities { name:string; kind:'videoEncoder'|'audioEncoder'|'filter'; description:string; options:AvOption[]; pixelFormats:string[] }
export interface FilterSetting { id:string; name:string; enabled:boolean; options:Record<string,string> }
export interface EncoderSetting { scope:'video'|'audio'; name:string; value:string }
export const internalEncoderParameters:ParameterDefinition[] = [
  n('aq-mode','private','自适应量化模式',undefined,undefined,0,4,true),n('aq-strength','private','自适应量化强度',undefined,undefined,0,3),
  n('psy-rd','private','视觉率失真强度',undefined,undefined,0,10),n('psy-rdoq','private','视觉量化强度',undefined,undefined,0,50),
  n('rd','private','率失真等级',undefined,undefined,0,6,true),n('rdoq-level','private','量化优化等级',undefined,undefined,0,2,true),
  n('rc-lookahead','private','前瞻帧数',undefined,undefined,0,250,true),n('qcomp','private','量化曲线压缩',undefined,undefined,0,1),
  n('keyint','private','关键帧间隔',undefined,undefined,1,100000,true),n('min-keyint','private','最小关键帧间隔',undefined,undefined,0,100000,true),
  n('bframes','private','B 帧数',undefined,undefined,0,16,true),n('ref','private','参考帧数',undefined,undefined,1,16,true),
  n('scenecut','private','场景切换阈值',undefined,undefined,0,100,true),n('merange','private','运动搜索范围',undefined,undefined,4,32768,true),
  n('subme','private','子像素运动估计',undefined,undefined,0,11,true),n('cbqpoffs','private','Cb 量化偏移',undefined,undefined,-12,12,true),
  n('crqpoffs','private','Cr 量化偏移',undefined,undefined,-12,12,true),n('vbv-maxrate','private','VBV 最高码率（kbps）',undefined,undefined,1,1000000),
  n('vbv-bufsize','private','VBV 缓冲区（kbit）',undefined,undefined,1,10000000),n('vbv-init','private','VBV 初始填充比例',undefined,undefined,0,1),
  ...['cutree','sao','strong-intra-smoothing','rect','amp','weightp','weightb','open-gop','repeat-headers','lossless'].map(key=>s(key,'private',({cutree:'CU 树量化',sao:'采样自适应偏移','strong-intra-smoothing':'强帧内平滑',rect:'矩形运动分区',amp:'非对称运动分区',weightp:'P 帧加权预测',weightb:'B 帧加权预测','open-gop':'开放 GOP','repeat-headers':'重复参数集',lossless:'无损编码'} as Record<string,string>)[key],['0','1']))
]
export const x264InternalKeys=new Set(['aq-mode','aq-strength','psy-rd','rc-lookahead','qcomp','keyint','min-keyint','bframes','ref','scenecut','merange','subme','vbv-maxrate','vbv-bufsize','vbv-init','weightp','weightb','open-gop','repeat-headers'])
export const optionLabels:Record<string,string> = {
  w:'宽度',h:'高度',out_w:'裁剪宽度',out_h:'裁剪高度',x:'横向位置',y:'纵向位置',keep_aspect:'保持画面比例',exact:'精确裁剪',
  fps:'目标帧率',mi_mode:'插帧模式',mc_mode:'运动补偿',me_mode:'运动估计模式',me:'运动估计算法',vsbmc:'可变块补偿',mb_size:'块大小',search_param:'搜索范围',scd:'场景检测',scd_threshold:'场景检测阈值',
  frames:'混合帧数',weights:'帧权重',scale:'缩放系数',planes:'颜色平面',max:'最多连续丢帧数',hi:'高差异阈值',lo:'低差异阈值',frac:'差异块比例',
  brightness:'亮度',contrast:'对比度',saturation:'饱和度',gamma:'伽马',luma_spatial:'亮度空间强度',chroma_spatial:'色度空间强度',luma_tmp:'亮度时间强度',chroma_tmp:'色度时间强度',
  strength:'强度',sigma:'噪声标准差',p:'补丁大小',r:'搜索大小',luma_msize_x:'亮度水平尺寸',luma_msize_y:'亮度垂直尺寸',luma_amount:'亮度锐化强度',chroma_amount:'色度锐化强度',
  mode:'模式',parity:'场序',deint:'处理帧范围',dir:'旋转方向',angle:'旋转角度（弧度）',
  I:'目标响度（LUFS）',LRA:'动态范围（LU）',TP:'真峰值（dBTP）',volume:'音量倍率',sample_rate:'采样率',tempo:'倍速',
  color_primaries:'色域',color_trc:'传输特性',colorspace:'色彩矩阵',range:'色彩范围',tonemapping:'色调映射',upscaler:'上采样算法',downscaler:'下采样算法',antiringing:'抗振铃',
  aq_mode:'自适应量化模式','aq-mode':'自适应量化模式','aq-strength':'自适应量化强度','rc-lookahead':'前瞻帧数',rc:'码率控制',preset:'编码速度预设',profile:'Profile',tune:'场景优化'
}
