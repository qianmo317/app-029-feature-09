/**
 * 本机持久字库端到端验证（Node + 内存 IndexedDB/localStorage 垫片，真实字体文件）：
 * 1. 上传登记后「刷新」（重新 init）仍在字库、可解析；
 * 2. 登记写清名称/来源/授权确认人/大小；
 * 3. 20MB 上限 + LRU：只腾未引用的，被项目/默认引用的绝不删；腾不出就明确报错；
 * 4. 自带与本地同名按名称认（合并成一条、本地优先但保留自带可顶替），不按先后；
 * 5. 删除本地登记后，引用它的项目按同一名称处理：同名自带可排、两边都没有则明确不可用并给换字体提示。
 *
 * 运行：node scripts/verify-local-fonts.mjs
 */
const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')

// ---------- localStorage 垫片 ----------
const memStore = new Map()
const localStorageShim = `
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null },
  setItem(k, v) { this._m.set(k, String(v)) },
  removeItem(k) { this._m.delete(k) },
  clear() { this._m.clear() }
};`

// ---------- 内存 IndexedDB 垫片（仅实现应用用到的 API） ----------
const idbShim = `
function __installIDB() {
  const databases = new Map();
  globalThis.indexedDB = {
    open(name /*, version */) {
      const req = {};
      let db = databases.get(name);
      const isNew = !db;
      if (isNew) {
        db = { stores: new Map() };
        databases.set(name, db);
      }
      req.result = {
        objectStoreNames: { contains: (n) => db.stores.has(n) },
        createObjectStore(n, opts) {
          const rows = new Map();
          db.stores.set(n, { rows, keyPath: opts.keyPath });
          return { createIndex() {} };
        },
        transaction(names, mode) {
          const list = Array.isArray(names) ? names : [names];
          return {
            objectStore(n) {
              const st = db.stores.get(n);
              const rows = st.rows;
              const req2 = {};
              const done = (fn) => { queueMicrotask(() => { try { fn(); req2.onsuccess && req2.onsuccess({ target: req2 }); } catch (e) { req2.error = e; req2.onerror && req2.onerror({ target: req2 }); } }); return req2; };
              return {
                put(v, key) { return done(() => { rows.set(key ?? v[st.keyPath], structuredClone(v)); req2.result = key ?? v[st.keyPath]; }); },
                get(key) { return done(() => { req2.result = rows.has(key) ? structuredClone(rows.get(key)) : undefined; }); },
                getAll() { return done(() => { req2.result = [...rows.values()].map((v) => structuredClone(v)); }); },
                delete(key) { return done(() => { rows.delete(key); }); },
                add(v, key) { return done(() => { rows.set(key ?? v[st.keyPath], structuredClone(v)); }); }
              };
            }
          };
        }
      };
      queueMicrotask(() => {
        if (isNew && typeof req.onupgradeneeded === 'function') req.onupgradeneeded({ target: req });
        req.onsuccess && req.onsuccess({ target: req });
      });
      return req;
    }
  };
}
__installIDB();`

// ---------- esbuild 打包：把 fontLoader 及其依赖打成单文件，vue 用垫片替换 ----------
const vueShimPlugin = {
  name: 'vue-shim',
  setup(build) {
    build.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', namespace: 'vue-shim' }))
    build.onLoad({ filter: /.*/, namespace: 'vue-shim' }, () => ({
      contents: `
        export function ref(v){ return { value: v } }
        export const shallowRef = ref
        export function computed(fn){ return { get value(){ return fn() } } }
        export function watch(){}
      `,
      loader: 'js'
    }))
  }
}

async function bundle(entry, outName) {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    define: { 'import.meta.env.BASE_URL': '"/"' },
    plugins: [vueShimPlugin]
  })
  const code = localStorageShim + '\n' + idbShim + '\n' + result.outputFiles[0].text
  const out = path.join(__dirname, '..', 'node_modules', outName)
  fs.writeFileSync(out, code)
  return out
}

