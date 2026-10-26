import { tr } from './i18n'
import type { SubtitleStyle } from '../../shared/subtitles'
import type { TextRange } from './subtitle-format'
export const assTags=[
  {tag:'b',label:'粗体',value:'1'},{tag:'i',label:'斜体',value:'1'},{tag:'u',label:'下划线',value:'1'},{tag:'s',label:'删除线',value:'1'},
  {tag:'fn',label:'字体名称',value:'Arial'},{tag:'fs',label:'字号',value:'48'},{tag:'fscx',label:'水平缩放（%）',value:'100'},{tag:'fscy',label:'垂直缩放（%）',value:'100'},{tag:'fsp',label:'字间距',value:'0'},{tag:'fe',label:'字体编码标识',value:'1'},
  {tag:'1c',label:'文字颜色',value:'&HFFFFFF&'},{tag:'2c',label:'次要颜色',value:'&H0000FF&'},{tag:'3c',label:'描边颜色',value:'&H000000&'},{tag:'4c',label:'阴影颜色',value:'&H000000&'},
  ...['alpha','1a','2a','3a','4a'].map(tag=>({tag,label:'透明度（0–255）',value:'&H00&'})),
  {tag:'bord',label:'描边宽度',value:'2'},{tag:'xbord',label:'水平描边',value:'2'},{tag:'ybord',label:'垂直描边',value:'2'},{tag:'shad',label:'阴影距离',value:'0'},{tag:'xshad',label:'水平阴影',value:'0'},{tag:'yshad',label:'垂直阴影',value:'0'},{tag:'blur',label:'模糊',value:'0'},{tag:'be',label:'边缘柔化',value:'0'},
  ...['frx','fry','frz'].map(tag=>({tag,label:'旋转角度',value:'0'})),{tag:'fax',label:'水平倾斜',value:'0'},{tag:'fay',label:'垂直倾斜',value:'0'},
  {tag:'an',label:'对齐位置',value:'2'},{tag:'pos',label:'位置（x,y）',value:'(960,1000)'},{tag:'org',label:'旋转原点（x,y）',value:'(960,540)'},{tag:'q',label:'换行方式',value:'0'},{tag:'r',label:'重置样式',value:''}
]
export function tagTokens(text:string):{text:string;kind:'plain'|'block'|'tag'|'parameter'}[]{
  return text.split(/(\{[^}]*\})/g).filter(Boolean).flatMap<{text:string;kind:'plain'|'block'|'tag'|'parameter'}>(part=>part.startsWith('{')&&part.endsWith('}')?part.split(/(\\[1-4]?[a-zA-Z]+)/g).filter(Boolean).map(value=>({text:value,kind:value.startsWith('\\')?'tag' as const:value==='{'||value==='}'?'block' as const:'parameter' as const})):[{text:part,kind:'plain' as const}])
}
export function completeTag(text:string,cursor:number){const before=text.slice(0,cursor),open=before.lastIndexOf('{');if(open<=before.lastIndexOf('}'))return undefined;const match=before.slice(open).match(/\\([1-4]?[a-zA-Z]*)$/);if(!match)return undefined;return {start:cursor-match[0].length,end:cursor,items:assTags.filter(item=>item.tag.startsWith(match[1]))}}
export function localTag(text:string,range:TextRange,tag:string,value:string,style:SubtitleStyle,styles:SubtitleStyle[]=[style]){
  if(!assTags.some(item=>item.tag===tag)||/[{}\\\r\n\x00-\x1f]/.test(value)||value.length>200)throw new Error(tr('局部 ASS 标签无效'))
  if(['pos','org'].includes(tag)){if(!/^\(-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\)$/.test(value))throw new Error(tr('请使用 (x,y) 坐标格式'))}
  else if(/^[1-4]c$/.test(tag)){if(!/^&H[\da-f]{6}&$/i.test(value))throw new Error(tr('请使用 &HBBGGRR& 颜色格式'))}
  else if(tag==='alpha'||/^[1-4]a$/.test(tag)){if(!/^&H[\da-f]{2}&$/i.test(value))throw new Error(tr('请使用 &HAA& 透明度格式'))}
  else if(!['fn','r'].includes(tag)&&(!/^-?\d+(?:\.\d+)?$/.test(value)||!Number.isFinite(Number(value))))throw new Error(tr('请输入有限的数值'))
  if(tag==='an'&&(!Number.isInteger(Number(value))||Number(value)<1||Number(value)>9)||tag==='q'&&![0,1,2,3].includes(Number(value)))throw new Error(tr('对齐或换行方式无效'))
  const start=Math.max(0,Math.min(text.length,range.start)),end=Math.max(start,Math.min(text.length,range.end)),blocks=[...text.matchAll(/\{[^}]*\}/g)]
  if(blocks.some(m=>[start,end].some(p=>p>m.index!&&p<m.index!+m[0].length)))throw new Error(tr('请将选区移到 ASS 标签之外'))
  if(['an','q','pos','org'].includes(tag)){const pattern=new RegExp('\\\\'+tag+'(?:\\([^)]*\\)|-?\\d+(?:\\.\\d+)?)','g'),clean=text.replace(/\{[^}]*\}/g,block=>block.replace(pattern,'')).replace(/\{\}/g,'');return {text:`{\\${tag}${value}}`+clean,start:0,end:0}}
  const defaults:Record<string,string>={b:style.bold?'1':'0',i:style.italic?'1':'0',u:style.underline?'1':'0',s:style.strikeOut?'1':'0',fn:style.fontName,fs:String(style.fontSize),fscx:String(style.scaleX),fscy:String(style.scaleY),fsp:String(style.spacing),fe:String(style.encoding),bord:String(style.outline),xbord:String(style.outline),ybord:String(style.outline),shad:String(style.shadow),xshad:String(style.shadow),yshad:String(style.shadow),frz:String(style.angle),frx:'0',fry:'0',fax:'0',fay:'0',blur:'0',be:'0',alpha:'&H00&'}
  for(const [i,key]of (['primaryColour','secondaryColour','outlineColour','backColour'] as const).entries()){const color=style[key].replace(/^&H/,'').replace(/&$/,'').padStart(8,'0');defaults[`${i+1}c`]=`&H${color.slice(-6)}&`;defaults[`${i+1}a`]=`&H${color.slice(0,2)}&`}
  let active={...defaults}
  const prior=blocks.filter(m=>m.index!<start).map(m=>m[0]).join(''),names=[...assTags.map(item=>item.tag),'c','fr'].sort((a,b)=>b.length-a.length)
  for(const match of prior.matchAll(/\\([^\\}]*)/g)){
    const name=names.find(name=>match[1].startsWith(name));if(!name)continue
    const parameter=match[1].slice(name.length)
    if(name==='r'){
      const reset=styles.find(item=>item.name===parameter)||style
      // A style reset cancels all earlier local state, including font names.
      active={...defaults,fn:reset.fontName,fs:String(reset.fontSize),b:reset.bold?'1':'0',i:reset.italic?'1':'0',u:reset.underline?'1':'0',s:reset.strikeOut?'1':'0',fscx:String(reset.scaleX),fscy:String(reset.scaleY),fsp:String(reset.spacing),frz:String(reset.angle),bord:String(reset.outline),xbord:String(reset.outline),ybord:String(reset.outline),shad:String(reset.shadow),xshad:String(reset.shadow),yshad:String(reset.shadow)}
      for(const [i,key]of (['primaryColour','secondaryColour','outlineColour','backColour'] as const).entries()){const color=reset[key].replace(/^&H/,'').replace(/&$/,'').padStart(8,'0');active[`${i+1}c`]=`&H${color.slice(-6)}&`;active[`${i+1}a`]=`&H${color.slice(0,2)}&`}
    }else if(name==='alpha')for(const component of ['1a','2a','3a','4a'])active[component]=parameter
    else if(name==='bord'){active.xbord=parameter;active.ybord=parameter;active.bord=parameter}
    else if(name==='shad'){active.xshad=parameter;active.yshad=parameter;active.shad=parameter}
    else active[name==='c'?'1c':name==='fr'?'frz':name]=parameter
  }
  const restoreNames=tag==='alpha'?['1a','2a','3a','4a']:tag==='bord'?['xbord','ybord']:tag==='shad'?['xshad','yshad']:[tag]
  const open=`{\\${tag}${value}}`,close=end>start&&tag!=='r'?`{${restoreNames.map(name=>'\\'+name+(active[name]??'')).join('')}}`:''
  return {text:text.slice(0,start)+open+text.slice(start,end)+close+text.slice(end),start:start+open.length,end:end+open.length}
}
