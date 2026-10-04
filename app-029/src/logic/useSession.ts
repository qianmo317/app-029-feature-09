/**
 * 页面会话：项目读写 + 字体就绪 + 排版/材料/报价的响应式派生。
 * 只做本地计算与本地存储，不发网络请求。
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import {
  canonicalSettings,
  ensureResolved,
  findFont,
  findFontByFamily,
  fontState,
  listFonts,
  resolveProjectFont,
  type ResolvedFontRef,
  type RuntimeFont
} from './fontLoader'
import { computeLayout, type LayoutResult } from './layout'
import { buildBom, type BomResult, type BomOptions, type Preset } from './materials'
import { loadPreset, savePreset, saveProject } from './store'
import type { Project } from './types'

export interface Session {
  project: Ref<Project | null>
  preset: Ref<Preset>
  autoFit: Ref<boolean>
  fontTick: Ref<number>
  fontText: ComputedRef<string>
  fontOk: ComputedRef<boolean>
  /** 当前项目字体引用的解析结果（名称、来源、是否缺失） */
  fontRef: ComputedRef<ResolvedFontRef>
  /** 可替换的字体清单（字库中当前可用的字体/字重） */
  replacementFonts: ComputedRef<RuntimeFont[]>
  /** 把项目字体换成字库里另一份（按名称写回，刷新不断） */
  switchFont: (fontId: string, weight: number) => void
  layout: ComputedRef<LayoutResult | null>
  layoutAt: (autoSize: boolean) => LayoutResult | null
  bom: (opts?: BomOptions) => BomResult | null
  save: () => void
  savePresetNow: () => void
  perfMs: Ref<number>
}

export function useSession(projectRef: Ref<Project | null>): Session {
  const preset = ref<Preset>(loadPreset())
  const autoFit = ref(true)
  const fontTick = ref(0)
  const perfMs = ref(0)

  const fontRef = computed<ResolvedFontRef>(() => {
    void fontTick.value
    const p = projectRef.value
    if (!p) {
      return { font: null, weight: 400, origin: null, familyName: '', missing: true, refFrom: '该项目' }
    }
    return resolveProjectFont(p.layout.settings, `项目「${p.name}」`)
  })

  const fontText = computed(() => {
    void fontTick.value
    const p = projectRef.value
    if (!p) return ''
    const ref = resolveProjectFont(p.layout.settings, `项目「${p.name}」`)
    const label = ref.font ? `${ref.font.label}（${ref.font.family}）` : ref.familyName ? `「${ref.familyName}」` : '未知字体'
    const st = fontState(ref.familyName || ref.font?.family || '', ref.weight)
    if (st.state === 'error') return `${label}：${st.message}`
    if (st.state === 'fallback') return `${label}：${st.message}`
    if (st.state === 'loading') return `${label}：${st.message}`
    if (st.state === 'ready') return `${label} 字重 ${ref.weight} · ${st.message}`
    return `${label} 字重 ${ref.weight} · ${ref.missing ? '字体不可用' : '未加载'}`
  })

  const fontOk = computed(() => {
    void fontTick.value
    const p = projectRef.value
    if (!p) return false
    const ref = resolveProjectFont(p.layout.settings, `项目「${p.name}」`)
    if (ref.missing) return false
    // ready/fallback 都能排（fallback 已在提示中说清是同名自带字顶替），error/idle 不能排
    const st = fontState(ref.familyName, ref.weight).state
    return st === 'ready' || st === 'fallback'
  })

  watch(
    () => [projectRef.value?.layout.settings.fontId, projectRef.value?.layout.settings.fontFamily, projectRef.value?.layout.settings.weight] as const,
    async ([fontId, family, weight]) => {
      if (!projectRef.value || weight === undefined) return
      const ref = resolveProjectFont(projectRef.value.layout.settings, `项目「${projectRef.value.name}」`)
      // 归一化旧数据（旧项目只有自带 id）：按名称补全写回，保证后续按名称认
      if (!ref.missing && ref.font && (!family || family !== ref.font.family || fontId !== ref.font.id)) {
        const c = canonicalSettings({ fontId: fontId ?? ref.font.id, fontFamily: family ?? ref.font.family, weight: ref.weight })
        const s = projectRef.value.layout.settings
        if (s.fontId !== c.fontId || s.fontFamily !== c.fontFamily || s.weight !== c.weight) {
          s.fontId = c.fontId
          s.fontFamily = c.fontFamily
          s.weight = c.weight
        }
      }
      try {
        await ensureResolved(ref)
      } catch {
        // 解析失败已在 fontState 中给出「该字体不可用」提示与换字体入口
      }
      fontTick.value++
    },
    { immediate: true }
  )

  const replacementFonts = computed(() => {
    void fontTick.value
    return listFonts()
  })

  function switchFont(fontId: string, weight: number): void {
    const p = projectRef.value
    if (!p) return
    const f = findFont(fontId) ?? findFontByFamily(fontId)
    if (!f) return
    const w = f.weights.find((x) => x.weight === weight) ?? f.weights[0]
    const c = canonicalSettings({ fontId: f.id, fontFamily: f.family, weight: w.weight })
    p.layout.settings.fontId = c.fontId
    p.layout.settings.fontFamily = c.fontFamily
    p.layout.settings.weight = c.weight
    // watcher 会负责解析；这里先主动触发一次，交互更跟手
    void ensureResolved(resolveProjectFont(p.layout.settings, `项目「${p.name}」`)).catch(() => undefined)
    fontTick.value++
  }

  const layoutAt = (autosize: boolean): LayoutResult | null => {
    const p = projectRef.value
    if (!p || !fontOk.value) return null
    const t = performance.now()
    const r = computeLayout(p.layout, { autoSize: autosize })
    perfMs.value = performance.now() - t
    return r
  }

  const layout = computed(() => {
    void fontTick.value
    return layoutAt(autoFit.value)
  })

  const bom = (opts: BomOptions = {}): BomResult | null => {
    const p = projectRef.value
    const lay = layout.value
    if (!p || !lay) return null
    return buildBom(p, lay, preset.value, opts)
  }

  const save = (): void => {
    if (projectRef.value) saveProject(projectRef.value)
  }

  const savePresetNow = (): void => {
    savePreset(preset.value)
  }

  // 项目参数变化即自动保存
  watch(
    () => (projectRef.value ? JSON.stringify(projectRef.value) : ''),
    () => save(),
    { flush: 'post' }
  )

  watch(
    () => preset.value,
    () => savePresetNow(),
    { deep: true }
  )

  return {
    project: projectRef,
    preset,
    autoFit,
    fontTick,
    fontText,
    fontOk,
    fontRef,
    replacementFonts,
    switchFont,
    layout,
    layoutAt,
    bom,
    save,
    savePresetNow,
    perfMs
  }
}