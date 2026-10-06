import connection from '../../resources/mcp-skills/connection/SKILL.md?raw'
import workflow from '../../resources/mcp-skills/workflow/SKILL.md?raw'
import audio from '../../resources/mcp-skills/audio/SKILL.md?raw'
import video from '../../resources/mcp-skills/video/SKILL.md?raw'
import parametersGuide from '../../resources/mcp-skills/parameters/SKILL.md?raw'
import troubleshooting from '../../resources/mcp-skills/troubleshooting/SKILL.md?raw'
import { parameters, parameterGroups, filterLibrary, internalEncoderParameters } from '../shared/parameters'
import { APP_VERSION } from '../shared/version'

export const skillIds = ['connection','workflow','audio','video','parameters','troubleshooting'] as const
export type SkillId = typeof skillIds[number]
const documents = [
  { id:'connection', name:'连接与验证', description:'本机 HTTP MCP、凭据和客户端配置', markdown:connection },
  { id:'workflow', name:'媒体处理流程', description:'分析、计划、提交和结果核验', markdown:workflow },
  { id:'audio', name:'音频转码', description:'AAC / M4A、MP3、FLAC 与音频设置', markdown:audio },
  { id:'video', name:'视频与封装', description:'编码器、硬件能力、画面和轨道', markdown:video },
  { id:'parameters', name:'参数参考', description:'随当前代码生成的参数、滤镜与范围', markdown:parametersGuide },
  { id:'troubleshooting', name:'任务与排错', description:'暂停、取消、去重、耗时和连接诊断', markdown:troubleshooting }
] as const
export const skillCatalog = () => documents.map(({ markdown:_, ...info }) => ({ ...info, uri:`muxivra://skills/${info.id}`, version:APP_VERSION }))
export const parameterReference = () => ({ version:APP_VERSION, groups:parameterGroups, parameters, filters:filterLibrary, codecParameters:internalEncoderParameters })
export function readSkill(id: string) {
  const document = documents.find(d => d.id === id)
  if (!document) throw new Error('未知指南，请从 list_skills 中选择')
  return { ...document, uri:`muxivra://skills/${id}`, version:APP_VERSION, ...(id==='parameters'?{parameterReference:parameterReference()}: {}) }
}
