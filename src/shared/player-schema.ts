import { z } from 'zod'

export const playerOwnerSchema = z.enum(['single','subtitles'])

const regionSchema=z.object({x:z.number().finite().min(-32768).max(32768),y:z.number().finite().min(-32768).max(32768),width:z.number().finite().min(0).max(32768),height:z.number().finite().min(0).max(32768)}).strict()
export const playerRectSchema = regionSchema.extend({scale:z.number().finite().min(.25).max(8),visible:z.boolean(),active:z.boolean(),occlusions:z.array(regionSchema).max(32).optional()}).strict()

const simple = ['play','pause','toggle','stop','frame-next','frame-previous','loop-a','loop-b','loop-clear','fullscreen'] as const
export const playerActionSchema = z.discriminatedUnion('type',[
  z.object({type:z.enum(simple)}).strict(),
  z.object({type:z.literal('seek'),positionMs:z.number().finite().min(0).max(359999999)}).strict(),
  z.object({type:z.literal('seek-relative'),offsetMs:z.number().finite().min(-3600000).max(3600000)}).strict(),
  z.object({type:z.literal('speed'),value:z.number().min(.25).max(4)}).strict(),
  z.object({type:z.literal('volume'),value:z.number().min(0).max(100)}).strict(),
  z.object({type:z.literal('mute'),value:z.boolean()}).strict(),
  z.object({type:z.literal('loop'),value:z.enum(['none','file','playlist'])}).strict(),
  z.object({type:z.literal('audio-track'),value:z.union([z.number().int().min(1),z.literal('no'),z.literal('auto')])}).strict(),
  z.object({type:z.literal('subtitle-track'),value:z.union([z.number().int().min(1),z.literal('no'),z.literal('auto')])}).strict(),
  z.object({type:z.literal('audio-delay'),value:z.number().finite().min(-60).max(60)}).strict(),
  z.object({type:z.literal('subtitle-delay'),value:z.number().finite().min(-3600).max(3600)}).strict(),
  z.object({type:z.literal('playlist-play'),index:z.number().int().min(0).max(499)}).strict(),
  z.object({type:z.literal('playlist-remove'),index:z.number().int().min(0).max(499)}).strict()
])

