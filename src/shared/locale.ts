export type UiLanguage='system'|'zh-CN'|'en'
export type UiLocale='zh-CN'|'en'
/** Follow Windows UI-language preferences, not its region/date formatting. */
export function resolveUiLocale(preference:UiLanguage='system',systemLanguages:readonly string[]=[]):UiLocale{
  if(preference!=='system')return preference
  for(const language of systemLanguages){const tag=language.toLowerCase().replace(/_/g,'-');if(tag==='zh'||tag.startsWith('zh-'))return 'zh-CN';if(tag==='en'||tag.startsWith('en-'))return 'en'}
  return 'en'
}
