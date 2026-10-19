// A display-only clock. Subtitle editing continues to use mpv's actual time.
export class PlaybackClock {
  private anchor?:{position:number;at:number;playing:boolean;speed:number;correction:number}
  sample(position:number,at:number,playing:boolean,speed:number,force=false):void {
    const previous=this.anchor,display=this.position(at)
    if(previous&&!force&&previous.position===position&&previous.playing===playing&&previous.speed===speed)return
    const correction=previous&&playing&&previous.playing&&!force&&previous.speed===speed&&Math.abs(display-position)<250*Math.max(1,speed)?display-position:0
    this.anchor={position,at,playing,speed,correction}
  }
  position(at:number):number {
    const anchor=this.anchor;if(!anchor)return 0
    if(!anchor.playing)return anchor.position
    // Stop extrapolating if mpv stops reporting progress (buffering or a stall).
    const elapsed=Math.max(0,Math.min(250,at-anchor.at))
    return Math.max(0,anchor.position+elapsed*anchor.speed+anchor.correction*Math.max(0,1-elapsed/100))
  }
}
