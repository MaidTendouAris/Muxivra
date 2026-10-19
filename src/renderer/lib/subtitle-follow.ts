import type { Cue } from '../../shared/types'

export function playingCues(cues:Cue[],timeMs:number):Cue[] {
  return cues.filter(cue=>!cue.comment&&cue.startMs<=timeMs&&timeMs<cue.endMs)
}
