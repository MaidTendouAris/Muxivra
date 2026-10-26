export interface MediaMetadata {
  path:string
  library:{name:string;version:string}
  tracks:{type:string;fields:Record<string,unknown>}[]
}
