// shadcn/ui button pattern (MIT), adapted to Muxivra's visual tokens.
import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'
import { Loader2 } from 'lucide-react'
const variants = cva('button',{ variants: { variant: { default: 'button-primary', secondary: 'button-secondary', ghost: 'button-ghost', danger: 'button-danger' }, size: { default: '', sm: 'button-sm', icon: 'button-icon' } }, defaultVariants: { variant: 'default', size: 'default' } })
type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>,'onClick'> & VariantProps<typeof variants> & {
  asChild?: boolean; loading?: boolean; loadingText?: string; onClick?: (event: React.MouseEvent<HTMLButtonElement>) => unknown
}
export function Button({ className, variant, size, asChild = false, onClick, disabled, children, loading=false, loadingText, ...props }: ButtonProps) {
  const [pending,setPending]=React.useState(false),running=React.useRef(false),alive=React.useRef(true)
  React.useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  const click=(event:React.MouseEvent<HTMLButtonElement>)=>{
    if(running.current)return
    const result=onClick?.(event)
    if(result&&typeof (result as PromiseLike<unknown>).then==='function'){
      running.current=true;setPending(true)
      Promise.resolve(result).catch(error=>console.error(error)).finally(()=>{running.current=false;if(alive.current)setPending(false)})
    }
  }
  const Component=asChild?Slot:'button'
  const working=pending||loading
  return <Component className={cn(variants({variant,size}),className)} {...props} onClick={click} disabled={disabled||working} aria-busy={working||undefined}>
    {asChild?children:<>{working&&<Loader2 size={size==='icon'?17:16} className="spin button-spinner"/>}{working&&loadingText?loadingText:children}</>}
  </Component>
}
