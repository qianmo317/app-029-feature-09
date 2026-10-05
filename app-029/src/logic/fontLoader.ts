/**
 * 本地字库加载与字形缓存。
 * - 自带字体随应用打包（public/fonts），运行时只读取同源静态资源，断网可用；
 * - 本机登记的字体持久化在 IndexedDB（见 fontStore.ts），刷新/重开页面后仍在字库中，
 *   可像自带字体一样被项目选用、可设为新建项目默认字体；
 * - 字体身份按「名称」认定（见 fontRegistry.ts）：同名时本机登记优先于自带，
 *   与登记先后无关；本机字体被删除后按同一条名称规则回落，全站统一说法；
 * - 解析失败必须明确提示「该字体不可用」，不做静默退化。
 */

import { parse, type Font } from 'opentype.js'
import fontsData from '../data/fonts.json'
import { analyzeGlyphPath, type GlyphGeom } from './glyphAnalysis'
import { emptySamples } from './geometry'
import {
  LOCAL_FONT_MAX_FILE_BYTES,
  LOCAL_FONT_QUOTA_BYTES,
  formatBytes,
  localFontUsageBytes,
  planEviction,
  projectFontStatus,
  resolveFontEntry,
  type EvictionPlan,
  type FontEntryMeta,
  type FontEntryStatus,
  type ProjectFontStatus
} from './fontRegistry'
import {
  deleteLocalFontRecord,
  fontStoreAvailable,
  listLocalFontRecords,
  putLocalFontRecord,
  readLocalFontRecord,
  updateLocalFontRecord,
  type LocalFontRecord
} from './fontStore'

export interface FontWeightDef {
  weight: number
  file: string
  fileSizeKb?: number
}

export interface FontFamily {
  id: string
  label: string
  family: string
  feature: string
  weights: FontWeightDef[]
  license: string
  source: string
}

export const FONT_CHARSET_NOTE: string = fontsData.charsetNote

export interface RuntimeFont {
  id: string
  label: string
  family: string
  feature: string
  license: string
  source: string
  weights: FontWeightDef[]
  /** 本机登记的字体（用户上传） */
  local?: boolean
  /** 浏览器存储不可用时的会话级降级（刷新即失效，界面上明示） */
  sessionOnly?: boolean
  /** ready=可用；evicted=为腾空间被清理（留墓碑）；removed=已删除（留墓碑） */
  status: FontEntryStatus
  /** 授权由谁确认 */
  licenseConfirmedBy: string
  sizeBytes: number
  createdAt: number
  lastUsedAt: number
  removedAt: number | null
  statusNote: string
}

interface LoadState {
  state: 'idle' | 'loading' | 'ready' | 'error'
  message: string
}

const registry: RuntimeFont[] = (fontsData.fonts as FontFamily[]).map((f) => ({
  ...f,
  status: 'ready' as FontEntryStatus,
  licenseConfirmedBy: '随应用打包（开源授权）',
  sizeBytes: 0,
  createdAt: 0,
  lastUsedAt: 0,
  removedAt: null,
  statusNote: ''
}))
const extraFonts: RuntimeFont[] = []

const fontCache = new Map<string, Font>()
const geomCache = new Map<string, GlyphGeom>()
const loadState = new Map<string, LoadState>()
const inflight = new Map<string, Promise<Font>>()

function key(fontId: string, weight: number): string {
  return `${fontId}|${weight}`
}

export function listFonts(): RuntimeFont[] {
  return [...registry, ...extraFonts]
}

/** 可用于新项目/可切换选择的字体（不含已删除/已清理的墓碑） */
export function listSelectableFonts(): RuntimeFont[] {
  return listFonts().filter((f) => f.status === 'ready')
}

export function findFont(fontId: string): RuntimeFont | null {
  return listFonts().find((f) => f.id === fontId) ?? null
}

// ---------- 登记元数据 ↔ 纯逻辑层 ----------

