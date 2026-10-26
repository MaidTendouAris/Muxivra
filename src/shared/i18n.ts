import english from './locales/en.json'
import type { UiLocale } from './locale'
const messages:Record<string,string>=english
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
// Prefer the most specific UI phrase; a generic "{0} subtitles" must not
// consume an entire "Edit subtitle line {0}" message as its placeholder.
const patterns=Object.entries(messages).filter(([key])=>/\{\d+\}/.test(key)).sort(([left],[right])=>right.replace(/\{\d+\}/g,'').length-left.replace(/\{\d+\}/g,'').length).map(([key,value])=>{
  const slots:number[]=[],parts:string[]=[];let end=0
  for(const match of key.matchAll(/\{(\d+)\}/g)){parts.push(escape(key.slice(end,match.index)), '([\\s\\S]*?)');slots.push(Number(match[1]));end=match.index!+match[0].length}
  return {pattern:new RegExp('^'+parts.join('')+escape(key.slice(end))+'$'),value,slots}
})
export function translateUi(key:string,locale:UiLocale,...values:unknown[]):string{
  let text=key
  if(locale==='en'){
    text=messages[key]??key
    if(text===key&&!values.length&&/[\u3400-\u9fff]/.test(key))for(const {pattern,value,slots} of patterns){const match=pattern.exec(key);if(match){const args:unknown[]=[];slots.forEach((slot,index)=>args[slot]=match[index+1]);return value.replace(/\{(\d+)\}/g,(placeholder,index)=>args[Number(index)]===undefined?placeholder:String(args[Number(index)]))}}
  }
  return values.length?text.replace(/\{(\d+)\}/g,(match,index)=>Number(index)<values.length?String(values[Number(index)]):match):text
}
