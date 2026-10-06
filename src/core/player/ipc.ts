import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'

export class MpvIpc extends EventEmitter {
  private socket?:Socket
  private sequence=0
  private incoming=''
  private pending=new Map<number,{resolve:(data:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
  async connect(pipe:string,signal?:AbortSignal):Promise<void> {
    const deadline=Date.now()+10000
    while(Date.now()<deadline){
      signal?.throwIfAborted()
      const socket=createConnection(pipe)
      const connected=await new Promise<boolean>(resolve=>{socket.once('connect',()=>resolve(true));socket.once('error',()=>resolve(false))})
      if(connected){
        this.socket=socket;socket.setEncoding('utf8');socket.on('data',chunk=>this.receive(String(chunk)));socket.on('error',error=>this.emit('connection-error',error));socket.on('close',()=>this.closed())
        return
      }
      socket.destroy();await new Promise(resolve=>setTimeout(resolve,50))
    }
    throw new Error('mpv 控制通道连接超时')
  }
  command(command:unknown[],timeout=10000):Promise<any> {
    if(!this.socket||this.socket.destroyed)return Promise.reject(new Error('mpv 尚未就绪'))
    const request_id=++this.sequence
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(request_id);reject(new Error(`mpv 命令超时：${command[0]}`))},timeout)
      this.pending.set(request_id,{resolve,reject,timer})
      this.socket!.write(JSON.stringify({command,request_id})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(request_id);reject(error)}})
    })
  }
  private receive(chunk:string):void {
    this.incoming+=chunk
    if(Buffer.byteLength(this.incoming)>8*1024*1024){this.emit('connection-error',new Error('mpv 响应过大'));this.close();return}
    let newline:number
    while((newline=this.incoming.indexOf('\n'))>=0){
      const line=this.incoming.slice(0,newline);this.incoming=this.incoming.slice(newline+1)
      let message:any
      try {message=JSON.parse(line)} catch {continue}
      if(typeof message.request_id==='number'){
        const request=this.pending.get(message.request_id)
        if(request){clearTimeout(request.timer);this.pending.delete(message.request_id);message.error==='success'?request.resolve(message.data):request.reject(new Error(`mpv：${message.error}`))}
      } else if(message.event)this.emit('event',message)
    }
  }
  private closed():void {for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error('mpv 控制通道已关闭'))}this.pending.clear();this.socket=undefined;this.emit('disconnected')}
  close():void {this.socket?.destroy();this.closed()}
}
