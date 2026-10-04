/**
 * 字库加载、登记与字形缓存。
 *
 * 字体身份只按「名称（family）+ 字重」认，不按加载先后认：
 * - 自带字体（随 public/fonts 打包，断网可用）与用户上传的本地字体同名时，视为同一份；
 * - 项目设置以名称为准（settings.fontFamily）；旧项目只有自带 id 时按固定表映射回名称；
 * - 本地字被删掉后，项目里引用它的地方仍按同一个名称解析：同名自带字还在就明确标注替代来源，
 *   两边都没有才报「该字体不可用」，并在界面提供换成别的字体的入口，绝不静默退化。
 *
 * 本地上传字体的登记与字节数据持久化在本机 IndexedDB（见 localFontStore.ts）：
 * 刷新/重开页面后仍在字库中、可被项目选用、可设为新建默认；有 20MB 上限与 LRU 腾退规则。
 */

import { parse, type Font } from 'opentype.js'
import { ref, shallowRef, type Ref } from 'vue'
import fontsData from '../data/fonts.json'
import { analyzeGlyphPath, type GlyphGeom } from './glyphAnalysis'
import { emptySamples } from './geometry'
import {
  LOCAL_FONT_FILE_LIMIT_BYTES,
  deleteRecord,
  formatBytes,
  getAllRecords,
  getQuotaInfo,
  getRecord,
  normFamily,
  putRecord,
  saveRecordWithQuota,
  touchWeight,
  type FontQuotaError,
  type LocalFontRecord,
  type QuotaInfo
} from './localFontStore'
import { BUILTIN_FAMILY_BY_ID, collectFontRefs, protectedLocalFamilies, resolveFamilyName } from './fontRefs'

/** 本机字体库容量信息（位置/占用/上限/可腾退项），供字库页展示 */
export { getAllRecords, getQuotaInfo, formatBytes, putRecord, saveRecordWithQuota, getRecord, deleteRecord, type QuotaInfo }
/** 字体引用收集（项目 + 新建默认），按名称归一 */
export { collectFontRefs, protectedLocalFamilies }

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

/** 单个字重的来源：自带打包 / 本机上传 */
export type WeightOrigin = 'built-in' | 'local'

export interface RuntimeWeight extends FontWeightDef {
  origin: WeightOrigin
  fileName: string
  /** 本地字重的文件大小（字节），自带字重无 */
  localSize?: number
  /** 本地字重覆盖了同名自带字重时，保留自带文件路径：本地数据取不到时明确顶替，不静默 */
  builtInFile?: string
  builtInSizeKb?: number
}

export interface RuntimeFont {
  id: string
  label: string
  family: string
  feature: string
  license: string
  source: string
  weights: RuntimeWeight[]
  /** 是否含用户上传字重（可能与自带同名，也可能完全独立） */
  local: boolean
  /** 是否全部字重都来自自带打包（同名本地字已登记时为 false） */
  builtIn: boolean
  /** 上传登记的授权由谁确认（无本地字重时为空） */
  licenseConfirmer?: string
  licenseNote?: string
  registeredAt?: number
}

type LoadStateKind = 'idle' | 'loading' | 'ready' | 'fallback' | 'error'

interface LoadState {
  state: LoadStateKind
  message: string
}

export interface RegisterResult {
  font: RuntimeFont
  /** 因容量上限被 LRU 腾退（删除）的登记名 */
  evicted: string[]
  /** 同名同字重是否覆盖了旧登记 */
  replaced: boolean
}

export interface DeleteResult {
  /** 被删登记是否被项目/默认字体引用（引用处会按同名自带字或「不可用」继续处理） */
  referenced: boolean
  references: Array<{ from: string; weight: number }>
}

export interface ResolvedFontRef {
  /** 实际解析到的字体；名称两边都找不到时为 null（项目字体不可用） */
  font: RuntimeFont | null
  weight: number
  /** 该字重字节优先取自哪里 */
  origin: WeightOrigin | null
  /** 项目登记的名称（找不到时为空，例如旧会话级 local-xxx id 无法还原） */
  familyName: string
  /** 项目引用的名称在字库中完全不存在（自带/本地都没有，或旧会话 id 无法解析），或缺该字重 */
  missing: boolean
  /** 引用描述（项目名 / 默认） */
  refFrom: string
}

const builtins: FontFamily[] = fontsData.fonts as FontFamily[]

