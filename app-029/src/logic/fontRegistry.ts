/**
 * 字库登记与解析的纯逻辑（不依赖 IndexedDB / 网络，可在自检中直接断言）：
 * - 字体身份按「名称」认定：familyKey = 规范化字体家族名；同名冲突不按登记先后，
 *   固定规则为「本机登记（同名字重下最新登记优先） > 随应用自带」，字重严格匹配；
 * - 本机字体被删除/清理后，引用它的项目按同一条名称规则回落，全站统一说法；
 * - 本地字库容量上限与淘汰计划：只清理字体数据（留墓碑），绝不触碰项目/预设等设置。
 */

/** 本机字库总容量上限（超出时按「最久未使用」先腾，登记前明示并需确认） */
export const LOCAL_FONT_QUOTA_BYTES = 40 * 1024 * 1024
/** 单个字体文件上限 */
export const LOCAL_FONT_MAX_FILE_BYTES = 20 * 1024 * 1024

export type FontOrigin = 'builtin' | 'local'
/** ready=可用；evicted=为腾空间被清理（留墓碑）；removed=手动删除（留墓碑） */
export type FontEntryStatus = 'ready' | 'evicted' | 'removed'

export interface FontEntryMeta {
  id: string
  label: string
  family: string
  weights: number[]
  origin: FontOrigin
  status: FontEntryStatus
  /** 授权说明（如 SIL OFL 1.1 / 用户自行确认可商用） */
  license: string
  /** 授权由谁确认（自带字体为「随应用打包」） */
  licenseConfirmedBy: string
  /** 来源（自带=打包说明；本机=上传时的文件名） */
  source: string
  sizeBytes: number
  createdAt: number
  lastUsedAt: number
  removedAt: number | null
  statusNote: string
}

/** 名称键：大小写、空白与常见分隔符不敏感（「Noto Sans SC」=「noto-sans-sc」） */
export function familyKeyOf(name: string): string {
  return name.toLowerCase().replace(/[\s\-_·.]+/g, '')
}

/** 项目侧对字体的引用（fontFamily 为保存时的名称快照，供条目丢失后按名称找回） */
export interface FontRef {
  fontId: string
  weight: number
  fontFamily?: string
}

export type ResolveSource =
  | 'exact' // 命中登记条目本身
  | 'by-name-local' // 按名称使用了本机登记的同名字体
  | 'by-name-builtin' // 本机登记不可用/不存在，按名称回落到随应用自带的同名字体

export interface ResolvedFont {
  /** 实际生效的条目（null = 不可用） */
  entry: FontEntryMeta | null
  /** fontId 直接命中的条目（可能已是墓碑） */
  requested: FontEntryMeta | null
  source: ResolveSource | null
  /** 不可用时的原因（可用时为空串） */
  reason: string
}

/**
 * 按名称解析字体：与条目在列表中的先后无关，固定规则为
 * 「本机登记（同名字重下最新登记优先） > 随应用自带」，字重严格匹配。
 */
export function resolveFontEntry(entries: FontEntryMeta[], ref: FontRef): ResolvedFont {
  const requested = entries.find((e) => e.id === ref.fontId) ?? null
  const key = requested ? familyKeyOf(requested.family) : ref.fontFamily ? familyKeyOf(ref.fontFamily) : null
  if (!key) {
    return {
      entry: null,
      requested,
      source: null,
      reason: `字库中没有该字体的登记，也没有留下字体名称，无法按名称找回`
    }
  }
  const candidates = entries
    .filter((e) => e.status === 'ready' && familyKeyOf(e.family) === key && e.weights.includes(ref.weight))
    .sort((a, b) => {
      if (a.origin !== b.origin) return a.origin === 'local' ? -1 : 1
      return b.createdAt - a.createdAt
    })
  const pick = candidates[0] ?? null
  if (!pick) {
    let reason: string
    if (requested && requested.origin === 'local' && requested.status !== 'ready') {
      reason = `本机登记的字体数据已${requested.status === 'evicted' ? '被清理（为本地字库腾出空间）' : '被删除'}，且字库中没有同名的可用字体`
    } else if (requested) {
      reason = `名称「${requested.family}」下没有字重 ${ref.weight} 的可用字体`
    } else {
      reason = '该字体的登记已不存在，且字库中没有同名的可用字体'
    }
    return { entry: null, requested, source: null, reason }
  }
  const source: ResolveSource =
    requested && pick.id === requested.id ? 'exact' : pick.origin === 'local' ? 'by-name-local' : 'by-name-builtin'
  return { entry: pick, requested, source, reason: '' }
}

