import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MpvIpc } from '../../src/core/player/ipc'
import { playerActionSchema } from '../../src/shared/player-schema'

let server:Server|undefined,client:MpvIpc|undefined
const sockets=new Set<Socket>()
async function connect(receive:(request:any,socket:Socket)=>void){
  const pipe=process.platform==='win32'?`\\\\.\\pipe\\muxivra-unit-${randomUUID()}`:join(tmpdir(),`muxivra-${randomUUID()}.sock`)
  server=createServer(socket=>{sockets.add(socket);socket.setEncoding('utf8');let buffer='';socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);receive(JSON.parse(line),socket)}})})
  await new Promise<void>(resolve=>server!.listen(pipe,resolve));client=new MpvIpc();await client.connect(pipe);return client
}
afterEach(async()=>{client?.close();for(const socket of sockets)socket.destroy();sockets.clear();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;client=undefined})
describe('mpv 有限控制与异步 IPC',()=>{
  it('拆分 JSON 和乱序响应仍关联正确的请求，事件不被吞掉',async()=>{
    const requests:any[]=[],events:any[]=[]
    const ipc=await connect((request,socket)=>{requests.push(request);if(requests.length===2){const payload=JSON.stringify({event:'property-change',name:'pause',data:true})+'\n'+JSON.stringify({request_id:requests[1].request_id,error:'success',data:2})+'\n'+JSON.stringify({request_id:requests[0].request_id,error:'success',data:1})+'\n';socket.write(payload.slice(0,17));setTimeout(()=>socket.write(payload.slice(17)),10)}})
    ipc.on('event',event=>events.push(event))
    expect(await Promise.all([ipc.command(['get_property','pause']),ipc.command(['get_property','speed'])])).toEqual([1,2]);expect(events).toEqual([{event:'property-change',name:'pause',data:true}])
  })
  it('错误响应及超时会拒绝请求，后续请求仍然可用',async()=>{
    const ipc=await connect((request,socket)=>{if(request.command[0]!=='ignore')socket.write(JSON.stringify({request_id:request.request_id,error:request.command[0]==='bad'?'invalid parameter':'success',data:42})+'\n')})
    await expect(ipc.command(['bad'])).rejects.toThrow('invalid parameter');await expect(ipc.command(['ignore'],30)).rejects.toThrow('超时');expect(await ipc.command(['good'])).toBe(42)
  })
  it('断开连接会立即拒绝未完成的命令',async()=>{const ipc=await connect((_request,socket)=>socket.destroy());await expect(ipc.command(['pending'])).rejects.toThrow('已关闭')})
  it('公开动作拒绝原始命令、额外参数、非法范围及非有限数值',()=>{
    for(const value of [{type:'command',command:['run','cmd']},{type:'play',path:'C:\\other.mp4'},{type:'seek',positionMs:-1},{type:'speed',value:Infinity},{type:'volume',value:101},{type:'playlist-play',index:500}])expect(playerActionSchema.safeParse(value).success).toBe(false)
    expect(playerActionSchema.parse({type:'seek',positionMs:1250})).toEqual({type:'seek',positionMs:1250})
  })
})
