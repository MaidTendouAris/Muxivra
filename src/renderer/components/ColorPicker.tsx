import { useCallback,useEffect,useRef,useState,type PointerEvent as ReactPointerEvent } from 'react'
import { Pipette } from 'lucide-react'
import { flushSync } from 'react-dom'
import { Button,Field,Input,Modal } from './ui'
import { tr } from '../lib/i18n'
import { colorClamp,hexToHsv,hexToRgb,hsvToHex,normalizeHex,rgbToHex } from '../lib/color'
import { pickScreenColor,supportsScreenColor } from '../lib/screen-color'
import './color-picker.css'

/** Dragging only changes this local draft. A single Apply commits to the owner. */
export function ColorPicker({title,value,alpha,onApply,onClose}:{title:string;value:string;alpha?:number;onApply:(hex:string,alpha?:number)=>void|Promise<void>;onClose:()=>void}){
  const initial=normalizeHex(value)??'#FFFFFF',[hsv,setHsv]=useState(()=>hexToHsv(initial)),[draftAlpha,setAlpha]=useState(alpha??0),[hexInput,setHexInput]=useState(initial),[rgbInput,setRgbInput]=useState(()=>hexToRgb(initial).map(String)),[error,setError]=useState(''),[picking,setPicking]=useState(false),[applying,setApplying]=useState(false)
  const controller=useRef<AbortController|undefined>(undefined),mounted=useRef(true)
  const hex=hsvToHex(hsv),rgb=hexToRgb(hex)
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current?.abort()}},[])
  useEffect(()=>{
    if(!picking)return
    const cancel=(event:KeyboardEvent)=>{if(event.code==='Escape'){event.preventDefault();event.stopImmediatePropagation();controller.current?.abort()}}
    window.addEventListener('keydown',cancel,true)
    return()=>window.removeEventListener('keydown',cancel,true)
  },[picking])
  useEffect(()=>{setHexInput(hex);setRgbInput(rgb.map(String))},[hex])
  // The dialog portal can mount after the parent's layout effect. A callback
  // ref paints on actual canvas attachment as well as hue changes.
  const paintSv=useCallback((canvas:HTMLCanvasElement|null)=>{
    const context=canvas?.getContext('2d');if(!canvas||!context)return
    const width=360,height=210;canvas.width=width;canvas.height=height
    context.fillStyle=hsvToHex({h:hsv.h,s:1,v:1});context.fillRect(0,0,width,height)
    const white=context.createLinearGradient(0,0,width,0);white.addColorStop(0,'#fff');white.addColorStop(1,'#fff0');context.fillStyle=white;context.fillRect(0,0,width,height)
    const black=context.createLinearGradient(0,0,0,height);black.addColorStop(0,'#0000');black.addColorStop(1,'#000');context.fillStyle=black;context.fillRect(0,0,width,height)
  },[hsv.h])
  const acceptHex=(value:string)=>{const next=normalizeHex(value);if(!next){setError(tr('请输入六位 HEX 颜色'));return false}const result=hexToHsv(next);setHsv(previous=>({...result,h:result.s?result.h:previous.h}));setHexInput(next);setRgbInput(hexToRgb(next).map(String));setError('');return true}
  const commitRgb=()=>{const numbers=rgbInput.map(Number);if(rgbInput.some(value=>!value.trim())||numbers.some(value=>!Number.isInteger(value)||value<0||value>255)){setError(tr('RGB 通道必须为 0–255 的整数'));return}acceptHex(rgbToHex(...numbers as [number,number,number]))}
  const point=(event:ReactPointerEvent<HTMLElement>,kind:'sv'|'hue'|'alpha')=>{
    const box=event.currentTarget.getBoundingClientRect(),x=colorClamp((event.clientX-box.left)/box.width),y=colorClamp((event.clientY-box.top)/box.height)
    if(kind==='sv')setHsv(previous=>({...previous,s:x,v:1-y}));else if(kind==='hue')setHsv(previous=>({...previous,h:x*359.999}));else setAlpha(Math.round(x*255))
    setError('')
  }
  const pointer=(kind:'sv'|'hue'|'alpha')=>({onPointerDown:(event:ReactPointerEvent<HTMLElement>)=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);point(event,kind)},onPointerMove:(event:ReactPointerEvent<HTMLElement>)=>{if(event.currentTarget.hasPointerCapture(event.pointerId))point(event,kind)},onPointerUp:(event:ReactPointerEvent<HTMLElement>)=>{if(event.currentTarget.hasPointerCapture(event.pointerId)){point(event,kind);event.currentTarget.releasePointerCapture(event.pointerId)}}})
  const pick=async()=>{
    const current=new AbortController();controller.current=current
    flushSync(()=>{setPicking(true);setError('')})
    // Let Chromium paint away the dialog/backdrop before screen sampling.
    // Transient user activation survives these two animation frames.
    await new Promise<void>(resolve=>{const timer=setTimeout(resolve,120);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve()}))})
    try{const value=await pickScreenColor(current.signal);if(mounted.current&&value)acceptHex(value)}catch(reason){if(mounted.current&&(reason as Error).name!=='AbortError')setError(tr('屏幕取色失败：{0}',(reason as Error).message))}finally{if(mounted.current){controller.current=undefined;setPicking(false)}}
  }
  const apply=async()=>{
    const next=normalizeHex(hexInput);if(!next){setError(tr('请输入六位 HEX 颜色'));return}
    if(rgbInput.some(value=>!value.trim()||!Number.isInteger(Number(value))||Number(value)<0||Number(value)>255)){setError(tr('RGB 通道必须为 0–255 的整数'));return}
    setError('')
    setApplying(true);try{await onApply(next,alpha===undefined?undefined:draftAlpha);onClose()}catch(reason){setError((reason as Error).message)}finally{if(mounted.current)setApplying(false)}
  }
  return <Modal title={title} className="color-modal" locked={picking||applying} onClose={onClose}><div className="color-picker" data-screen-picking={picking}>
    <div className="color-sv-wrap"><canvas className="color-sv" ref={paintSv} role="slider" tabIndex={0} aria-label={tr('饱和度与明度')} aria-valuetext={`${Math.round(hsv.s*100)}%, ${Math.round(hsv.v*100)}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv.s*100)} {...pointer('sv')} onKeyDown={event=>{if(!event.key.startsWith('Arrow'))return;event.preventDefault();setHsv(previous=>({...previous,s:colorClamp(previous.s+(event.key==='ArrowLeft'?-.01:event.key==='ArrowRight'?.01:0)),v:colorClamp(previous.v+(event.key==='ArrowDown'?-.01:event.key==='ArrowUp'?.01:0))}))}}/><span className="color-sv-cursor" style={{left:`${hsv.s*100}%`,top:`${(1-hsv.v)*100}%`}}/></div>
    <div className="color-hue" role="slider" tabIndex={0} aria-label={tr('色相')} aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsv.h)} {...pointer('hue')} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();setHsv(previous=>({...previous,h:event.key==='Home'?0:event.key==='End'?359.999:(previous.h+(event.key==='ArrowLeft'?-1:1)+360)%360}))}}><span style={{left:`${hsv.h/360*100}%`}}/></div>
    {alpha!==undefined&&<div className="color-alpha" role="slider" tabIndex={0} aria-label={tr('透明度（0–255）')} aria-valuemin={0} aria-valuemax={255} aria-valuenow={draftAlpha} style={{'--selected-color':hex} as React.CSSProperties} {...pointer('alpha')} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();setAlpha(previous=>event.key==='Home'?0:event.key==='End'?255:colorClamp(previous+(event.key==='ArrowLeft'?-1:1),0,255))}}><span style={{left:`${draftAlpha/255*100}%`}}/></div>}
    <div className="color-preview-row"><div className="color-preview-pair"><div><span className="color-preview" style={{backgroundColor:initial}}/><small>{tr('原色')}</small></div><div><span className="color-preview" style={{backgroundColor:hex,opacity:alpha===undefined?1:1-draftAlpha/255}}/><small>{tr('预览颜色')}</small></div></div><Button className="color-screen" variant="secondary" size="sm" disabled={picking||applying||!supportsScreenColor()} loading={picking} loadingText={tr('正在取色…')} onClick={pick}><Pipette size={16}/>{tr('屏幕取色')}</Button></div>
    <Field label="HEX"><Input aria-label="HEX" value={hexInput} maxLength={7} spellCheck={false} onChange={event=>setHexInput(event.target.value)} onBlur={()=>acceptHex(hexInput)} onKeyDown={event=>{if(event.key==='Enter')acceptHex(hexInput)}}/></Field>
    <div className="color-rgb-fields">{[tr('红'),tr('绿'),tr('蓝')].map((label,index)=><Field label={label} key={index}><Input aria-label={label} type="number" min={0} max={255} value={rgbInput[index]} onChange={event=>setRgbInput(previous=>previous.map((value,i)=>i===index?event.target.value:value))} onBlur={commitRgb} onKeyDown={event=>{if(event.key==='Enter')commitRgb()}}/></Field>)}{alpha!==undefined&&<Field label={tr('透明度')}><Input aria-label={tr('透明度数值')} type="number" min={0} max={255} value={draftAlpha} onChange={event=>{const value=Number(event.target.value);if(Number.isInteger(value)&&value>=0&&value<=255)setAlpha(value)}}/></Field>}</div>
    {picking&&<p className="hint" role="status">{tr('点击屏幕上的颜色；按 Esc 取消取色。')}</p>}{error&&<p className="error-inline" role="alert">{error}</p>}
    <div className="color-picker-actions"><Button variant="secondary" disabled={picking||applying} onClick={onClose}>{tr('取消')}</Button><Button disabled={picking||applying} loading={applying} onClick={apply}>{tr('应用颜色')}</Button></div>
  </div></Modal>
}
