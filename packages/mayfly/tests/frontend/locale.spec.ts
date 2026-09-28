import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MayflyLocaleService, interpolateLocaleMessage } from '../../src/frontend/locale.ts'

describe('MayflyLocaleService', () => {
  it('binds dynamic translators with namespace, English, common, and key fallbacks', () => {
    const service = new MayflyLocaleService(new Context(), { systemLocale: 'zh' })
    const disposeCommon = service.register('common', {
      zh: { Cancel: '取消', Shared: '共享' },
      en: { Cancel: 'Cancel', Shared: 'Shared', EnglishOnly: 'English only' },
    })
    const disposePanel = service.register('panel', {
      zh: { Hello: '你好，{name}' },
      en: { Hello: 'Hello, {name}', OwnEnglish: 'Own English' },
    })
    const t = service.bind('panel')
    expect(t('Hello', { name: 'Mayfly' })).toBe('你好，Mayfly')
    expect(t('OwnEnglish')).toBe('Own English')
    expect(t('Shared')).toBe('共享')
    expect(t('EnglishOnly')).toBe('English only')
    expect(t('Missing')).toBe('Missing')
    expect(t('Hello', { missing: 1 })).toBe('你好，{name}')
    expect(interpolateLocaleMessage('Hello, {name}', { name: 'Mayfly' })).toBe('Hello, Mayfly')
    expect(interpolateLocaleMessage('Hello')).toBe('Hello')
    disposePanel(); disposePanel(); disposeCommon(); disposeCommon(); service.dispose(); service.dispose()
  })

  it('revises preference and catalog changes while isolating frontend trees', () => {
    const first = new MayflyLocaleService(new Context(), { systemLocale: 'en' })
    const second = new MayflyLocaleService(new Context(), { systemLocale: 'zh' })
    const seen: string[] = []
    const off = first.subscribe(snapshot => seen.push(`${snapshot.locale}:${snapshot.preference ?? 'system'}:${snapshot.revision}`))
    const dispose = first.register('owner', { zh: { Value: '值' }, en: { Value: 'Value' } })
    expect(first.setPreference('zh')).toBe(true)
    expect(first.setPreference('zh')).toBe(false)
    expect(first.setPreference(undefined)).toBe(true)
    dispose()
    expect(first.locale).toBe('en')
    expect(second.locale).toBe('zh')
    expect(seen).toEqual(['en:system:0', 'en:system:1', 'zh:zh:2', 'en:system:3', 'en:system:4'])
    off(); first.setPreference('zh'); expect(seen).toHaveLength(5)
    first.dispose(); second.dispose()
  })

  it('shares an equivalent namespace by reference count', () => {
    const service = new MayflyLocaleService(new Context(), { systemLocale: 'zh' })
    const seen: number[] = []
    const off = service.subscribe(snapshot => seen.push(snapshot.revision))
    const first = service.register('shared', { zh: { Hello: '你好' }, en: { Hello: 'Hello' } })
    const second = service.register('shared', { zh: { Hello: '你好' }, en: { Hello: 'Hello' } })
    expect(service.translate('shared', 'Hello')).toBe('你好')
    first()
    first()
    expect(service.translate('shared', 'Hello')).toBe('你好')
    second()
    expect(service.translate('shared', 'Hello')).toBe('Hello')
    expect(seen).toEqual([0, 1, 2])
    off()
    service.dispose()
  })

  it('rejects conflicting catalogs for a live namespace', () => {
    const service = new MayflyLocaleService(new Context())
    const dispose = service.register('owner', { zh: {}, en: { Value: 'value' } })
    expect(() => service.register('owner', { zh: {}, en: { Value: 'other' } })).toThrow(/already registered/u)
    expect(() => service.register('owner', { zh: { Extra: 'x' }, en: { Value: 'value' } })).toThrow(/already registered/u)
    expect(() => service.register('owner', { zh: {}, en: { Value: 'value', Extra: 'x' } })).toThrow(/already registered/u)
    expect(() => service.register('owner', { zh: { Value: '值' }, en: { Value: 'value' } })).toThrow(/already registered/u)
    dispose()
    service.dispose()
  })

  it('rejects late namespaces and makes retained handles inert', () => {
    const service = new MayflyLocaleService(new Context())
    const catalog = { zh: {}, en: { Value: 'value' } }
    const dispose = service.register('owner', catalog)
    expect(service.translate('owner', 'Value')).toBe('value')
    service.dispose()
    expect(service.setPreference('zh')).toBe(false)
    const off = service.subscribe(() => { throw new Error('should not run') })
    expect(off).toBeTypeOf('function')
    off()
    expect(() => service.register('late', catalog)).toThrow(/disposed/u)
    dispose()
    expect(service.translate('owner', 'Value')).toBe('Value')
  })
})
