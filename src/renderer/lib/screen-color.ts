interface ScreenColorResult { sRGBHex:string }
interface ScreenColorEyeDropper { open(options?:{signal?:AbortSignal}):Promise<ScreenColorResult> }
interface ScreenColorConstructor { new():ScreenColorEyeDropper }

const eyeDropper=()=> (globalThis as typeof globalThis&{EyeDropper?:ScreenColorConstructor}).EyeDropper

export function supportsScreenColor():boolean {return typeof eyeDropper()==='function'}

/** Call from a user-initiated action while transient activation is still active.
 * Only the selected pixel is returned. No screenshot is stored or sent anywhere. */
export function pickScreenColor(signal?:AbortSignal):Promise<string|undefined> {
  if(signal?.aborted)return Promise.resolve(undefined)
  const EyeDropper=eyeDropper()
  if(!EyeDropper)return Promise.reject(new Error('Screen color sampling is unavailable'))
  // Keep this helper synchronous until open(); do not insert IPC or network work.
  return new EyeDropper().open({signal}).then(result=>{
    if(signal?.aborted)return undefined
    if(!/^#[a-f\d]{6}$/i.test(result.sRGBHex))throw new Error('Screen color sampling returned an invalid color')
    return result.sRGBHex.toUpperCase()
  }).catch((error:unknown)=>{
    if(signal?.aborted||(error as {name?:string})?.name==='AbortError')return undefined
    throw error
  })
}
