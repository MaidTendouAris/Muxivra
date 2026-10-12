import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { defaultShortcuts, resolveShortcuts, type ShortcutBindings } from '../../shared/shortcuts'

const ShortcutsContext=createContext<ShortcutBindings>(defaultShortcuts)
export function ShortcutProvider({bindings,children}:{bindings?:ShortcutBindings;children:ReactNode}){
  const resolved=useMemo(()=>resolveShortcuts(bindings),[bindings])
  return <ShortcutsContext.Provider value={resolved}>{children}</ShortcutsContext.Provider>
}
export function useShortcuts(){return useContext(ShortcutsContext)}