async function main() {
  // 自带字体在浏览器里走同源静态文件；测试里把 /fonts/* 映射到 public/fonts
  globalThis.fetch = async (url) => {
    const u = String(url)
    const m = u.match(/^\/?(fonts\/.+)$/)
    if (!m) throw new Error('unexpected fetch ' + u)
    const buf = fs.readFileSync(path.join(__dirname, '..', 'public', m[1]))
    return { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
  }

  // fontLoader 单例模块（同时被两个 entry 打包会各持一份注册表，因此统一从 fontLoader bundle 取）
  const out = await bundle('src/logic/fontLoader.ts', '.cache-fontloader.mjs')
  const fl = await import(out)
  // 存储层/引用收集层经 fontLoader 重新导出，避免多实例
  const store = await import(out)
  const refs = await import(out)

  const results = []
  const ok = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail: String(detail) })

  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p))
  const asBuf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)

  // ---------- 1. 初始字库 ----------
  await fl.initFonts()
  ok('初始字库为 5 个自带字体', fl.listFonts().length === 5, fl.listFonts().length)

  // ---------- 2. 同名登记（art 文件 family=ZCOOL KuaiLe，与自带 art 同名） ----------
  const artBytes = asBuf(read('public/fonts/art-400.ttf'))
  const r1 = await fl.registerLocalFont('art-400.ttf', artBytes, {
    source: '本机文件：art-400.ttf',
    licenseConfirmer: '测试员甲 2026-10-04 确认',
    licenseNote: 'SIL OFL 1.1'
  })
  ok('同名上传按名称认：仍是 art 条目，不新增', r1.font.id === 'art' && fl.listFonts().length === 5, r1.font.id)
  const artW = fl.findFont('art').weights.find((w) => w.weight === 400)
  ok('同名同字重本地优先、且保留自带文件用于顶替', artW.origin === 'local' && artW.builtInFile === 'fonts/art-400.ttf', `${artW.origin}/${artW.builtInFile}`)
  ok('登记卡片带来源与授权确认人', r1.font.source.includes('art-400.ttf') && r1.font.licenseConfirmer.includes('测试员甲'))

  // hei 同名
  const heiBytes = asBuf(read('public/fonts/hei-400.otf'))
  const r2 = await fl.registerLocalFont('hei-400.otf', heiBytes, { source: '供应商乙', licenseConfirmer: '测试员乙' })
  ok('hei 同名也不新增条目', r2.font.id === 'hei' && fl.listFonts().length === 5)

  // ---------- 3. 「刷新页面」：重新初始化 ----------
  await fl.initFonts()
  const artAfter = fl.findFont('art')
  ok('刷新后本机登记仍在、元数据保留', artAfter.local && artAfter.licenseConfirmer.includes('测试员甲') && artAfter.weights[0].origin === 'local')
  const rec = await store.getRecord('ZCOOL KuaiLe')
  ok('持久记录含名称/来源/授权确认人/时间/字节大小', !!rec && rec.family === 'ZCOOL KuaiLe' && rec.source && rec.licenseConfirmer && rec.weights[0].size === artBytes.byteLength && rec.weights[0].data instanceof ArrayBuffer)

  // ---------- 4. 引用收集与保护集（按名称） ----------
  localStorage.setItem(
    'app029.projects.v1',
    JSON.stringify([
      { id: 'p1', name: '用黑体', layout: { settings: { fontId: 'hei', fontFamily: 'Noto Sans SC', weight: 400 } } },
      { id: 'p2', name: '旧项目只有自带id', layout: { settings: { fontId: 'art', weight: 400 } } },
      { id: 'p3', name: '用了缺失字', layout: { settings: { fontId: 'local:gone', fontFamily: 'Some Customer Font', weight: 400 } } }
    ])
  )
  localStorage.setItem('app029.prefs.v1', JSON.stringify({ defaultFontId: 'hei', defaultFontFamily: 'Noto Sans SC', defaultWeight: 700 }))
  const allRefs = refs.collectFontRefs()
  ok('引用收集：3 项目 + 1 默认，旧 id 按固定表映射为名称', allRefs.length === 4 && allRefs.find((r) => r.from.includes('旧项目')).family === 'zcool kuaile' && allRefs.find((r) => r.from.includes('用黑体')).family === 'noto sans sc', allRefs.map((r) => `${r.from}:${r.family}`).join(' | '))
  const prot = refs.protectedLocalFamilies()
  ok('被引用名称全部进入保护集', prot.has('noto sans sc') && prot.has('zcool kuaile') && prot.has('some customer font'), [...prot].join(','))

  // ---------- 5. LRU 腾退：两个未引用 + 一次大上传 ----------
  const fake = (family, kb, lastUsedAt) => ({
    family,
    label: family,
    source: 'x',
    licenseConfirmer: 'x',
    licenseNote: '',
    registeredAt: 1,
    weights: [
      { weight: 400, fileName: 'x.ttf', data: new ArrayBuffer(kb * 1024), size: kb * 1024, uploadedAt: 1, lastUsedAt: lastUsedAt ?? 1 }
    ]
  })
  await store.putRecord(fake('LRU Old Unreferenced', 2 * 1024, 100))
  await store.putRecord(fake('LRU New Unreferenced', 2 * 1024, 200))
  const q0 = await store.getQuotaInfo(prot)
  ok('可腾退列表只含未引用登记且按 LRU（最旧在前）', q0.evictable[0].family.includes('Old') && !q0.evictable.some((e) => ['Noto Sans SC', 'ZCOOL KuaiLe'].includes(e.family)), q0.evictable.map((e) => e.family).join('|'))

  const big = fake('Big New Font', 17 * 1024, Date.now())
  const sv = await store.saveRecordWithQuota(big, prot)
  ok('超上限时按 LRU 腾未引用登记、被引用登记不动', sv.evicted.length >= 2 && (await store.getRecord('ZCOOL KuaiLe')) && (await store.getRecord('Noto Sans SC')), sv.evicted.join('|'))
  const q1 = await store.getQuotaInfo(prot)
  ok('腾退后占用不超过 20MB 上限', q1.usedBytes <= q1.quotaBytes, `${(q1.usedBytes / 1048576).toFixed(1)}/${(q1.quotaBytes / 1048576).toFixed(0)}MB`)

  // 腾不出时
  let threw = null
  try {
    await store.saveRecordWithQuota(fake('Huge Rejected', 21 * 1024, 9), new Set(['big new font']))
  } catch (e) {
    threw = e
  }
  ok('无未引用可腾仍超上限 → FontQuotaError 明确拒绝（21MB 单文件本也超单文件上限，这里直接验存储层）', threw?.name === 'FontQuotaError', threw?.name)

  // ---------- 5b. 本地数据损坏：同名自带字明确顶替（fallback）；无同名自带则报错 ----------
  await store.deleteRecord('Big New Font').catch(() => {})
  await fl.registerLocalFont('art-400.ttf', artBytes, { source: 's', licenseConfirmer: 'c' })
  // 5b-1. art 与自带同名：破坏字节后应 fallback 到自带
  {
    const broken = await store.getRecord('ZCOOL KuaiLe')
    broken.weights[0].data = new ArrayBuffer(4) // 截断成无法解析的字节
    await store.putRecord(broken)
    fl.clearRuntimeCache?.()
    const ref = fl.resolveProjectFont({ fontId: 'art', fontFamily: 'ZCOOL KuaiLe', weight: 400 }, '项目「旧项目」')
    let parseErr = null
    let fnt = null
    try {
      fnt = await fl.ensureResolved(ref)
    } catch (e) {
      parseErr = e
    }
    const stFB = fl.fontState('ZCOOL KuaiLe', 400)
    ok(
      '本地数据损坏且有同名自带字 → 能排但状态明确标注 fallback（说明差异+可重传/可换字）',
      !!fnt && !parseErr && stFB.state === 'fallback' && stFB.message.includes('同名自带字体顶替'),
      `${parseErr?.message ?? ''} ${stFB.state}:${stFB.message}`
    )
  }
  // 5b-2. 独有名称（无同名自带）字节损坏 → 必须明确报错，不装作没事
  {
    const good = await store.getRecord('ZCOOL KuaiLe')
    const custom = {
      family: 'Totally Custom Font',
      label: 'Totally Custom Font',
      source: 's',
      licenseConfirmer: 'c',
      licenseNote: '',
      registeredAt: 1,
      weights: good.weights.map((w) => ({ ...w, data: new ArrayBuffer(4), size: 4 }))
    }
    await store.putRecord(custom)
    fl.clearRuntimeCache?.()
    const ref = fl.resolveProjectFont({ fontId: 'local:totally-custom-font', fontFamily: 'Totally Custom Font', weight: 400 }, '项目「x」')
    let e2 = null
    try {
      await fl.ensureResolved(ref)
    } catch (e) {
      e2 = e
    }
    const stC = fl.fontState('Totally Custom Font', 400)
    ok('独有本地字数据损坏且无同名自带 → 明确不可用（不静默）', !!e2 && stC.state === 'error' && stC.message.includes('换成字库'), stC.message)
    await store.deleteRecord('Totally Custom Font')
    // 恢复一份完好的 art 登记，供后续删除测试
    await fl.registerLocalFont('art-400.ttf', artBytes, { source: 's', licenseConfirmer: 'c' })
  }
  // 5b-3. 刷新页面（强制重新从 IndexedDB 装载）：hei 的登记必须仍在
  await fl.reloadFonts()
  {
    const heiAfterReload = await store.getRecord('Noto Sans SC')
    ok('一系列损坏/恢复操作后，被引用的 hei 登记完好无损（不被悄悄挤掉）', !!heiAfterReload && heiAfterReload.weights[0].data.byteLength === heiBytes.byteLength, `bytes=${heiAfterReload?.weights[0].data.byteLength}`)
  }

  // ---------- 6. 删除同名本地登记 → 项目按同一名称处理 ----------
  const del = await fl.removeLocalFont('ZCOOL KuaiLe')
  ok('删除时列出引用该名称的项目', del.referenced && del.references.some((x) => x.from.includes('旧项目')), JSON.stringify(del.references))
  const p2 = fl.resolveProjectFont({ fontId: 'art', weight: 400 }, '项目「旧项目」')
  ok('删除后旧项目仍按名称解析到自带 art（同一种说法，不按上传先后）', !p2.missing && p2.origin === 'built-in' && p2.font.id === 'art', `${p2.missing}/${p2.origin}`)
  const parsed = await fl.ensureResolved(p2)
  ok('顶替后可以排版（真实解析成功，状态 ready 标明自带来源）', !!parsed.unitsPerEm && fl.fontState('ZCOOL KuaiLe', 400).state === 'ready' && fl.fontState('ZCOOL KuaiLe', 400).message.includes('自带'), fl.fontState('ZCOOL KuaiLe', 400).message)

  // ---------- 7. 两边都没有：明确不可用，给换字体提示 ----------
  const p3 = fl.resolveProjectFont({ fontId: 'local:gone', fontFamily: 'Some Customer Font', weight: 400 }, '项目「缺失」')
  ok('名称两边都没有 → missing', p3.missing === true)
  let err = null
  try {
    await fl.ensureResolved(p3)
  } catch (e) {
    err = e
  }
  const st3 = fl.fontState('Some Customer Font', 400)
  ok('取不到字体数据不装作没事：报「该字体不可用/无法排版/换成字库」', !!err && st3.state === 'error' && st3.message.includes('该字体不可用') && st3.message.includes('换成字库'), st3.message)

  // ---------- 8. 本地数据存在时正常可排（ready 标本机来源） ----------
  const heiRef = fl.resolveProjectFont({ fontId: 'hei', fontFamily: 'Noto Sans SC', weight: 400 }, '项目「用黑体」')
  await fl.ensureResolved(heiRef)
  const stHei = fl.fontState('Noto Sans SC', 400)
  ok('同名本地登记数据在 → ready 且标明本机来源', stHei.state === 'ready' && stHei.message.includes('本机上传登记'), stHei.message)

  // ---------- 9. 缺字重也算不可用 ----------
  const p4 = fl.resolveProjectFont({ fontId: 'art', weight: 500 }, '项目「缺字重」')
  ok('引用不存在的字重 → missing', p4.missing === true)

  let fail = 0
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  —— ${r.detail}` : ''}`)
    if (!r.pass) fail++
  }
  console.log(`\n${results.length - fail}/${results.length} passed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
