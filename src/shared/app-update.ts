export type AppUpdatePhase = 'disabled' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'

export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  version?: string
  checkedAt?: string
  releaseDate?: string
  releaseNotes?: string
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
  message: string
  error?: string
}

export const UPDATE_RELEASES_URL = 'https://github.com/MaidTendouAris/Muxivra/releases'
