import type { JobRequest } from './types'

export type McpRequestStatus = 'pending' | 'approving' | 'approved' | 'rejected' | 'failed'

export interface DirectoryAccessRequest {
  requestKey: string
  path: string
  permission: 'input' | 'output'
  reason: string
}

export interface TranscodeApprovalRequest {
  requestKey: string
  requests: JobRequest[]
  reason: string
}

interface McpRequestBase {
  id: string
  requestKey: string
  fingerprint: string
  status: McpRequestStatus
  createdAt: string
  resolvedAt?: string
  reason: string
  reviewerNote?: string
  error?: string
  jobIds?: string[]
}

export type McpRequest = McpRequestBase & (
  { kind: 'directory'; payload: { path: string; permission: 'input' | 'output' } } |
  { kind: 'transcode'; payload: { requests: JobRequest[] } }
)

export type McpRequestAction = Pick<DirectoryAccessRequest, 'requestKey' | 'reason'> & (
  { kind: 'directory'; payload: { path: string; permission: 'input' | 'output' } } |
  { kind: 'transcode'; payload: { requests: JobRequest[] } }
)