function toMeta(f: RuntimeFont): FontEntryMeta {
  return {
    id: f.id,
    label: f.label,
    family: f.family,
    weights: f.weights.map((w) => w.weight),
    origin: f.local ? 'local' : 'builtin',
    status: f.status,
    license: f.license,
    licenseConfirmedBy: f.licenseConfirmedBy,
    source: f.source,
    sizeBytes: f.sizeBytes,
    createdAt: f.createdAt,
    lastUsedAt: f.lastUsedAt,
    removedAt: f.removedAt,
    statusNote: f.statusNote
  }
}

function allMeta(): FontEntryMeta[] {
  return listFonts().map(toMeta)
}

/** 按名称解析（本机登记 > 自带，字重严格匹配，与登记先后无关） */
export function resolveRuntimeFont(fontId: string, weight: number, fontFamily?: string) {
  return resolveFontEntry(allMeta(), { fontId, weight, fontFamily })
}

/** 项目字体状态的统一说法（所有页面共用，不许各说各话） */
export function projectFontIssue(settings: { fontId: string; weight: number; fontFamily?: string }): ProjectFontStatus {
  return projectFontStatus(allMeta(), settings)
}

// ---------- 本机字库的持久化恢复 ----------

let restoreDone = false

function runtimeFromRecord(rec: LocalFontRecord): RuntimeFont {
  return {
    id: rec.id,
    label: rec.label,
    family: rec.family,
    feature: rec.status === 'ready' ? '本机登记字体（已持久保存在本机浏览器，刷新后仍在）' : '本机登记字体（数据已不可用，登记信息保留）',
    license: rec.license,
    source: rec.source,
    weights: rec.weights.map((w) => ({ weight: w, file: `local:${rec.id}` })),
    local: true,
    status: rec.status,
    licenseConfirmedBy: rec.licenseConfirmedBy,
    sizeBytes: rec.sizeBytes,
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt,
    removedAt: rec.removedAt,
    statusNote: rec.statusNote
  }
}

async function restoreLocalFonts(): Promise<void> {
  try {
    const recs = await listLocalFontRecords()
    recs.sort((a, b) => a.createdAt - b.createdAt)
    for (const rec of recs) {
      if (!extraFonts.some((f) => f.id === rec.id)) extraFonts.push(runtimeFromRecord(rec))
    }
  } catch {
    // 存储不可用时保持仅自带字库；上传会降级为会话级并明示
  } finally {
    restoreDone = true
  }
}

/** 本机字库恢复完成（模块加载即开始）；ensureFont 内部会等待它 */
export const localFontsReady: Promise<void> = restoreLocalFonts()

// ---------- 状态查询 ----------

export function fontState(fontId: string, weight: number, fontFamily?: string): LoadState {
  const r = resolveRuntimeFont(fontId, weight, fontFamily)
  if (r.entry) {
    const st = loadState.get(key(r.entry.id, weight))
    if (st) return st
  }
  const direct = loadState.get(key(fontId, weight))
  if (direct) return direct
  if (!restoreDone && fontId.startsWith('local-')) return { state: 'loading', message: '正在恢复本机字库…' }
  if (!r.entry) return { state: 'error', message: r.reason }
  return { state: 'idle', message: '' }
}

export function hasFont(fontId: string, weight: number): boolean {
  const r = resolveRuntimeFont(fontId, weight)
  return !!r.entry && fontCache.has(key(r.entry.id, weight))
}

function assetUrl(file: string): string {
  const base = import.meta.env.BASE_URL || '/'
  return `${base}${file.replace(/^\//, '')}`
}

/** 会话级降级缓冲（浏览器禁用 IndexedDB 时，本机字体仅当前会话可用） */
const sessionBuffers = new Map<string, ArrayBuffer>()

async function readLocalBuffer(id: string): Promise<ArrayBuffer> {
  const s = sessionBuffers.get(id)
  if (s) return s
  const rec = await readLocalFontRecord(id)
  if (rec?.data) return rec.data
  throw new Error('本机字体数据已删除或已被清理，请重新上传或更换字体')
}

const touchedThisSession = new Set<string>()

