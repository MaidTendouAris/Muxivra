import { useState, useEffect, useRef, useId, cloneElement, isValidElement, Children, type ReactElement, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react'
import { X, Loader2, Upload, Check, ChevronDown } from 'lucide-react'
import * as SelectPrimitive from '@radix-ui/react-select'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Button } from './button'
export { Button }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const control = isValidElement(children) && [Input,Select,'input','select','textarea'].includes(children.type as typeof Input) ? cloneElement(children as ReactElement<{ 'aria-label'?: string }>,{ 'aria-label': (children.props as { 'aria-label'?: string })['aria-label'] ?? label }) : children
  return <label className="field"><span>{label}</span>{control}{hint && <small>{hint}</small>}</label>
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className={`input ${props.className ?? ''}`} /> }
export function Select({children,value,defaultValue,onChange,disabled,className,notifyOnReselect=false,...props}:SelectHTMLAttributes<HTMLSelectElement>&{notifyOnReselect?:boolean}) {
  const flatten=(nodes:ReactNode):ReactElement<{value?:string|number;disabled?:boolean;children:ReactNode}>[]=>Children.toArray(nodes).flatMap(node=>isValidElement(node)?node.type==='option'?[node as ReactElement<{value?:string|number;disabled?:boolean;children:ReactNode}>]:flatten((node.props as {children:ReactNode}).children):[])
  const options=flatten(children),empty='__muxivra_empty__'
  const viewportId=useId(),[viewport,setViewport]=useState<HTMLDivElement|null>(null)
  const [scroll,setScroll]=useState({top:0,height:0,total:0})
  const drag=useRef<{id:number;y:number;top:number;range:number;travel:number}|undefined>(undefined)
  const measure=()=>{if(viewport)setScroll(old=>{const next={top:viewport.scrollTop,height:viewport.clientHeight,total:viewport.scrollHeight};return old.top===next.top&&old.height===next.height&&old.total===next.total?old:next})}
  useEffect(()=>{if(!viewport)return;const observer=new ResizeObserver(measure);observer.observe(viewport);measure();return()=>observer.disconnect()},[viewport,options.length])
  const range=Math.max(0,scroll.total-scroll.height),thumb=Math.min(scroll.height,Math.max(28,scroll.height*scroll.height/Math.max(1,scroll.total))),travel=Math.max(0,scroll.height-thumb)
  const moveScroll=(value:number)=>{if(viewport)viewport.scrollTop=Math.max(0,Math.min(range,value))}
  const notify=(v:string)=>{const next=v===empty?'':v;onChange?.({target:{value:next},currentTarget:{value:next}} as React.ChangeEvent<HTMLSelectElement>)}
  // Live device state can change before its next UI notification. Reaffirming a
  // selected playback option must still send that choice to the player.
  const reselect=(v:string,itemDisabled?:boolean)=>{if(notifyOnReselect&&!disabled&&!itemDisabled&&(String(value)||empty)===v)notify(v)}
  return <SelectPrimitive.Root value={value===undefined?undefined:String(value)||empty} defaultValue={defaultValue===undefined?undefined:String(defaultValue)||empty} disabled={disabled} onValueChange={notify}>
    <SelectPrimitive.Trigger className={`input select-trigger ${className??''}`} aria-label={props['aria-label']} title={props.title} id={props.id}><SelectPrimitive.Value/><SelectPrimitive.Icon><ChevronDown size={17}/></SelectPrimitive.Icon></SelectPrimitive.Trigger>
    <SelectPrimitive.Portal><SelectPrimitive.Content className="select-menu" position="popper" sideOffset={5} collisionPadding={10}>
      <div className="select-scroll-area">
        <SelectPrimitive.Viewport ref={setViewport} id={viewportId} className={`select-viewport ${range?'has-scrollbar':''}`} onScroll={measure}>{options.map((option,index)=>{const v=String(option.props.value??option.props.children)||empty;return <SelectPrimitive.Item className="select-option" key={index} value={v} disabled={option.props.disabled} data-value={v===empty?'':v} onPointerUp={()=>reselect(v,option.props.disabled)} onClick={event=>{if(event.detail===0)reselect(v,option.props.disabled)}} onKeyDown={event=>{if(!event.repeat&&['Enter',' '].includes(event.key))reselect(v,option.props.disabled)}}><SelectPrimitive.ItemIndicator className="select-check"><Check size={16}/></SelectPrimitive.ItemIndicator><SelectPrimitive.ItemText>{option.props.children}</SelectPrimitive.ItemText></SelectPrimitive.Item>})}</SelectPrimitive.Viewport>
        {range>0&&<div className="select-scroll-track" role="scrollbar" aria-label="选项滚动" aria-controls={viewportId} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={Math.round(range)} aria-valuenow={Math.round(scroll.top)} tabIndex={0}
          onPointerDown={event=>{event.preventDefault();event.stopPropagation();if(!viewport)return;event.currentTarget.setPointerCapture(event.pointerId);if(!(event.target as Element).closest('.select-scroll-thumb'))moveScroll((event.clientY-event.currentTarget.getBoundingClientRect().top-thumb/2)/Math.max(1,travel)*range);drag.current={id:event.pointerId,y:event.clientY,top:viewport.scrollTop,range,travel}}}
          onPointerMove={event=>{const start=drag.current;if(start&&start.id===event.pointerId&&viewport){event.preventDefault();viewport.scrollTop=start.top+(event.clientY-start.y)/Math.max(1,start.travel)*start.range}}}
          onPointerUp={event=>{event.stopPropagation();drag.current=undefined;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)}} onLostPointerCapture={()=>{drag.current=undefined}}
          onWheel={event=>{event.preventDefault();moveScroll(scroll.top+event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?scroll.height:1))}}
          onKeyDown={event=>{const next=event.key==='Home'?0:event.key==='End'?range:event.key==='PageDown'?scroll.top+scroll.height:event.key==='PageUp'?scroll.top-scroll.height:event.key==='ArrowDown'?scroll.top+38:event.key==='ArrowUp'?scroll.top-38:undefined;if(next!==undefined){event.preventDefault();event.stopPropagation();moveScroll(next)}}}>
          <div className="select-scroll-thumb" style={{height:thumb,transform:`translateY(${range?scroll.top/range*travel:0}px)`}}/>
        </div>}
      </div>
    </SelectPrimitive.Content></SelectPrimitive.Portal>
  </SelectPrimitive.Root>
}
export function Card({ title, aside, children, className = '' }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) { return <section className={`card ${className}`}>{title && <div className="card-heading"><h3>{title}</h3>{aside}</div>}{children}</section> }
export function Empty({ title, description, action }: { title: string; description?: string; action?: ReactNode }) { return <div className="empty"><h3>{title}</h3>{description&&<p>{description}</p>}{action}</div> }
export function Progress({ value }: { value: number }) { return <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${Math.min(100,Math.max(0,value))}%` }}/></div> }
export function Modal({ title, children, onClose, wide=false, locked=false, className='' }: { title: string; children: ReactNode; onClose: () => void; wide?:boolean; locked?:boolean; className?:string }) { return <DialogPrimitive.Root open onOpenChange={open=>{if(!open&&!locked)onClose()}}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="modal-backdrop"/><DialogPrimitive.Content className={`modal ${wide?'modal-wide':''} ${className}`} aria-describedby={undefined} onEscapeKeyDown={event=>{if(locked)event.preventDefault()}} onPointerDownOutside={event=>{if(locked)event.preventDefault()}}><div className="card-heading"><DialogPrimitive.Title asChild><h3>{title}</h3></DialogPrimitive.Title><DialogPrimitive.Close asChild><Button variant="ghost" size="icon" aria-label="关闭" disabled={locked}><X size={18}/></Button></DialogPrimitive.Close></div>{children}</DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root> }
export function Busy({ text = '处理中…' }: { text?: string }) { return <span className="busy"><Loader2 size={16} className="spin"/>{text}</span> }
export function DropZone({ children, onFiles }: { children: ReactNode; onFiles: (files: File[]) => void }) { const [drag,setDrag] = useState(false); return <div className={drag ? 'drop-zone dragging' : 'drop-zone'} onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); onFiles(Array.from(e.dataTransfer.files)) }}>{children}</div> }
