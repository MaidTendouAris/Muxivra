export interface SubtitleProjectState {
  documentId?: string
  projectPath?: string
  lastSavedAt?: string
  lastRecoveryAt?: string
  backupPath?: string
  dirty: boolean
  saving: boolean
  recoveryPending?: boolean
  canDeleteProject: boolean
  deleteUnavailableReason?: string
  error?: string
}