function touchLastUsed(id: string): void {
  if (touchedThisSession.has(id)) return
  touchedThisSession.add(id)
  const rt = extraFonts.find((x) => x.id === id)
  const now = Date.now()
  if (rt) rt.lastUsedAt = now
  void updateLocalFontRecord(id, { lastUsedAt: now })
}

/** 加载并解析一个字体；按名称解析到实际生效的条目，失败时抛出「该字体不可用」的明确错误 */
export async function ensureFont(fontId: string, weight: number, fontFamily?: string): Promise<Font> {
  await localFontsReady
  const r = resolveRuntimeFont(fontId, weight, fontFamily)
  if (!r.entry) {
    const issue = projectFontIssue({ fontId, weight, fontFamily })
    loadState.set(key(fontId, weight), { state: 'error', message: issue.text })
    throw new Error(issue.text)
  }
  const targetId = r.entry.id
  const k = key(targetId, weight)
  const cached = fontCache.get(k)
  if (cached) return cached
  const running = inflight.get(k)
  if (running) return running
  const family = findFont(targetId)
  if (!family) {
    loadState.set(k, { state: 'error', message: '找不到该字体（字库中无此条目）' })
    throw new Error('找不到该字体')
  }
  const def = family.weights.find((w) => w.weight === weight) ?? family.weights[0]
  if (!def) {
    loadState.set(k, { state: 'error', message: '该字体不可用：没有可用字重' })
    throw new Error('该字体不可用')
  }
  loadState.set(k, { state: 'loading', message: '正在解析字体…' })
  const p = (async () => {
    try {
      const buf = family.local ? await readLocalBuffer(targetId) : await (await fetch(assetUrl(def.file))).arrayBuffer()
      const font = parse(buf) as Font
      if (!font || !font.unitsPerEm) throw new Error('字体解析结果为空')
      fontCache.set(k, font)
      loadState.set(k, { state: 'ready', message: `解析成功：${font.numGlyphs} 个字形` })
      if (family.local && !family.sessionOnly) touchLastUsed(targetId)
      inflight.delete(k)
      return font
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      loadState.set(k, { state: 'error', message: `该字体不可用：${detail}` })
      inflight.delete(k)
      throw new Error(`该字体不可用：${detail}`)
    }
  })()
  inflight.set(k, p)
  return p
}

// ---------- 本机字体的登记 / 删除 / 容量 ----------

export interface RegisterMeta {
  /** 授权说明（谁上传谁负责确认可商用） */
  license: string
  /** 授权确认人（必填） */
  confirmedBy: string
}

export interface RegisterResult {
  font: RuntimeFont
  /** 为腾出空间被清理的字体 id（留墓碑） */
  evicted: string[]
  /** true = 浏览器存储不可用，仅当前会话有效 */
  sessionOnly: boolean
}

export interface LocalFontUsage {
  usedBytes: number
  quotaBytes: number
  maxFileBytes: number
  count: number
  persistAvailable: boolean
}

export function localFontUsage(): LocalFontUsage {
  return {
    usedBytes: localFontUsageBytes(allMeta()),
    quotaBytes: LOCAL_FONT_QUOTA_BYTES,
    maxFileBytes: LOCAL_FONT_MAX_FILE_BYTES,
    count: extraFonts.filter((f) => f.status === 'ready').length,
    persistAvailable: fontStoreAvailable()
  }
}

/** 登记前预览：放不进去时需要清理哪些（最久未使用先腾）；null = 全清了也放不下 */
export function previewEviction(incomingBytes: number): EvictionPlan | null {
  return planEviction(allMeta(), incomingBytes)
}

function invalidateFont(id: string): void {
  for (const k of [...fontCache.keys()]) if (k.startsWith(`${id}|`)) fontCache.delete(k)
  for (const k of [...geomCache.keys()]) if (k.startsWith(`${id}|`)) geomCache.delete(k)
  for (const k of [...loadState.keys()]) if (k.startsWith(`${id}|`)) loadState.delete(k)
  touchedThisSession.delete(id)
}

