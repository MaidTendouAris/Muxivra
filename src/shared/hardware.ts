export interface HardwareValue<T> { status: 'available' | 'missing' | 'error'; value?: T; detail?: string }
export interface GpuInfo {
  name: HardwareValue<string>; vendor: HardwareValue<string>; driver: HardwareValue<string>
  memoryBytes: HardwareValue<number>
  sharedMemoryBytes: HardwareValue<number>
  id?: string; adapterIds?: string[]; pciAddress?:string; kind: 'physical' | 'virtual' | 'software' | 'unknown'
  memorySource: 'NVML' | 'DXGI' | 'unavailable'; usableMemoryBytes?:number
}
export interface HardwareInfo {
  version: 2; detectedAt?: string; collector: string; bootTimeMs?:number
  cpu: HardwareValue<{ models: string[]; physicalCores?: number; logicalCores: number }>
  memory: HardwareValue<number>; system: HardwareValue<string>; architecture: HardwareValue<string>
  gpus: HardwareValue<GpuInfo[]>; warnings: string[]
}
export interface GpuUsage {
  id: string; name: string
  utilization: HardwareValue<number>; encoder: HardwareValue<number>; decoder: HardwareValue<number>
  dedicatedBytes: HardwareValue<number>; sharedBytes: HardwareValue<number>
  dedicatedTotal?: number; sharedTotal?: number
  engines: { name: string; utilization: number }[]
}
export interface SystemUsage {
  sampledAt: string; intervalMs?: number
  cpu: HardwareValue<number>; threads: HardwareValue<number[]>
  memory: { totalBytes: number; usedBytes: number; percent: number }
  gpu: HardwareValue<number>; gpus: GpuUsage[]
}
