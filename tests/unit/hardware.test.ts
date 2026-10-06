import { describe, it, expect } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HardwareStore, baseHardware, parseWindowsHardware, mergeDxgiHardware } from '../../src/core/hardware'

describe('硬件读取与缓存',()=>{
  it('部分字段缺失与查询失败保持明确状态，不宣称硬件加速可用',()=>{
    const h=parseWindowsHardware({cpu:[{Name:'Example CPU',NumberOfLogicalProcessors:12}],gpu:[{Name:'Example GPU',AdapterRAM:0}]})
    expect(h.cpu.value).toEqual({models:['Example CPU'],logicalCores:12,physicalCores:undefined})
    expect(h.warnings).toContain('CPU 物理核心数未提供')
    expect(h.gpus.value?.[0].driver.status).toBe('missing');expect(h.gpus.value?.[0].memoryBytes.status).toBe('missing')
    const failed=parseWindowsHardware({cpuError:'CIM unavailable',gpuError:'Access denied'})
    expect(failed.cpu.status).toBe('error');expect(failed.gpus).toEqual({status:'error',detail:'Access denied'})
    expect(parseWindowsHardware({cpu:[],gpu:[]}).gpus.status).toBe('missing')
  })
  it('首次读取后缓存，再启动不重复读取，手动更新并持久化',async()=>{
    await mkdir(resolve('.test-data'),{recursive:true});const path=await mkdtemp(resolve('.test-data','hardware-'));let calls=0
    const collect=async()=>{calls++;return {...baseHardware(),detectedAt:`2026-10-06T00:00:0${calls}.000Z`}}
    try {
      const first=new HardwareStore(path,()=>{},collect);await first.initialize();expect(calls).toBe(1)
      const second=new HardwareStore(path,()=>{},collect);await second.initialize();expect(calls).toBe(1);expect(second.info).toEqual(first.info)
      await Promise.all([second.refresh(),second.refresh()]);expect(calls).toBe(2);expect(second.refreshing).toBe(false)
      const third=new HardwareStore(path,()=>{},collect);await third.initialize();expect(third.info.detectedAt).toBe(second.info.detectedAt)
    }finally{await rm(path,{recursive:true,force:true})}
  })
  it('超过 4 GB 的显存优先使用驱动物理容量，按 PCI 身份匹配并保留虚拟设备',()=>{
    const raw={gpu:[{Name:'NVIDIA Test',AdapterRAM:4293918720,PNPDeviceID:'PCI\\VEN_10DE&DEV_2520',DriverVersion:'1.2'},{Name:'Virtual Display',PNPDeviceID:'ROOT\\DISPLAY\\0'}]}
    const adapter={id:'00000000_12345678',name:'NVIDIA Test',vendorId:0x10de,deviceId:0x2520,subSysId:1,dedicatedBytes:6*1024**3-150*1024**2,sharedBytes:16*1024**3,software:false,pciAddress:'01:00.0'}
    const h=mergeDxgiHardware(parseWindowsHardware(raw),[adapter,{...adapter,id:'00000000_12345679'}],raw,[{pciAddress:'01:00.0',deviceId:0x2520,totalBytes:6*1024**3}])
    expect(h.gpus.value).toHaveLength(2);expect(h.gpus.value?.[0]).toMatchObject({memoryBytes:{value:6442450944},memorySource:'NVML',kind:'physical',driver:{value:'1.2'},adapterIds:['00000000_12345678','00000000_12345679']})
    expect(h.gpus.value?.[1]).toMatchObject({kind:'virtual',memoryBytes:{status:'missing'}})
    const fallback=mergeDxgiHardware(parseWindowsHardware(raw),[adapter],raw,[{pciAddress:'02:00.0',deviceId:0x2520,totalBytes:12*1024**3}])
    expect(fallback.gpus.value?.[0].memoryBytes.value).toBe(adapter.dedicatedBytes);expect(fallback.gpus.value?.[0].memorySource).toBe('DXGI')
  })
  it('旧版 CIM 缓存自动重读，不保留截断的显存值',async()=>{
    await mkdir(resolve('.test-data'),{recursive:true});const path=await mkdtemp(resolve('.test-data','hardware-migrate-'));let calls=0
    try {await writeFile(resolve(path,'hardware.json'),JSON.stringify({...baseHardware(),version:1}));const store=new HardwareStore(path,()=>{},async()=>{calls++;return baseHardware()});await store.initialize();expect(calls).toBe(1);expect(store.info.version).toBe(2);await store.shutdown()}
    finally{await rm(path,{recursive:true,force:true})}
  })
  it('系统重新启动后自动更新 GPU LUID，避免实时计数器使用旧标识',async()=>{
    await mkdir(resolve('.test-data'),{recursive:true});const path=await mkdtemp(resolve('.test-data','hardware-boot-'));let calls=0
    try {await writeFile(resolve(path,'hardware.json'),JSON.stringify({...baseHardware(),bootTimeMs:1}));const store=new HardwareStore(path,()=>{},async()=>{calls++;return baseHardware()});await store.initialize();expect(calls).toBe(1);expect(store.info.bootTimeMs).toBeGreaterThan(1);await store.shutdown()}
    finally{await rm(path,{recursive:true,force:true})}
  })
})