/** 项目字体状态（全站统一说法：各页面都从这里取文案，不许各说各话） */
export interface ProjectFontStatus {
  /** 有可用字体（可能经名称回落） */
  ok: boolean
  /** 当前能否排版（= ok；不可用时必须明示并给出更换路径） */
  canLayout: boolean
  /** 生效字体显示名「黑体（Noto Sans SC）」 */
  label: string
  /** 统一说法正文 */
  text: string
  /** 实际生效的登记条目 id */
  resolvedId: string | null
  resolvedOrigin: FontOrigin | null
}

export function describeEntry(e: FontEntryMeta): string {
  return `「${e.label}（${e.family}）」`
}

export function entryOriginText(e: FontEntryMeta): string {
  return e.origin === 'local'
    ? `本机登记，来源 ${e.source}，授权确认：${e.licenseConfirmedBy || '未填写'}`
    : `随应用自带（${e.license}）`
}

export function projectFontStatus(entries: FontEntryMeta[], ref: FontRef): ProjectFontStatus {
  const r = resolveFontEntry(entries, ref)
  const requestedLabel = r.requested ? describeEntry(r.requested) : `「${ref.fontFamily || ref.fontId}」`
  if (!r.entry) {
    const fromText = r.requested ? `（${entryOriginText(r.requested)}）` : ref.fontFamily ? '（原为本机登记字体）' : ''
    return {
      ok: false,
      canLayout: false,
      label: requestedLabel,
      resolvedId: null,
      resolvedOrigin: null,
      text: `本项目使用的字体${requestedLabel}${fromText}不可用：${r.reason}。当前无法排版；请在「排版编辑」页的「字体」一栏改选其他字体。`
    }
  }
  const e = r.entry
  const label = describeEntry(e)
  if (r.source === 'exact') {
    return {
      ok: true,
      canLayout: true,
      label,
      resolvedId: e.id,
      resolvedOrigin: e.origin,
      text: `${label} 字重 ${ref.weight}：${entryOriginText(e)}，可以排版`
    }
  }
  if (r.source === 'by-name-local') {
    return {
      ok: true,
      canLayout: true,
      label,
      resolvedId: e.id,
      resolvedOrigin: e.origin,
      text: `按名称「${e.family}」使用本机登记的同名字体（来源 ${e.source}，授权确认：${e.licenseConfirmedBy || '未填写'}），可以排版`
    }
  }
  const gone =
    r.requested && r.requested.origin === 'local'
      ? `本机登记的${describeEntry(r.requested)}已不可用（${r.requested.statusNote || '数据已删除'}）`
      : '原字体登记已不存在'
  return {
    ok: true,
    canLayout: true,
    label,
    resolvedId: e.id,
    resolvedOrigin: e.origin,
    text: `${gone}，已按名称改用随应用自带的${label}，可以排版`
  }
}

/** 本地字库当前占用（只统计可用的本机登记字体） */
export function localFontUsageBytes(entries: FontEntryMeta[]): number {
  return entries.filter((e) => e.origin === 'local' && e.status === 'ready').reduce((s, e) => s + e.sizeBytes, 0)
}

export interface EvictionPlan {
  /** 需要清理的条目（按「最久未使用」排序，先腾最久没用的） */
  evict: FontEntryMeta[]
  usedBytes: number
  usedAfter: number
  quotaBytes: number
}

/**
 * 淘汰计划：登记 incomingBytes 后若超出 quotaBytes，按 lastUsedAt 升序（最久未使用先腾）
 * 清理本机字体数据，直到放得下；全部腾完仍放不下返回 null（拒绝登记）。
 * 只涉及字体数据本身，不触碰项目/预设/偏好等任何其他设置。
 */
export function planEviction(entries: FontEntryMeta[], incomingBytes: number, quotaBytes: number = LOCAL_FONT_QUOTA_BYTES): EvictionPlan | null {
  const used = localFontUsageBytes(entries)
  if (used + incomingBytes <= quotaBytes) return { evict: [], usedBytes: used, usedAfter: used + incomingBytes, quotaBytes }
  const victims = entries
    .filter((e) => e.origin === 'local' && e.status === 'ready')
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt)
  const evict: FontEntryMeta[] = []
  let freed = 0
  for (const v of victims) {
    if (used - freed + incomingBytes <= quotaBytes) break
    evict.push(v)
    freed += v.sizeBytes
  }
  if (used - freed + incomingBytes > quotaBytes) return null
  return { evict, usedBytes: used, usedAfter: used - freed + incomingBytes, quotaBytes }
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}
