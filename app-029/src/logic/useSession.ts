/**
 * 页面会话：项目读写 + 字体就绪 + 排版/材料/报价的响应式派生。
 * 只做本地计算与本地存储，不发网络请求。
 * 字体状态全站统一说法（projectFontIssue）：不可用时明确「用的是哪份字体、
 * 现在能不能排」，并指向「排版编辑」页更换字体。
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { ensureFont, findFont, fontState, projectFontIssue } from './fontLoader'
import { computeLayout, type LayoutResult } from './layout'
import { buildBom, type BomResult, type BomOptions, type Preset } from './materials'
import { loadPreset, savePreset, saveProject } from './store'
import type { Project } from './types'
import type { ProjectFontStatus } from './fontRegistry'

export interface Session {
  project: Ref<Project | null>
  preset: Ref<Preset>
  autoFit: Ref<boolean>
  fontTick: Ref<number>
  fontText: ComputedRef<string>
  fontOk: ComputedRef<boolean>
  /** 项目字体状态（统一说法；null = 无项目） */
  fontIssue: ComputedRef<ProjectFontStatus | null>
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

  const fontIssue = computed(() => {
    void fontTick.value
    const p = projectRef.value
    if (!p) return null
    return projectFontIssue(p.layout.settings)
  })

  const fontText = computed(() => {
    void fontTick.value
    const p = projectRef.value
    if (!p) return ''
    const issue = projectFontIssue(p.layout.settings)
    if (!issue.ok || !issue.resolvedId) return issue.text
    const st = fontState(issue.resolvedId, p.layout.settings.weight)
    if (st.state === 'error') return `${issue.label}：${st.message}`
    if (st.state === 'loading') return `${issue.label}：${st.message || '正在解析字体…'}`
    if (st.state === 'ready') return issue.text
    return `${issue.label}：尚未加载`
  })

  const fontOk = computed(() => {
    void fontTick.value
    const p = projectRef.value
    if (!p) return false
    const issue = projectFontIssue(p.layout.settings)
    if (!issue.ok || !issue.resolvedId) return false
    return fontState(issue.resolvedId, p.layout.settings.weight).state === 'ready'
  })

  watch(
    () =>
      [
        projectRef.value?.layout.settings.fontId,
        projectRef.value?.layout.settings.weight,
        projectRef.value?.layout.settings.fontFamily
      ] as const,
    async ([fontId, weight, fontFamily]) => {
      if (!fontId || !weight) return
      try {
        await ensureFont(fontId, weight, fontFamily)
      } catch {
        // 解析失败已在 fontState / fontIssue 中给出「该字体不可用」的统一提示
      }
      fontTick.value++
    },
    { immediate: true }
  )

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
    const p = projectRef.value
    if (!p) return
    // 写入字体名称快照：登记条目日后丢失时可按名称找回/回落
    const f = findFont(p.layout.settings.fontId)
    if (f && p.layout.settings.fontFamily !== f.family) p.layout.settings.fontFamily = f.family
    saveProject(p)
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

  return { project: projectRef, preset, autoFit, fontTick, fontText, fontOk, fontIssue, layout, layoutAt, bom, save, savePresetNow, perfMs }
}
