/** The source editor and its tests share this line scanner. It never changes source text. */
export interface SourceToken { startIndex:number;scopes:string }
export interface SourceScanState { section:string;eventFields:string[] }
export const initialSourceScanState=():SourceScanState=>({section:'',eventFields:['layer','start','end','style','name','marginl','marginr','marginv','effect','text']})
const time=/\d+:\d{2}:\d{2}[.,]\d{1,3}/g
export function sourceLanguage(language:string,path:string){
  if(/^(ass|ssa|muxivra-ass)$/i.test(language)||/\.(ass|ssa)$/i.test(path))return 'muxivra-ass'
  if(/^(srt|subrip|muxivra-srt)$/i.test(language)||/\.srt$/i.test(path))return 'muxivra-srt'
  return language==='markdown'?'markdown':language==='ini'?'ini':language==='yaml'?'yaml':language==='xml'?'xml':'plaintext'
}
export function scanSourceLine(line:string,language:string,previous:SourceScanState=initialSourceScanState()):{tokens:SourceToken[];state:SourceScanState}{
  const tokens:SourceToken[]=[],state={...previous,eventFields:previous.eventFields}
  const add=(startIndex:number,scopes:string)=>{if(startIndex<line.length||!line.length)tokens.push({startIndex,scopes})}
  const span=(start:number,end:number,type:string)=>{add(start,type);if(end<line.length)add(end,'')}
  const textTags=(start:number)=>{
    const text=line.slice(start),overrides=/\{[^}]*\}?|\\[Nnh]|<\/?[a-z][^>]*>/gi
    for(const match of text.matchAll(overrides)){
      const offset=start+match.index!
      if(match[0][0]==='{'){
        span(offset,offset+match[0].length,'string')
        for(const tag of match[0].matchAll(/\\(?:[1-4]?[a-z]+|[Nnh])/gi))span(offset+tag.index!,offset+tag.index!+tag[0].length,'tag')
      }else span(offset,offset+match[0].length,'tag')
    }
  }
  add(0,'')
  if(language==='muxivra-srt'||language==='srt'){
    if(/^\s*\d+\s*$/.test(line))span(0,line.length,'number')
    else if(line.includes('-->')){
      for(const match of line.matchAll(time))span(match.index!,match.index!+match[0].length,'number')
      const arrow=line.indexOf('-->');span(arrow,arrow+3,'keyword')
    }else textTags(0)
  }else{
    if(/^\s*[;!]/.test(line))span(0,line.length,'comment')
    else if(/^\s*\[[^\]]+\]\s*$/.test(line)){state.section=line.trim().slice(1,-1).toLowerCase();span(0,line.length,'type')}
    else{
      const field=/^(\s*)([^:]+)(:)(\s*)/.exec(line)
      if(field){
        const key=field[2].trim().toLowerCase(),start=field[0].length
        span(field[1].length,field[1].length+field[2].length,'keyword');span(field[0].indexOf(':'),field[0].indexOf(':')+1,'delimiter')
        if(key==='format'){
          span(start,line.length,'type')
          if(state.section==='events')state.eventFields=line.slice(start).split(',').map(value=>value.trim().toLowerCase())
        }else if(key==='dialogue'||key==='comment'){
          let cursor=start
          for(let i=0;i<state.eventFields.length;i++){
            const name=state.eventFields[i],comma=i===state.eventFields.length-1?-1:line.indexOf(',',cursor),end=comma<0?line.length:comma
            if(name==='text'){textTags(cursor);break}
            span(cursor,end,name==='start'||name==='end'?'number':/^(layer|marginl|marginr|marginv)$/.test(name)?'number':'string')
            if(comma<0)break
            span(comma,comma+1,'delimiter');cursor=comma+1
          }
          if(key==='comment')span(start,line.length,'comment')
        }else if(key==='style'){
          let cursor=start
          for(const value of line.slice(start).split(',')){span(cursor,cursor+value.length,/^\s*(?:-?\d+(?:\.\d+)?|&H[0-9a-f]+&?)\s*$/i.test(value)?'number':'string');cursor+=value.length;if(cursor<line.length)span(cursor,cursor+1,'delimiter');cursor++}
        }else span(start,line.length,'string')
      }
    }
  }
  // Later, more specific spans win at the same offset. Monaco requires increasing offsets.
  const unique=new Map<number,SourceToken>();for(const token of tokens)unique.set(token.startIndex,token)
  return {tokens:[...unique.values()].sort((a,b)=>a.startIndex-b.startIndex),state}
}
