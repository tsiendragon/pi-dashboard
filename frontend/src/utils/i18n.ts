/**
 * 极简中英文切换：界面语言存在 localStorage，所有组件通过 useLocale() 订阅。
 * 用法：const { tr } = useLocale(); tr('默认模型', 'Default Model')
 * 中文在前、英文在后，就近写在组件里；不引入翻译 key 表，避免两处维护。
 */
import { useCallback, useSyncExternalStore } from 'react'

export type Locale = 'zh' | 'en'

const STORAGE_KEY = 'pi-dashboard:locale'
const listeners = new Set<() => void>()

function read(): Locale {
  return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh'
}

export function setLocale(locale: Locale): void {
  localStorage.setItem(STORAGE_KEY, locale)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) listener() }
  window.addEventListener('storage', onStorage)
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage) }
}

export function useLocale(): { locale: Locale; setLocale: (locale: Locale) => void; tr: (zh: string, en: string) => string } {
  const locale = useSyncExternalStore(subscribe, read, () => 'zh' as Locale)
  const tr = useCallback((zh: string, en: string) => (locale === 'en' ? en : zh), [locale])
  return { locale, setLocale, tr }
}
