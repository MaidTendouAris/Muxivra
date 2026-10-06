import { describe,it,expect } from 'vitest'
import type { CpuInfo } from 'node:os'
import { baseHardware, parseWindowsHardware, mergeDxgiHardware } from '../../src/core/hardware'
import { cpuDelta, gpuUsage, UsageMonitor } from '../../src/core/hardware/usage'

describe('系统占用计算',()=>{
  it('CPU 线程使用时间差，首个样本和计数重置不伪造 0%',()=>{
    const cpu=(user:number,idle:number):CpuInfo=>({model:'test',speed:1,times:{user,idle,nice:0,sys:0,irq:0}})
    expect(cpuDelta(undefined,[cpu(0,0)]).status).toBe('missing')
    const values=cpuDelta([cpu(10,10),cpu(10,10)],[cpu(40,80),cpu(70,50)]).value!;expect(values[0]).toBeCloseTo(30);expect(values[1]).toBeCloseTo(60)
    expect(cpuDelta([cpu(50,50)],[cpu(1,1)]).status).toBe('missing')
  })
  it('同一 GPU 引擎累加各进程，再取最忙引擎；GPU 内存不误当成百分比',()=>{
    const id='00000000_12345678',h=mergeDxgiHardware(parseWindowsHardware({gpu:[{Name:'Test'}]}),[{id,name:'Test',vendorId:1,deviceId:2,subSysId:1,dedicatedBytes:8*1024**3,sharedBytes:16*1024**3,software:false}],{})
    const prefix='luid_0x00000000_0x12345678_phys_0_',samples=[{name:`pid_1_${prefix}eng_0_engtype_3D`,value:20},{name:`pid_2_${prefix}eng_0_engtype_3D`,value:30},{name:`pid_1_${prefix}eng_1_engtype_VideoEncode`,value:40},{name:`pid_3_${prefix}eng_2_engtype_VideoDecode`,value:0},{name:'pid_1_luid_0x00000000_0x99999999_phys_0_eng_0_engtype_3D',value:99}]
    const result=gpuUsage(h,{engines:samples,dedicated:[{name:prefix.slice(0,-1),value:5*1024**3}],errors:{}})[0]
    expect(result.utilization.value).toBe(50);expect(result.encoder.value).toBe(40);expect(result.decoder.value).toBe(0);expect(result.dedicatedBytes.value).toBe(5*1024**3);expect(result.sharedBytes.status).toBe('missing')
    const missing=gpuUsage(h,{errors:{engines:'驱动计数器不可用'}})[0];expect(missing.utilization.status).toBe('missing');expect(missing.encoder.value).toBeUndefined()
  })
  it('监控同一时刻请求合并，关闭后不再采样',async()=>{
    const monitor=new UsageMonitor(baseHardware)
    const a=monitor.read(),b=monitor.read();expect(a).toBe(b)
    const sample=await a;expect(sample.memory.usedBytes).toBeGreaterThan(0);expect(sample.gpu.status).toBe('missing')
    await monitor.shutdown();await expect(monitor.read()).rejects.toThrow('已关闭')
  })
})
