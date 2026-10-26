import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'

export type HeaderDockItem = { id:string; label:string; icon?:LucideIcon; disabled?:boolean }

/** Persistent pages share a single header slot; only the visible page mounts its navigation. */
export function HeaderDock({items,value,onChange,ariaLabel,active=true,className=''}:{items:ReadonlyArray<HeaderDockItem>;value:string;onChange:(id:string)=>void;ariaLabel:string;active?:boolean;className?:string}) {
  const [host,setHost]=useState<HTMLElement|null>(null)
  useEffect(()=>{setHost(document.getElementById('workspace-header-dock'))},[])
  if(!active||!host)return null
  return createPortal(<nav className={`header-dock ${className}`} aria-label={ariaLabel}>{items.map(({id,label,icon:Icon,disabled})=><button key={id} type="button" className={value===id?'active':''} aria-current={value===id?'step':undefined} disabled={disabled} onClick={()=>onChange(id)} title={label}>{Icon&&<Icon size={15}/>}<span>{label}</span></button>)}</nav>,host)
}
