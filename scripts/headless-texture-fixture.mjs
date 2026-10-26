import { mkdir,writeFile } from 'node:fs/promises'

/** Hosted runners lack Chromium GPU import. UI/control tests drain native mpv
 * frames without pretending to verify pixels. This file is never packaged.
 * Real GPU/pixel tests must run without this opt-in fixture. */
export async function installHeadlessTextureFixture(desktop) {
  if(process.env.MUXIVRA_HEADLESS_TEXTURE_TEST!=='1')return
  if(process.env.CI!=='true')throw new Error('The headless texture fixture is only for explicitly opted-in CI tests')
  await desktop.evaluate(({sharedTexture})=>{
    if(process.env.MUXIVRA_SMOKE!=='1')throw new Error('Refusing to mock a production player')
    sharedTexture.importSharedTexture=({allReferencesReleased})=>{let released=false;return {release(){if(!released){released=true;allReferencesReleased()}}}}
    sharedTexture.sendSharedTexture=async()=>{}
  })
  await mkdir('artifacts/qa',{recursive:true})
  await writeFile('artifacts/qa/headless-texture-fixture.json',JSON.stringify({headlessReceiverFixture:true,nativeMpvControls:true,chromiumTextureImportTested:false,videoPixelsTested:false,reason:'GitHub hosted Windows runner has no usable Chromium GPU. GPU transport and pixel tests are a separate real-device verification.',realGpuCommands:['npm run smoke:player','npm run smoke:player-composition']},null,2))
}
