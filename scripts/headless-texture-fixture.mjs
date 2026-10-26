import { mkdir,writeFile } from 'node:fs/promises'

/** Hosted runners lack Chromium GPU import. UI/control tests drain native mpv
 * frames without pretending to verify pixels. This file is never packaged.
 * Real GPU/pixel tests must run without this opt-in fixture. */
export async function installHeadlessTextureFixture(desktop) {
  if(process.env.MUXIVRA_HEADLESS_TEXTURE_TEST!=='1')return
  if(process.env.CI!=='true')throw new Error('The headless texture fixture is only for explicitly opted-in CI tests')
  await desktop.evaluate(async({app,sharedTexture})=>{
    if(process.env.MUXIVRA_SMOKE!=='1')throw new Error('Refusing to mock a production player')
    // The same hosted runner has no WASAPI output device. Use libmpv's real
    // silent audio output, retaining decoding, selection, timing and control.
    const {createRequire}=process.mainModule.require('node:module'),load=createRequire(app.getAppPath()+'/package.json'),threads=load('node:worker_threads'),BaseWorker=threads.Worker
    threads.Worker=class extends BaseWorker {
      constructor(filename,options){if(options?.workerData?.library&&options.workerData.options)options={...options,workerData:{...options.workerData,options:{...options.workerData.options,ao:'null'}}};super(filename,options)}
    }
    sharedTexture.importSharedTexture=({allReferencesReleased})=>{let released=false;return {release(){if(!released){released=true;allReferencesReleased()}}}}
    sharedTexture.sendSharedTexture=async()=>{}
  })
  await mkdir('artifacts/qa',{recursive:true})
  await writeFile('artifacts/qa/headless-texture-fixture.json',JSON.stringify({headlessReceiverFixture:true,nativeMpvControls:true,audioOutput:'libmpv null (no hosted audio device)',chromiumTextureImportTested:false,videoPixelsTested:false,reason:'GitHub hosted Windows runner has no usable Chromium GPU or speaker device. GPU transport, pixels and audible output require separate real-device verification.',realGpuCommands:['npm run smoke:player','npm run smoke:player-composition']},null,2))
}
