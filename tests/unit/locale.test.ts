import { describe,it,expect } from 'vitest'
import { resolveUiLocale } from '../../src/shared/locale'
import { translateUi } from '../../src/shared/i18n'
import { readdirSync,readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import english from '../../src/shared/locales/en.json'
describe('interface languages',()=>{
  it('uses supported system preferences and an English fallback, with explicit overrides',()=>{
    expect(resolveUiLocale('system',['zh-CN','en-US'])).toBe('zh-CN');expect(resolveUiLocale('system',['en-GB','zh-TW'])).toBe('en');expect(resolveUiLocale('system',['ja-JP','zh-Hant'])).toBe('zh-CN');expect(resolveUiLocale('system',['de-DE'])).toBe('en');expect(resolveUiLocale('zh-CN',['en-US'])).toBe('zh-CN')
  })
  it('substitutes UI placeholders without translating media or supplied subtitle text',()=>{
    expect(translateUi('编辑第 {0} 条字幕','en',12)).toBe('Edit subtitle line 12');expect(translateUi('编辑第 12 条字幕','en')).toBe('Edit subtitle line 12');expect(translateUi('选择第 {0} 条字幕','zh-CN',7)).toBe('选择第 7 条字幕');expect(translateUi('example.ass','en')).toBe('example.ass')
  })
  it('covers explicit renderer UI keys and preserves every substitution slot',()=>{
    const keys=new Set(Object.keys(english)),missing=new Set<string>()
    for(const file of readdirSync('src/renderer',{recursive:true}) as string[]){if(!/\.tsx?$/.test(file)||file.endsWith('i18n.ts'))continue;const source=ts.createSourceFile(file,readFileSync(join('src/renderer',file),'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)
      const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText(source)==='tr'&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])&&/[\u3400-\u9fff]/.test(node.arguments[0].text)&&!keys.has(node.arguments[0].text))missing.add(node.arguments[0].text);ts.forEachChild(node,visit)};visit(source)
    }
    expect([...missing]).toEqual([])
    const slots=(text:string)=>[...new Set([...text.matchAll(/\{\d+\}/g)].map(match=>match[0]))].sort()
    for(const [key,value]of Object.entries(english))expect(slots(value),key).toEqual(slots(key))
  })
})
