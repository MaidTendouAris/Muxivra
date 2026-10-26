import * as monaco from 'monaco-editor/editor/editor.api.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import 'monaco-editor/languages/definitions/markdown/register.js'
import 'monaco-editor/languages/definitions/ini/register.js'
import 'monaco-editor/languages/definitions/yaml/register.js'
import 'monaco-editor/languages/definitions/xml/register.js'
import 'monaco-editor/editor/browser/coreCommands.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/folding/browser/folding.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js'
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js'
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js'
// Monaco 0.57's exports map rewrites every subpath to .js, including CSS.
// Direct asset imports let Vite bundle its MIT-licensed font without a CDN.
import '../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css'
import '../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css'
import { initialSourceScanState,scanSourceLine,type SourceScanState } from './language'

;(globalThis as typeof globalThis & {MonacoEnvironment:monaco.Environment}).MonacoEnvironment={getWorker:()=>new EditorWorker()}
class ScanState implements monaco.languages.IState {
  constructor(readonly value:SourceScanState=initialSourceScanState()){}
  clone(){return new ScanState({...this.value,eventFields:[...this.value.eventFields]})}
  equals(other:monaco.languages.IState){return other instanceof ScanState&&other.value.section===this.value.section&&other.value.eventFields.join(',')===this.value.eventFields.join(',')}
}
for(const [id,extensions,aliases] of [['muxivra-ass',['.ass','.ssa'],['ASS','SSA']],['muxivra-srt',['.srt'],['SubRip','SRT']]] as const){
  monaco.languages.register({id,extensions:[...extensions],aliases:[...aliases]})
  monaco.languages.setTokensProvider(id,{getInitialState:()=>new ScanState(),tokenize:(line,state)=>{const result=scanSourceLine(line,id,(state as ScanState).value);return {tokens:result.tokens,endState:new ScanState(result.state)}}})
  monaco.languages.setLanguageConfiguration(id,{comments:{lineComment:';'},brackets:[['{','}']],autoClosingPairs:[{open:'{',close:'}'}],surroundingPairs:[{open:'{',close:'}'}]})
}
monaco.languages.registerFoldingRangeProvider('muxivra-ass',{provideFoldingRanges:model=>{
  const result:monaco.languages.FoldingRange[]=[];let previous=0
  for(let line=1;line<=model.getLineCount();line++)if(/^\s*\[[^\]]+\]\s*$/.test(model.getLineContent(line))){if(previous&&line>previous+1)result.push({start:previous,end:line-1,kind:monaco.languages.FoldingRangeKind.Region});previous=line}
  if(previous&&model.getLineCount()>previous)result.push({start:previous,end:model.getLineCount(),kind:monaco.languages.FoldingRangeKind.Region})
  return result
}})
monaco.editor.defineTheme('muxivra-source-dark',{base:'vs-dark',inherit:true,rules:[{token:'type',foreground:'C9DF85'},{token:'keyword',foreground:'87C6EE'},{token:'number',foreground:'DDBD87'},{token:'tag',foreground:'D7A6ED'},{token:'string',foreground:'D5DBCF'},{token:'comment',foreground:'859275'}],colors:{'editor.background':'#15181C','editorGutter.background':'#15181C','editorLineNumber.foreground':'#68717D','editor.selectionBackground':'#465336','editorCursor.foreground':'#C9DF85','minimap.background':'#171B20'}})
monaco.editor.defineTheme('muxivra-source-light',{base:'vs',inherit:true,rules:[{token:'type',foreground:'617B2D'},{token:'keyword',foreground:'21648C'},{token:'number',foreground:'875927'},{token:'tag',foreground:'8045A1'},{token:'string',foreground:'384431'},{token:'comment',foreground:'758269'}],colors:{'editor.background':'#FFFFFF','editorGutter.background':'#FFFFFF','editorLineNumber.foreground':'#86917E','editor.selectionBackground':'#DDE8CD','editorCursor.foreground':'#687F32','minimap.background':'#F6F8F3'}})
export {monaco}
