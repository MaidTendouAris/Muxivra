import { tr } from '../lib/i18n'
import { useLayoutEffect,useRef,useState,type ReactNode,type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from './ui'
export function PlayerSettingsPanel({anchor,onClose,children}:{anchor:RefObject<HTMLSpanElement|null>;onClose:()=>void;children:ReactNode}){
  const panel=useRef<HTMLDivElement>(null),[position,setPosition]=useState({left:8,top:8,width:560,maxHeight:420})
  useLayoutEffect(()=>{
    const update=()=>{const button=anchor.current?.getBoundingClientRect();if(!button)return;const width=Math.max(240,Math.min(560,innerWidth-16)),above=button.top-16,below=innerHeight-button.bottom-16,up=above>=Math.min(360,below),maxHeight=Math.max(100,Math.min(480,up?above:below)),height=Math.min(panel.current?.scrollHeight??maxHeight,maxHeight),next={left:Math.max(8,Math.min(innerWidth-width-8,button.right-width)),top:up?Math.max(8,button.top-height-8):button.bottom+8,width,maxHeight};setPosition(current=>JSON.stringify(current)===JSON.stringify(next)?current:next)}
    const outside=(event:PointerEvent)=>{const target=event.target as Element;if(!panel.current?.contains(target)&&!anchor.current?.contains(target)&&!target.closest('[role="listbox"]'))onClose()}
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!document.querySelector('[role="listbox"],[role="dialog"]')){event.preventDefault();event.stopImmediatePropagation();onClose();anchor.current?.querySelector('button')?.focus()}}
    const observer=new ResizeObserver(update);if(panel.current)observer.observe(panel.current);update();window.addEventListener('resize',update);window.addEventListener('scroll',update,true);document.addEventListener('pointerdown',outside,true);window.addEventListener('keydown',key,true)
    return()=>{observer.disconnect();window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);document.removeEventListener('pointerdown',outside,true);window.removeEventListener('keydown',key,true)}
  },[anchor,onClose])
  return createPortal(<div ref={panel} className="player-settings-popover" role="region" aria-label={tr("播放设置与列表")} style={position}><div className="card-heading"><strong>{tr("播放设置与列表")}</strong><Button size="icon" variant="ghost" aria-label={tr("关闭播放设置")} onClick={onClose}><X size={16}/></Button></div>{children}</div>,document.body)
}
