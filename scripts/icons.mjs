import { mkdir, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i=0;i<8;i++) crc = (crc>>>1)^((crc&1)?0xedb88320:0) } return (crc^0xffffffff)>>>0 }
function chunk(type,data) { const name = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name,data]))); return Buffer.concat([size,name,data,crc]) }
function makeIcon(size) {
  const scan = Buffer.alloc((size*4+1)*size)
  const line = (x,y,ax,ay,bx,by) => { const vx=bx-ax,vy=by-ay,t=Math.max(0,Math.min(1,((x-ax)*vx+(y-ay)*vy)/(vx*vx+vy*vy))); return Math.hypot(x-ax-t*vx,y-ay-t*vy) }
  for (let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const nx=x/size,ny=y/size; const index=y*(size*4+1)+1+x*4
    const edge=Math.max(Math.abs(nx-.5),Math.abs(ny-.5)),corner=Math.hypot(Math.max(0,Math.abs(nx-.5)-.27),Math.max(0,Math.abs(ny-.5)-.27))
    const alpha=edge>.48||corner>.21?0:255
    const dark=Math.min(line(nx,ny,.26,.70,.26,.30),line(nx,ny,.26,.30,.50,.56),line(nx,ny,.50,.56,.74,.30),line(nx,ny,.74,.30,.74,.70))<.045
    scan[index]=dark?35:215; scan[index+1]=dark?41:236; scan[index+2]=dark?25:141; scan[index+3]=alpha
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))])
}
await mkdir('resources',{recursive:true})
await writeFile('resources/icon.png',makeIcon(256))
const sizes=[16,32,48,64,128,256],images=sizes.map(makeIcon),header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4)
let offset=header.length
sizes.forEach((size,i)=>{const entry=6+i*16;header[entry]=size%256;header[entry+1]=size%256;header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);header.writeUInt32LE(images[i].length,entry+8);header.writeUInt32LE(offset,entry+12);offset+=images[i].length})
await writeFile('resources/icon.ico',Buffer.concat([header,...images]))
console.log('Generated Muxivra application icons')
