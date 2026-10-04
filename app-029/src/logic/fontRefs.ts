/**
 * 收集当前所有项目 + 新建项目默认设置对字体的引用。
 * 只直接读 localStorage 的原始数据，不依赖 store.ts（store 依赖本模块的调用方），避免循环依赖。
 * 被引用到的本地字体登记受容量腾退保护：永不自动删除，防止「悄悄把别的项目设置挤掉」。
 */

import { normFamily } from './localFontStore'

const KEY_PROJECTS = 'app029.projects.v1'
const KEY_PREFS = 'app029.prefs.v1'

export interface FontRef {
  /** 引用来源描述（项目名 / 新建默认） */
  from: string
  family: string
  weight: number
}

/** 自带字体 id → 名称（名称是认字体的唯一依据；自带 id 只用于旧数据兼容） */
export const BUILTIN_FAMILY_BY_ID: Record<string, string> = {
  hei: 'Noto Sans SC',
  song: 'Noto Serif SC',
  kai: 'Ma Shan Zheng',
  round: 'ZCOOL QingKe HuangYou',
  art: 'ZCOOL KuaiLe'
}

/** 字体名称 → 自带字体 id（反向解析旧数据用） */
export const BUILTIN_ID_BY_FAMILY: Record<string, string> = Object.fromEntries(
  Object.entries(BUILTIN_FAMILY_BY_ID).map(([id, family]) => [normFamily(family), id])
)

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/**
 * 收集全部字体引用。
 * 优先按字体名称（settings.fontFamily）认；旧项目只有 fontId 时按自带字体表映射；
 * 旧的会话级本地上传 id（local-xxx）已无法解析，返回 family 为空但仍列出，供界面提示。
 */
export function collectFontRefs(): FontRef[] {
  const refs: FontRef[] = []
  const projects = readJson<Array<{ name?: string; layout?: { settings?: { fontId?: string; fontFamily?: string; weight?: number } } }>>(
    KEY_PROJECTS
  )
  for (const p of projects ?? []) {
    const s = p.layout?.settings
    if (!s) continue
    const family = resolveFamilyName(s.fontId, s.fontFamily)
    refs.push({
      from: `项目「${p.name ?? '未命名'}」`,
      family,
      weight: typeof s.weight === 'number' ? s.weight : 400
    })
  }
  const prefs = readJson<{ defaultFontId?: string; defaultFontFamily?: string; defaultWeight?: number }>(KEY_PREFS)
  if (prefs && (prefs.defaultFontId || prefs.defaultFontFamily)) {
    refs.push({
      from: '新建项目默认',
      family: resolveFamilyName(prefs.defaultFontId, prefs.defaultFontFamily),
      weight: typeof prefs.defaultWeight === 'number' ? prefs.defaultWeight : 400
    })
  }
  return refs
}

/** 把任意项目设置解析为规范字体名称（小写压缩）；解析不出返回 '' */
export function resolveFamilyName(fontId?: string, fontFamily?: string): string {
  if (fontFamily && fontFamily.trim()) return normFamily(fontFamily)
  if (fontId && BUILTIN_FAMILY_BY_ID[fontId]) return normFamily(BUILTIN_FAMILY_BY_ID[fontId])
  if (fontId?.startsWith('local:')) {
    // 新版本地字体 id 形如 local:<slug>，其名称以实际登记为准，此处无法还原
    return ''
  }
  return ''
}

/** 受保护（被引用）的本地字体规范名集合 */
export function protectedLocalFamilies(): Set<string> {
  const set = new Set<string>()
  for (const r of collectFontRefs()) {
    if (r.family) set.add(r.family)
  }
  return set
}
