import { translateUi } from '../../shared/i18n'
import { resolveUiLocale,type UiLanguage,type UiLocale } from '../../shared/locale'
let locale:UiLocale=resolveUiLocale(typeof navigator==='undefined'?'zh-CN':'system',typeof navigator==='undefined'?[]:navigator.languages)
export function setUiLanguage(preference:UiLanguage,systemLanguages:readonly string[]){locale=resolveUiLocale(preference,systemLanguages);return locale}
export function uiLocale(){return locale}
/** Only call for UI strings. Media, subtitle text, paths, model output and logs stay verbatim. */
export function tr(key:string,...values:unknown[]):string
export function tr(key:string|undefined,...values:unknown[]):string|undefined
export function tr(key:string|number,...values:unknown[]):string|number
export function tr(key:string|number|undefined,...values:unknown[]):string|number|undefined{
  if(typeof key!=='string')return key
  return translateUi(key,locale,...values)
}
