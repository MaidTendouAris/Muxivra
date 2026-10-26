import { setUiLanguage } from './i18n'
import { searchCues } from './subtitle-operations'
self.onmessage=event=>{try{setUiLanguage(event.data.locale??'zh-CN',[]);self.postMessage({result:searchCues(event.data.cues,event.data.options)})}catch(error){self.postMessage({error:(error as Error).message})}}
