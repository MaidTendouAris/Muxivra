import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))
export const nameOf = (path: string) => path.split(/[\\/]/).pop() ?? path
export const folderOf = (path: string) => path.replace(/[\\/][^\\/]+$/,'')
export const joinPath = (directory: string, filename: string) => `${directory.replace(/[\\/]$/,'')}\\${filename}`
export const outputName = (input: string, extension: string) => `${nameOf(input).replace(/\.[^.]+$/,'')}-muxivra.${extension}`
export const formatBytes = (bytes: number) => bytes >= 1024**3 ? `${(bytes/1024**3).toFixed(2)} GB` : `${(bytes/1024**2).toFixed(1)} MB`
export const formatDuration = (ms: number) => { const seconds = Math.floor(ms/1000); return `${Math.floor(seconds/3600) ? `${Math.floor(seconds/3600)}:` : ''}${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}` }
export const formatTime = (ms: number) => `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`
export const parseTime = (value: string) => { const match = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value); if (!match || +match[2] > 59 || +match[3] > 59) throw new Error('请使用 HH:MM:SS,mmm 时间格式'); return ((+match[1]*60+ +match[2])*60+ +match[3])*1000+ +match[4] }
