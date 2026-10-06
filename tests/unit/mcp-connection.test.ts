import { describe, expect, it } from 'vitest'
import { buildMcpConnectionPrompt } from '../../src/shared/mcp-connection'
import { readSkill, skillCatalog, parameterReference } from '../../src/mcp/skills'
import { optionsSchema } from '../../src/shared/schema'
import type { McpSettings } from '../../src/shared/types'

const settings:McpSettings={enabled:true,port:19481,token:'a'.repeat(64),inputRoots:['D:\\音乐'],outputRoots:['D:\\Outputs'],allowInspect:true,allowSubmit:false,allowCancel:false}
const info={version:'test-version',running:true,executablePath:"D:\\Program's Files\\Muxivra.exe",skills:skillCatalog()}
describe('可复制的 MCP 连接提示词',()=>{
  it('完整内容带实际保存值、凭据、目录、权限、启动路径及当前会话连接步骤',()=>{
    const text=buildMcpConnectionPrompt(settings,info)
    expect(text).toContain('http://127.0.0.1:19481/mcp')
    expect(text).toContain(settings.token)
    expect(text).toContain(JSON.stringify(settings.inputRoots[0]))
    expect(text).toContain('提交任务：未授权')
    expect(text).toContain("'D:\\Program''s Files\\Muxivra.exe'")
    expect(text).toContain('protocolVersion')
    expect(text).toContain('notifications/initialized')
    expect(text).toContain('不授权转码或取消现有媒体任务')
    expect(text).toContain('不保存凭据')
  })
  it('预览所有位置隐藏凭据，包括环境变量命令',()=>{
    const text=buildMcpConnectionPrompt(settings,info,true)
    expect(text).not.toContain(settings.token)
    expect(text).toContain('[复制时包含实际凭据]')
    expect(text).toContain('bearer_token_env_var = "MUXIVRA_MCP_TOKEN"')
  })
  it('未授权目录、未运行和开发构建如实展示，避免生成无效的 Electron 启动命令',()=>{
    const text=buildMcpConnectionPrompt({...settings,inputRoots:[],outputRoots:[],allowInspect:false},{...info,executablePath:undefined,running:false})
    expect(text).toContain('查询与读取指南：未授权')
    expect(text).toContain('尚未运行')
    expect(text).toContain('这是开发构建')
    expect(text).not.toContain('Start-Process')
  })
})
describe('内置指南与真实结构化参数',()=>{
  it('固定目录拒绝任意文件路径，参数参考跟随共享定义',()=>{
    expect(skillCatalog().map(s=>s.id)).toEqual(['connection','workflow','audio','video','parameters','troubleshooting'])
    expect(()=>readSkill('../../config.json')).toThrow('未知指南')
    const reference=readSkill('parameters').parameterReference!
    expect(reference).toEqual(parameterReference())
    expect(reference.parameters.find(p=>p.key==='sampleRate')).toMatchObject({scope:'audio',integer:true})
    for(const skill of skillCatalog())expect(readSkill(skill.id).markdown).toMatch(/^---\r?\nname: muxivra-/)
  })
  it('音频指南中的完整示例能够通过应用请求结构校验',()=>{
    const code=readSkill('audio').markdown.match(/```json\s+([\s\S]+?)```/)![1]
    const request=JSON.parse(code)
    expect(optionsSchema.parse(request.options)).toMatchObject({container:'m4a',audio:'aac',video:'none',audioBitrate:192})
  })
})