/**
 * 登记用户上传的字体到本机字库（持久化，刷新后仍在）。
 * - 超过容量时按「最久未使用」清理（需调用方先把 confirmedEvictIds 传进来，不许悄悄清）；
 * - 浏览器存储不可用时降级为会话级，并在结果中明示 sessionOnly。
 */
export async function registerLocalFont(
  name: string,
  buffer: ArrayBuffer,
  meta: RegisterMeta,
  confirmedEvictIds: string[] = []
): Promise<RegisterResult> {
  await localFontsReady
  let font: Font
  try {
    font = parse(buffer) as Font
  } catch {
    throw new Error('该字体不可用：无法解析字体数据')
  }
  if (!font || !font.unitsPerEm) throw new Error('该字体不可用：无法解析字体数据')
  if (buffer.byteLength > LOCAL_FONT_MAX_FILE_BYTES) {
    throw new Error(`单个字体文件不能超过 ${formatBytes(LOCAL_FONT_MAX_FILE_BYTES)}（这份 ${formatBytes(buffer.byteLength)}）`)
  }
  const familyName = font.names?.fontFamily?.en ?? name.replace(/\.(ttf|otf)$/i, '')
  const weight = font.tables?.os2?.usWeightClass ?? 400
  const id = `local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const now = Date.now()
  const label = `${familyName}（本机登记）`
  const evicted: string[] = []

  if (fontStoreAvailable()) {
    const plan = planEviction(allMeta(), buffer.byteLength)
    if (!plan) {
      throw new Error(
        `本地字库空间不足：即使清理全部本机字体（${formatBytes(localFontUsageBytes(allMeta()))}）也放不下这份 ${formatBytes(buffer.byteLength)} 的字体（上限 ${formatBytes(LOCAL_FONT_QUOTA_BYTES)}）`
      )
    }
    const unconfirmed = plan.evict.filter((e) => !confirmedEvictIds.includes(e.id))
    if (unconfirmed.length) {
      throw new Error(`空间不足，需要先清理：${unconfirmed.map((e) => e.label).join('、')}（未经确认，未做任何清理）`)
    }
    for (const e of plan.evict) {
      const note = `为登记「${familyName}」腾出空间，于 ${new Date(now).toLocaleString('zh-CN')} 清理（最久未使用先腾）`
      await updateLocalFontRecord(e.id, { status: 'evicted', data: null, removedAt: now, statusNote: note })
      const rt = extraFonts.find((x) => x.id === e.id)
      if (rt) {
        rt.status = 'evicted'
        rt.removedAt = now
        rt.statusNote = note
      }
      invalidateFont(e.id)
      evicted.push(e.id)
    }
    const rec: LocalFontRecord = {
      id,
      label,
      family: familyName,
      weights: [weight],
      license: meta.license,
      licenseConfirmedBy: meta.confirmedBy,
      source: name,
      sizeBytes: buffer.byteLength,
      createdAt: now,
      lastUsedAt: now,
      status: 'ready',
      removedAt: null,
      statusNote: '',
      data: buffer
    }
    const ok = await putLocalFontRecord(rec)
    if (!ok) {
      // 写入失败不装作已保存：降级为会话级并明示
      sessionBuffers.set(id, buffer)
      const rt = sessionRuntime(id, label, familyName, weight, meta, name, buffer.byteLength, now)
      extraFonts.push(rt)
      fontCache.set(key(id, weight), font)
      loadState.set(key(id, weight), { state: 'ready', message: `解析成功：${font.numGlyphs} 个字形` })
      return { font: rt, evicted, sessionOnly: true }
    }
    const rt = runtimeFromRecord(rec)
    extraFonts.push(rt)
    fontCache.set(key(id, weight), font)
    loadState.set(key(id, weight), { state: 'ready', message: `解析成功：${font.numGlyphs} 个字形` })
    return { font: rt, evicted, sessionOnly: false }
  }

  // 浏览器禁用 IndexedDB：会话级降级（明示，不装作已保存）
  sessionBuffers.set(id, buffer)
  const rt = sessionRuntime(id, label, familyName, weight, meta, name, buffer.byteLength, now)
  extraFonts.push(rt)
  fontCache.set(key(id, weight), font)
  loadState.set(key(id, weight), { state: 'ready', message: `解析成功：${font.numGlyphs} 个字形` })
  return { font: rt, evicted, sessionOnly: true }
}

function sessionRuntime(
  id: string,
  label: string,
  familyName: string,
  weight: number,
  meta: RegisterMeta,
  source: string,
  sizeBytes: number,
  now: number
): RuntimeFont {
  return {
    id,
    label,
    family: familyName,
    feature: '本机登记字体（浏览器存储不可用，仅当前会话有效）',
    license: meta.license,
    source,
    weights: [{ weight, file: `local:${id}` }],
    local: true,
    sessionOnly: true,
    status: 'ready',
    licenseConfirmedBy: meta.confirmedBy,
    sizeBytes,
    createdAt: now,
    lastUsedAt: now,
    removedAt: null,
    statusNote: ''
  }
}

/** 删除本机字体：清掉字体数据、保留墓碑（名称/来源/授权确认人），引用处按名称规则统一处理 */
export async function removeLocalFont(id: string): Promise<void> {
  const rt = extraFonts.find((x) => x.id === id)
  if (!rt) return
  const now = Date.now()
  const note = `于 ${new Date(now).toLocaleString('zh-CN')} 手动删除`
  rt.status = 'removed'
  rt.removedAt = now
  rt.statusNote = note
  invalidateFont(id)
  sessionBuffers.delete(id)
  await updateLocalFontRecord(id, { status: 'removed', data: null, removedAt: now, statusNote: note })
}

/** 彻底清除墓碑登记记录（字体数据此前已清掉） */
export async function purgeLocalFontRecord(id: string): Promise<void> {
  const i = extraFonts.findIndex((x) => x.id === id)
  if (i >= 0) extraFonts.splice(i, 1)
  invalidateFont(id)
  sessionBuffers.delete(id)
  await deleteLocalFontRecord(id)
}

/** 取字形几何（与字号无关，本地单位 1000 em）；字体未加载返回 null */
export function getGlyphGeom(fontId: string, weight: number, char: string): GlyphGeom | null {
  const r = resolveRuntimeFont(fontId, weight)
  const targetId = r.entry?.id ?? fontId
  const k = `${targetId}|${weight}|${char}`
  const hit = geomCache.get(k)
  if (hit) return hit
  const font = fontCache.get(key(targetId, weight))
  if (!font) return null
  const glyph = font.charToGlyph(char)
  if (!glyph || glyph.index === 0) {
    const missing: GlyphGeom = {
      char,
      fontId: targetId,
      weight,
      missing: true,
      blank: false,
      rings: [],
      strokeBlocks: 0,
      strokeBlocksByNesting: 0,
      minStroke: 0,
      minStrokePoint: null,
      bbox: { x0: 0, y0: 0, x1: 0, y1: 0 },
      inkW: 0,
      inkH: 0,
      samples: emptySamples(),
      outerPerimeter: 0,
      blockBBoxes: [],
      pathData: '',
      advance: 0
    }
    geomCache.set(k, missing)
    return missing
  }
  const path = glyph.getPath(0, 0, 1000)
  const geom = analyzeGlyphPath(char, targetId, weight, path.commands, glyph.advanceWidth ?? 1000)
  geomCache.set(k, geom)
  return geom
}

/** 清空字形几何缓存（用于性能自检：强制重新解析+分析） */
export function clearGeometryCache(): void {
  geomCache.clear()
}

export async function preloadAll(onProgress?: (done: number, total: number) => void): Promise<void> {
  const tasks: Array<Promise<unknown>> = []
  const all: Array<{ id: string; weight: number }> = []
  for (const f of listSelectableFonts()) for (const w of f.weights) all.push({ id: f.id, weight: w.weight })
  let done = 0
  for (const t of all) {
    tasks.push(
      ensureFont(t.id, t.weight)
        .catch(() => undefined)
        .finally(() => {
          done++
          onProgress?.(done, all.length)
        })
    )
  }
  await Promise.all(tasks)
}