const localRecords = ref<LocalFontRecord[]>([])
const registry: Ref<RuntimeFont[]> = shallowRef<RuntimeFont[]>([])
const initError = ref('')
let initPromise: Promise<void> | null = null

const fontCache = new Map<string, Font>()
const geomCache = new Map<string, GlyphGeom>()
const loadState = new Map<string, LoadState>()
const inflight = new Map<string, Promise<Font>>()

/** 最近一次 touch 的内存去抖（同名字重 60s 内不重复写 IndexedDB） */
const lastTouch = new Map<string, number>()
const TOUCH_THROTTLE_MS = 60_000

function weightKey(familyName: string, weight: number): string {
  return `${normFamily(familyName)}|${weight}`
}

function familyKeyOf(font: RuntimeFont): string {
  return normFamily(font.family)
}

/** 本地独有字体的稳定 id：同一份字体（同名）每次上传 id 不变，旧项目引用不断 */
function localIdOf(familyName: string): string {
  const slug = familyName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  if (slug) return `local:${slug}`
  let h = 0
  for (let i = 0; i < familyName.length; i++) h = (h * 31 + familyName.charCodeAt(i)) | 0
  return `local:f${(h >>> 0).toString(36)}`
}

/** 把自带字 + IndexedDB 里的本地登记合并成运行时字库（按名称合并，不按先后） */
function rebuildRegistry(): void {
  const byKey = new Map<string, RuntimeFont>()
  // 1) 自带字体先建条目
  for (const b of builtins) {
    byKey.set(normFamily(b.family), {
      id: b.id,
      label: b.label,
      family: b.family,
      feature: b.feature,
      license: b.license,
      source: b.source,
      weights: b.weights.map((w) => ({ ...w, origin: 'built-in' as const, fileName: w.file })),
      local: false,
      builtIn: true
    })
  }
  // 2) 本地登记按名称并入：同名就挂到同一条目上，不同名另立条目
  for (const rec of localRecords.value) {
    const key = normFamily(rec.family)
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        id: localIdOf(rec.family),
        label: rec.label || rec.family,
        family: rec.family,
        feature: '用户上传本机字体',
        license: rec.licenseNote || '授权由用户自行确认',
        source: rec.source,
        weights: [],
        local: true,
        builtIn: false,
        licenseConfirmer: rec.licenseConfirmer,
        licenseNote: rec.licenseNote,
        registeredAt: rec.registeredAt
      }
      byKey.set(key, entry)
    }
    for (const lw of rec.weights) {
      const existing = entry.weights.findIndex((w) => w.weight === lw.weight)
      const builtInAt = entry.builtIn ? builtins.find((b) => normFamily(b.family) === key)?.weights.find((w) => w.weight === lw.weight) : null
      const rw: RuntimeWeight = {
        weight: lw.weight,
        origin: 'local',
        file: `local:${lw.fileName}`,
        fileName: lw.fileName,
        localSize: lw.size,
        // 同名自带字重：留着自带文件，本地数据取不到时明确用它顶替
        builtInFile: builtInAt?.file,
        builtInSizeKb: builtInAt?.fileSizeKb
      }
      // 同名同字重：本地登记优先（按名称认作同一份，来源以用户上传为准）
      if (existing >= 0) entry.weights[existing] = rw
      else entry.weights.push(rw)
    }
    entry.weights.sort((a, b) => a.weight - b.weight)
    entry.local = true
    entry.source = rec.source || entry.source
    entry.licenseConfirmer = rec.licenseConfirmer
    entry.licenseNote = rec.licenseNote
    entry.registeredAt = rec.registeredAt
  }
  registry.value = [...byKey.values()].sort((a, b) => {
    const order = ['hei', 'song', 'kai', 'round', 'art']
    const ai = order.indexOf(a.id)
    const bi = order.indexOf(b.id)
    if (ai === -1 && bi === -1) return a.label.localeCompare(b.label, 'zh-CN')
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

/** 应用启动时调用一次：从本机 IndexedDB 读出持久登记并并入字库 */
export function initFonts(): Promise<void> {
  if (initPromise) return initPromise
  return reloadFonts()
}

/** 测试辅助：强制重新从 IndexedDB 读取登记（模拟刷新页面后的真实重载） */
export function reloadFonts(): Promise<void> {
  initPromise = (async () => {
    try {
      localRecords.value = await getAllRecords()
    } catch (err) {
      // IndexedDB 不可用（隐私模式等）：自带字仍可用，但明确给出本机登记不可用的状态
      localRecords.value = []
      initError.value = err instanceof Error ? err.message : '本机字体库（IndexedDB）不可用'
    }
    rebuildRegistry()
  })()
  return initPromise
}

export function fontStoreError(): string {
  return initError.value
}

export function listFonts(): RuntimeFont[] {
  return registry.value
}

export function findFont(fontId: string): RuntimeFont | null {
  return registry.value.find((f) => f.id === fontId) ?? null
}

/** 按名称找字体（认字体的唯一依据）；名称两边都没有返回 null */
export function findFontByFamily(familyName: string): RuntimeFont | null {
  if (!familyName) return null
  const key = normFamily(familyName)
  return registry.value.find((f) => familyKeyOf(f) === key) ?? null
}

export function fontState(familyName: string, weight: number): LoadState {
  return loadState.get(weightKey(familyName, weight)) ?? { state: 'idle', message: '' }
}

export function hasFont(familyName: string, weight: number): boolean {
  return fontCache.has(weightKey(familyName, weight))
}

function assetUrl(file: string): string {
  const base = import.meta.env.BASE_URL || '/'
  return `${base}${file.replace(/^\//, '')}`
}

/**
 * 解析一份项目（或默认设置）对字体的引用。
 * 以名称为准：settings.fontFamily 优先；旧数据只有自带 id 时按固定表映射回名称。
 * 名称存在但字重不存在也算不可用（明确报缺哪个字重，不静默换字重）。
 */
export function resolveProjectFont(
  settings: { fontId?: string; fontFamily?: string; weight?: number },
  from = '该项目'
): ResolvedFontRef {
  const weight = typeof settings.weight === 'number' ? settings.weight : 400
  const nameKey = settings.fontFamily ? normFamily(settings.fontFamily) : resolveFamilyName(settings.fontId, settings.fontFamily)
  const font = nameKey ? findFontByFamily(nameKey) : null
  const weightDef = font?.weights.find((w) => w.weight === weight) ?? null

  if (!font || !weightDef) {
    return {
      font: font ?? null,
      weight,
      origin: weightDef?.origin ?? null,
      familyName: font?.family ?? settings.fontFamily ?? '',
      missing: true,
      refFrom: from
    }
  }
  return {
    font,
    weight,
    origin: weightDef.origin,
    familyName: font.family,
    missing: false,
    refFrom: from
  }
}

/** 把项目设置归一化为「按名称认」的标准设置（供选中字体后写回，保证刷新后不断） */
export function canonicalSettings(settings: { fontId: string; fontFamily?: string; weight: number }): {
  fontId: string
  fontFamily: string
  weight: number
} {
  const byId = findFont(settings.fontId)
  if (byId && byId.weights.some((w) => w.weight === settings.weight)) {
    return { fontId: byId.id, fontFamily: byId.family, weight: settings.weight }
  }
  // id 已失效（旧本地会话字体）：尽量按名称保住引用
  const byName = settings.fontFamily ? findFontByFamily(settings.fontFamily) : null
  if (byName) {
    const w = byName.weights.find((x) => x.weight === settings.weight) ?? byName.weights[0]
    return { fontId: byName.id, fontFamily: byName.family, weight: w.weight }
  }
  return { fontId: settings.fontId, fontFamily: settings.fontFamily ?? '', weight: settings.weight }
}

/**
 * 加载并解析一个字重；解析失败明确置「该字体不可用」，不做静默退化。
 * familyName 为可选项（旧调用方只给 id）；给了名称就按名称认。
 */
export async function ensureFont(fontId: string, weight: number, familyName?: string): Promise<Font> {
  const resolved = familyName ? resolveProjectFont({ fontId, fontFamily: familyName, weight }) : resolveProjectFont({ fontId, weight })
  return ensureResolved(resolved)
}

/** 加载解析项目引用解析结果对应的字重；本地字缺失但同名自带字在时明确标注「替代来源」 */
export async function ensureResolved(ref: ResolvedFontRef): Promise<Font> {
  if (!ref.font || !ref.origin) {
    const k = weightKey(ref.familyName || ref.font?.family || '未知', ref.weight)
    const reason = !ref.font
      ? ref.familyName
        ? `字库中找不到名为「${ref.familyName}」的字体（自带与本机登记均无）`
        : '引用的是旧版仅会话字体，刷新后登记已失效'
      : `「${ref.font.family}」没有字重 ${ref.weight}（可用字重：${ref.font.weights.map((w) => w.weight).join('/') || '无'}）`
    loadState.set(k, {
      state: 'error',
      message: `该字体不可用：${reason}。${ref.refFrom}当前无法排版，请在下方换成字库中可用的字体。`
    })
    throw new Error('该字体不可用')
  }
  const k = weightKey(ref.font.family, ref.weight)
  const cached = fontCache.get(k)
  if (cached) {
    if (ref.origin === 'local') void touchLocal(ref.font.family, ref.weight)
    return cached
  }
  const running = inflight.get(k)
  if (running) return running
  const wdef = ref.font.weights.find((w) => w.weight === ref.weight)
  if (!wdef) {
    loadState.set(k, { state: 'error', message: `该字体不可用：「${ref.font.family}」没有字重 ${ref.weight}` })
    throw new Error('该字体不可用')
  }
  loadState.set(k, { state: 'loading', message: '正在解析字体…' })
  const p = (async () => {
    let usedFallback = false
    let localErr = ''
    try {
      let font: Font | null = null
      if (wdef.origin === 'local') {
        try {
          // 本地登记优先：读字节 + 解析都在此 try 内——数据不存在或损坏都算「取不到」
          const localBuf = await readLocalBuffer(ref.font!.family, ref.weight)
          font = parse(localBuf) as Font
          if (!font || !font.unitsPerEm) throw new Error('字体解析结果为空')
        } catch (e) {
          // 只有存在同名自带字重才允许顶替；没有就抛出，走不可用提示
          if (!wdef.builtInFile) throw e
          localErr = e instanceof Error ? e.message : String(e)
          font = null
        }
        if (!font) {
          const builtInFile = wdef.builtInFile
          if (!builtInFile) throw new Error('本机登记数据取不到，且无同名自带字可顶替')
          const builtinBuf = await (await fetch(assetUrl(builtInFile))).arrayBuffer()
          font = parse(builtinBuf) as Font
          if (!font || !font.unitsPerEm) throw new Error('同名自带字体也解析失败')
          usedFallback = true
        }
      } else {
        const buf = await (await fetch(assetUrl(wdef.file))).arrayBuffer()
        font = parse(buf) as Font
        if (!font || !font.unitsPerEm) throw new Error('字体解析结果为空')
      }
      fontCache.set(k, font)
      if (usedFallback) {
        loadState.set(k, {
          state: 'fallback',
          message:
            `本机上传登记「${ref.font!.family}」字重 ${ref.weight} 的数据取不到（${localErr}），` +
            `当前以同名自带字体顶替排版；字形可能与上传版本不同，可重新上传该字体，或在下方明确换成别的字体。`
        })
      } else {
        const sourceText = wdef.origin === 'local' ? '本机上传登记' : '自带打包字体'
        loadState.set(k, {
          state: 'ready',
          message: `解析成功：${font.numGlyphs} 个字形（来源：${sourceText}）`
        })
      }
      inflight.delete(k)
      if (wdef.origin === 'local' && !usedFallback) void touchLocal(ref.font!.family, ref.weight)
      return font
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      loadState.set(k, {
        state: 'error',
        message: `该字体不可用：${detail}。${ref.refFrom}当前无法排版，请在下方换成字库中可用的字体。`
      })
      inflight.delete(k)
      throw new Error(`该字体不可用：${detail}`)
    }
  })()
  inflight.set(k, p)
  return p
}

async function touchLocal(familyName: string, weight: number): Promise<void> {
  const k = weightKey(familyName, weight)
  const now = Date.now()
  const last = lastTouch.get(k) ?? 0
  if (now - last < TOUCH_THROTTLE_MS) return
  lastTouch.set(k, now)
  try {
    await touchWeight(familyName, weight, now)
    // 更新内存登记中的 LRU 时间，保证本次会话内腾退判断也准确
    const rec = localRecords.value.find((r) => normFamily(r.family) === normFamily(familyName))
    const w = rec?.weights.find((x) => x.weight === weight)
    if (w) w.lastUsedAt = now
  } catch {
    // LRU 时间写失败不影响排版
  }
}

// 会话内缓存刚上传/已读过的本地字节（真实持久数据在 IndexedDB）
const localBuffers = new Map<string, ArrayBuffer>()

async function readLocalBuffer(familyName: string, weight: number): Promise<ArrayBuffer> {
  const k = weightKey(familyName, weight)
  const mem = localBuffers.get(k)
  if (mem) return mem.slice(0)
  const rec = await getRecord(familyName)
  const w = rec?.weights.find((x) => x.weight === weight)
  if (!rec || !w) {
    throw new Error(`本机登记「${familyName}」字重 ${weight} 的数据已不存在`)
  }
  localBuffers.set(k, w.data)
  return w.data.slice(0)
}

/** 从解析后的字体取字重（OS/2 usWeightClass），取不到按 Regular 400 */
function readWeight(font: Font): number {
  const w = font.tables?.os2?.usWeightClass
  return typeof w === 'number' && w > 0 ? Math.min(900, Math.round(w / 100) * 100) : 400
}

/** 从解析后的字体取名称（fontFamily，优先英文名） */
function readFamily(font: Font, fallbackName: string): string {
  const en = font.names?.fontFamily?.en
  const zh = font.names?.fontFamily?.zh
  const picked = en && en.trim() ? en.trim() : zh && zh.trim() ? zh.trim() : font.familyName || fallbackName
  return picked.replace(/\s+/g, ' ').trim() || fallbackName
}

export interface UploadMeta {
  /** 界面显示名，可空（默认用字体名） */
  label?: string
  /** 来源（文件名/网址/供应商） */
  source: string
  /** 授权由谁确认（必填） */
  licenseConfirmer: string
  /** 授权条款备注 */
  licenseNote?: string
}

/**
 * 登记用户上传的本机字体（长期有效，刷新/重开仍在）。
 * 元数据写清：名称、来源、授权由谁确认；解析失败/超上限都明确报错，绝不装作成功。
 */
export async function registerLocalFont(fileName: string, buffer: ArrayBuffer, meta: UploadMeta): Promise<RegisterResult> {
  if (!meta.licenseConfirmer.trim()) {
    throw new Error('请填写授权由谁确认，再登记该字体')
  }
  if (!meta.source.trim()) {
    throw new Error('请填写字体来源，再登记该字体')
  }
  if (buffer.byteLength > LOCAL_FONT_FILE_LIMIT_BYTES) {
    throw new Error(
      `字体文件 ${formatBytes(buffer.byteLength)} 超过单文件上限 ${formatBytes(LOCAL_FONT_FILE_LIMIT_BYTES)}，不予登记（可先做子集化再上传）`
    )
  }
  let font: Font
  try {
    font = parse(buffer) as Font
  } catch (err) {
    throw new Error(`该字体不可用：文件无法解析（${err instanceof Error ? err.message : String(err)}）`)
  }
  if (!font || !font.unitsPerEm) throw new Error('该字体不可用：无法解析字体数据')
  const fallback = fileName.replace(/\.(ttf|otf)$/i, '')
  const family = readFamily(font, fallback)
  const weight = readWeight(font)

  const now = Date.now()
  const existing = (await getRecord(family)) ?? localRecords.value.find((r) => r.family === family) ?? null
  // 不能用 JSON 深拷贝：ArrayBuffer 会被序列化成 {}
  const record: LocalFontRecord = existing
    ? {
        ...existing,
        weights: existing.weights.map((w) => ({ ...w, data: w.data.slice(0) }))
      }
    : {
        family,
        label: meta.label?.trim() || family,
        source: meta.source.trim(),
        licenseConfirmer: meta.licenseConfirmer.trim(),
        licenseNote: meta.licenseNote?.trim() ?? '',
        registeredAt: now,
        weights: []
      }
  // 元数据以本次登记为准（名称不变——名称取自字体本身）
  record.label = meta.label?.trim() || family
  record.source = meta.source.trim()
  record.licenseConfirmer = meta.licenseConfirmer.trim()
  record.licenseNote = meta.licenseNote?.trim() ?? record.licenseNote
  const wi = record.weights.findIndex((w) => w.weight === weight)
  const replaced = wi >= 0
  const weightRec = {
    weight,
    fileName,
    data: buffer,
    size: buffer.byteLength,
    uploadedAt: wi >= 0 ? record.weights[wi].uploadedAt : now,
    lastUsedAt: now
  }
  if (wi >= 0) record.weights[wi] = weightRec
  else record.weights.push(weightRec)
  record.weights.sort((a, b) => a.weight - b.weight)

  // 腾退只动「没有任何项目/默认引用」的登记，被引用的绝不自动删
  const protectedKeys = protectedLocalFamilies()
  let evicted: string[] = []
  try {
    const r = await saveRecordWithQuota(record, protectedKeys)
    evicted = r.evicted
  } catch (e) {
    const q = e as FontQuotaError
    if (q?.name === 'FontQuotaError') throw new Error(q.message)
    throw e
  }

  localBuffers.set(weightKey(family, weight), buffer)
  // 更新内存登记表：移除被腾退的、并入新的
  localRecords.value = [...localRecords.value.filter((r) => !evicted.includes(r.family) && r.family !== family), record]
  rebuildRegistry()
  const runtime = findFontByFamily(family)
  fontCache.set(weightKey(family, weight), font)
  loadState.set(weightKey(family, weight), { state: 'ready', message: `解析成功：${font.numGlyphs} 个字形（来源：本机上传登记）` })
  if (!runtime) throw new Error('登记后字库中仍找不到该字体')
  return { font: runtime, evicted, replaced }
}

/** 删除一份本地登记（整份，含其全部字重）；自带字体不可删 */
export async function removeLocalFont(family: string): Promise<DeleteResult> {
  const target = findFontByFamily(family)
  if (!target || !target.local) throw new Error('该条目不是本地上传登记，不能删除（自带字体随应用打包）')
  const refs = collectRefsFor(family)
  await deleteRecord(family)
  localRecords.value = localRecords.value.filter((r) => r.family !== family)
  rebuildRegistry()
  for (const w of target.weights) {
    fontCache.delete(weightKey(family, w.weight))
    loadState.delete(weightKey(family, w.weight))
    localBuffers.delete(weightKey(family, w.weight))
  }
  return { referenced: refs.length > 0, references: refs }
}

/** 收集引用了某字体名称的项目/默认（删除后提示用） */
export function collectRefsFor(family: string): Array<{ from: string; weight: number }> {
  const key = normFamily(family)
  const out: Array<{ from: string; weight: number }> = []
  for (const r of collectFontRefs()) {
    if (r.family === key) out.push({ from: r.from, weight: r.weight })
  }
  return out
}

/** 取字形几何（与字号无关，本地单位 1000 em）；字体未加载返回 null */
export function getGlyphGeom(fontId: string, weight: number, char: string, familyName?: string): GlyphGeom | null {
  const family = familyName ?? BUILTIN_FAMILY_BY_ID[fontId] ?? findFont(fontId)?.family ?? fontId
  const k = `${weightKey(family, weight)}|${char}`
  const hit = geomCache.get(k)
  if (hit) return hit
  const font = fontCache.get(weightKey(family, weight))
  if (!font) return null
  const glyph = font.charToGlyph(char)
  if (!glyph || glyph.index === 0) {
    const missing: GlyphGeom = {
      char,
      fontId,
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
  const geom = analyzeGlyphPath(char, fontId, weight, path.commands, glyph.advanceWidth ?? 1000)
  geomCache.set(k, geom)
  return geom
}

/** 清空字形几何缓存（用于性能自检：强制重新解析+分析） */
export function clearGeometryCache(): void {
  geomCache.clear()
}

/** 测试辅助：清掉会话内字体/字节缓存（模拟刷新后重新从 IndexedDB 读取） */
export function clearRuntimeCache(): void {
  fontCache.clear()
  localBuffers.clear()
  loadState.clear()
  inflight.clear()
}

/** 字库就绪后预解析全部字重（失败的字重会各自带「该字体不可用」状态，不影响其他字重） */
export async function preloadAll(onProgress?: (done: number, total: number) => void): Promise<void> {
  await initFonts()
  const tasks: Array<Promise<unknown>> = []
  const all: Array<{ ref: ResolvedFontRef }> = []
  for (const f of listFonts()) {
    for (const w of f.weights) {
      all.push({
        ref: {
          font: f,
          weight: w.weight,
          origin: w.origin,
          familyName: f.family,
          missing: false,
          refFrom: '字库页'
        }
      })
    }
  }
  let done = 0
  for (const item of all) {
    tasks.push(
      ensureResolved(item.ref)
        .catch(() => undefined)
        .finally(() => {
          done++
          onProgress?.(done, all.length)
        })
    )
  }
  await Promise.all(tasks)
}
