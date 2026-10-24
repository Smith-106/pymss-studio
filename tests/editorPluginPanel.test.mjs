import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { compileTemplate, parse } from 'vue/compiler-sfc'
import { computed, effectScope, nextTick, proxyRefs, reactive, ref, watch } from 'vue'
import { clonePluginChain, pluginDescriptorCategory, pluginDescriptorFormat, pluginDescriptorLabels, pluginDescriptorVariant, pluginSlotMatchesDescriptor } from '../src/utils/editorPlugins.ts'

const component = readFileSync(new URL('../src/components/editor/EditorPluginPanel.vue', import.meta.url), 'utf8')
const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const source = ts.createSourceFile('panel.ts', script, ts.ScriptTarget.Latest, true)
const code = ts.transpileModule(source.statements.filter(item => !ts.isImportDeclaration(item)).map(item => item.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)) }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const plugin = id => ({ id, format: 'vst3', pluginId: id, name: id, path: `/${id}.vst3`, bypassed: false })
function environment(t, { scanControl = false } = {}) {
  const capture = deferred()
  const props = reactive({ session: { id: 'project', tracks: [], pluginChain: ['a', 'b', 'c'].map(plugin) }, selectedTrackId: null })
  const writes = [], calls = [], mounts = [], disposals = [], timers = new Map()
  let timerSequence = 0, stopped = false
  const preferences = new Map()
  const controls = { scanControl, scanStatus: null, statusGate: null, skipGate: null, skipResult: true, cancelResult: true, blacklist: [], blacklistGate: null, directory: null, scanGate: null, editorGate: null, captureGate: capture, report: {
    plugins: [{ ...plugin('library'), id: 'vst3:library', classId: 'vst3:library', vendor: 'Vendor', version: '1', isInstrument: false }],
    failures: [], scanned: 1, cached: 0,
  } }
  const context = vm.createContext({
    PluginHostDialogPendingError: class PluginHostDialogPendingError extends Error {},
    computed, ref, watch, nextTick, defineProps: () => props, useI18n: () => ({ t: key => key, locale: ref('en') }),
    useEditorStore: () => ({
      async capturePluginState(project, force, recovery) { calls.push({ kind: 'capture', project, force, recovery }); await controls.captureGate.promise },
      setPluginChain(trackId, chain) {
        writes.push({ trackId, chain })
        const target = trackId ? props.session.tracks.find(track => track.id === trackId) : props.session
        if (target) target.pluginChain = chain
      },
      scheduleSave() { calls.push({ kind: 'save', project: props.session }) },
    }),
    useEditorPlaybackStore: () => ({}), observePluginSession: () => () => {}, onScopeDispose: callback => disposals.push(callback), onMounted: callback => mounts.push(callback),
    async invoke(command, args) {
      calls.push({ kind: 'invoke', command, args })
      if (command === 'pick_input_folder') return controls.directory
      if (command === 'plugin_host_scan_status') {
        const result = typeof controls.scanStatus === 'function' ? controls.scanStatus(args) : controls.scanStatus
        if (controls.statusGate) await controls.statusGate.promise
        return result
      }
      if (command === 'plugin_host_skip_scan') {
        const skipped = controls.skipResult
        if (controls.skipGate) await controls.skipGate.promise
        return { skipped }
      }
      if (command === 'plugin_host_cancel_scan') return { cancelled: controls.cancelResult }
      if (command === 'plugin_host_scan_blacklist') {
        const entries = [...controls.blacklist]
        if (controls.blacklistGate) await controls.blacklistGate.promise
        return entries
      }
      if (command === 'plugin_host_remove_scan_blacklist') { controls.blacklist = controls.blacklist.filter(entry => entry.path !== args.path); return }
      assert.equal(command, 'plugin_host_scan_report')
      const report = controls.report
      if (controls.scanGate) await controls.scanGate.promise
      return report
    },
    async openPluginEditor(project, slotId, open) {
      calls.push({ kind: 'editor', project, slotId, open })
      if (controls.editorGate) await controls.editorGate.promise
      return { open }
    },
    pluginHostCapabilities: async () => ({ enabled: true, platform: 'windows', formats: ['vst3'], nativeEditor: true, scanControl: controls.scanControl }),
    crypto: { randomUUID: () => 'added-slot' },
    localStorage: { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) },
    window: { addEventListener() {}, removeEventListener() {} },
    setTimeout: callback => { timers.set(++timerSequence, callback); return timerSequence },
    clearTimeout: id => timers.delete(id),
    clonePluginChain, pluginDescriptorCategory, pluginDescriptorFormat, pluginDescriptorLabels, pluginDescriptorVariant, pluginSlotMatchesDescriptor,
  })
  const scope = effectScope()
  scope.run(() => vm.runInContext(code, context))
  const dispose = () => { if (!stopped) { stopped = true; disposals.forEach(callback => callback()); scope.stop() } }
  t.after(dispose)
  const read = name => vm.runInContext(`${name}.value`, context)
  const set = (name, value) => { context.__value = value; vm.runInContext(`${name}.value = __value`, context) }
  const call = (name, ...args) => { context.__args = args; return vm.runInContext(`${name}(...__args)`, context) }
  set('capabilities', { enabled: true, formats: ['vst3'], nativeEditor: true, scanControl })
  function trigger(action) {
    context.slot = props.session.pluginChain[1]
    context.index = 1
    const control = [...component.matchAll(/<n-(button|checkbox)\b[\s\S]*?<\/n-\1>/g)]
      .map(match => match[0]).find(markup => markup.includes(`t('editor.plugins.${action}')`))
    assert.ok(control, `Missing ${action} action`)
    const expression = control.match(action === 'bypass' ? /@update:checked="([^"]+)"/ : /@click="([^"]+)"/)[1]
    const eventCode = ts.transpileModule(`const handler = ${action === 'bypass' ? expression : `() => ${expression}`}; handler`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText
    return vm.runInContext(eventCode, context)(true)
  }
  return { props, writes, calls, controls, preferences, mounts, timers, dispose, read, set, call, trigger, releaseCapture: capture.resolve,
    async tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); await flush() },
    evaluate: expression => vm.runInContext(expression, context),
    buttonDisabled(key) {
      const button = [...component.matchAll(/<n-button\b[\s\S]*?<\/n-button>/g)].map(match => match[0]).find(markup => markup.includes(`t('editor.plugins.${key}')`))
      assert.ok(button, `Missing ${key} button`)
      const expression = button.match(/:disabled="([^"]+)"/)[1]
      context.__render = proxyRefs(vm.runInContext('({busy,scanning,canSkipScan,canStopScan,scanActionPending,scanStopRequested})', context))
      return vm.runInContext(`with (__render) { (${expression}) }`, context)
    },
  }
}

test('catalog searches names, vendors and formats and clears a hidden or unsupported selection', async t => {
  const env = environment(t)
  const plugins = [
    { id: 'gain', name: 'Precision Gain', vendor: 'Audio Tools', path: '/gain.vst3', format: 'vst3' },
    { id: 'echo', name: 'Stereo Echo', vendor: 'Room Audio', path: '/echo.dll', format: 'vst2' },
    { id: 'synth', name: 'Keyboard', vendor: 'Audio Tools', path: '/synth.vst3', format: 'vst3', isInstrument: true },
  ]
  env.set('descriptors', plugins)
  env.set('selectedPluginId', JSON.stringify(['gain', '/gain.vst3']))
  await flush()
  env.set('librarySearch', '  PRECISION ')
  assert.equal(env.read('pluginOptions').length, 1)
  env.set('librarySearch', 'room audio')
  await flush()
  assert.equal(env.read('selectedPluginId'), null)
  assert.equal(env.read('pluginOptions')[0].plugin.id, 'echo')
  assert.equal(env.read('pluginOptions')[0].disabled, true)
  env.set('librarySearch', 'VST3')
  assert.equal(env.read('pluginOptions').length, 2)
  assert.equal(env.read('pluginOptions').find(option => option.plugin.id === 'synth').disabled, true)
  env.set('selectedPluginId', JSON.stringify(['gain', '/gain.vst3']))
  env.set('capabilities', { enabled: true, formats: ['vst2'] })
  await flush()
  assert.equal(env.read('selectedPluginId'), null)
  assert.equal(env.writes.length, 0)
})

test('vendor grouping merges casing and whitespace, sorts names and keeps unknown vendors last', async t => {
  const env = environment(t)
  const plugins = [
    { id: 'late', name: 'Zeta', vendor: ' Vendor ', path: '/zeta.vst3' },
    { id: 'first', name: 'Alpha', vendor: 'vendor', path: '/alpha.vst3' },
    { id: 'unknown', name: 'Unlabelled', vendor: '', path: '/unknown.vst3' },
    { id: 'second', name: 'Other', vendor: 'Another', path: '/other.vst3' },
  ]
  env.set('descriptors', plugins)
  const groups = env.read('catalogGroups')
  assert.deepEqual(Array.from(groups, group => group.key), ['vendor:another', 'vendor:vendor', 'vendor:'])
  assert.deepEqual(Array.from(groups[1].plugins, option => option.plugin.name), ['Alpha', 'Zeta'])
  env.set('selectedPluginId', JSON.stringify(['late', '/zeta.vst3']))
  env.set('catalogGroupBy', 'format')
  await flush()
  assert.equal(env.read('selectedPluginId'), JSON.stringify(['late', '/zeta.vst3']))
  assert.equal(env.read('catalogGroups').length, 1)
  assert.equal(env.read('catalogGroups')[0].label, 'VST3')
  assert.equal(env.writes.length, 0)
})

test('effect groups and category search use reported metadata and never infer types from names', async t => {
  const env = environment(t)
  env.set('descriptors', [
    { id: 'eq', name: 'Channel', vendor: 'Maker', path: '/eq.vst3', category: 'Eq', subCategories: ['Fx', 'EQ'] },
    { id: 'room', name: 'Room', vendor: 'Maker', path: '/room.dll', format: 'vst2', rawCategory: 6 },
    { id: 'unknown', name: 'Magic EQ Reverb Delay', vendor: '', path: '/unknown.vst3' },
  ])
  env.set('catalogGroupBy', 'category')
  assert.deepEqual(Array.from(env.read('catalogGroups'), group => group.key).sort(), ['category:ambience', 'category:eq', 'category:other'])
  assert.equal(env.read('catalogGroups').at(-1).key, 'category:other')
  env.set('selectedPluginId', JSON.stringify(['room', '/room.dll']))
  env.set('librarySearch', 'EQ')
  await flush()
  assert.equal(env.read('selectedPluginId'), null)
  assert.equal(env.read('pluginOptions').length, 2)
  assert.ok(env.read('catalogGroups').every(group => group.plugins.every(option => option.plugin.id !== 'room')))
  assert.equal(env.writes.length, 0)
})

test('relocation resets the search and only offers the same plugin identity and format', async t => {
  const env = environment(t)
  env.set('descriptors', [
    { id: 'a', name: 'Gain', vendor: 'Vendor', path: '/new/a.vst3', format: 'vst3' },
    { id: 'a', name: 'Gain', vendor: 'Vendor', path: '/a.dll', format: 'vst2' },
    { id: 'another', name: 'Gain', vendor: 'Vendor', path: '/another.vst3', format: 'vst3' },
  ])
  env.set('librarySearch', 'previous search')
  env.call('beginRelocation', 'a')
  assert.equal(env.read('librarySearch'), '')
  assert.equal(env.read('pluginOptions').length, 1)
  assert.equal(env.read('pluginOptions')[0].plugin.path, '/new/a.vst3')
  assert.equal(env.writes.length, 0)
})

test('catalog exposes AU versions, shell identities and duplicate locations as visible metadata', t => {
  const env = environment(t)
  env.set('capabilities', { enabled: true, formats: ['vst3', 'vst2', 'au'] })
  env.set('descriptors', [
    { id: 'au:aufx:gain:Test', name: 'Gain', vendor: 'Vendor', path: '/au', format: 'au', auVersion: 2 },
    { id: 'au3:aufx:gain:Test', name: 'Gain', vendor: 'Vendor', path: '/au3', format: 'au', auVersion: 3 },
    { id: 'vst2:one', name: 'Shell Gain', vendor: 'Vendor', path: '/shell.dll', format: 'vst2', isShellChild: true },
    { id: 'vst2:two', name: 'Shell Gain', vendor: 'Vendor', path: '/shell.dll', format: 'vst2', isShellChild: true },
    { id: 'gain', name: 'Gain', vendor: 'Vendor', path: '/first/gain.vst3', format: 'vst3' },
    { id: 'gain', name: 'Gain', vendor: 'Vendor', path: '/second/gain.vst3', format: 'vst3' },
  ])
  const options = env.read('pluginOptions')
  assert.equal(options[0].variant, 'AUv2')
  assert.equal(options[1].variant, 'AUv3')
  assert.equal(options[2].variant, 'VST2 Shell')
  assert.equal(options[2].detail, 'vst2:one')
  assert.equal(options[3].detail, 'vst2:two')
  assert.equal(options[4].detail, 'gain · /first/gain.vst3')
  assert.equal(options[5].detail, 'gain · /second/gain.vst3')
})

test('browsing folders preserves existing paths, ignores cancellation and avoids duplicates', async t => {
  const env = environment(t)
  env.set('directories', ['/existing'])
  env.controls.directory = '/additional'
  await env.call('browseDirectory')
  await env.call('browseDirectory')
  env.controls.directory = null
  await env.call('browseDirectory')
  assert.deepEqual(JSON.parse(JSON.stringify(env.read('directories'))), ['/existing', '/additional'])
  assert.deepEqual(JSON.parse(env.preferences.get('pymss-plugin-library-directories-v1')), ['/existing', '/additional'])
  assert.equal(env.read('directoryDraft'), '')
  assert.equal(env.read('busy'), false)
  assert.equal(env.calls.filter(call => call.command === 'pick_input_folder').length, 3)
  assert.equal(env.calls.filter(call => call.command === 'plugin_host_scan_report').length, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls.filter(call => call.command === 'plugin_host_scan_report')[0].args.paths)), ['/existing', '/additional'])
  assert.equal(env.writes.length, 0)
})

test('empty sources cannot invoke discovery, including a forced retry', async t => {
  const env = environment(t)
  await env.call('scan')
  await env.call('scan', true)
  assert.equal(env.calls.length, 0)
  assert.equal(env.read('scanning'), false)
  assert.equal(env.read('scanReport'), null)
})

test('first launch ignores legacy fixture paths and only restores explicitly selected sources', async t => {
  const env = environment(t)
  env.preferences.set('pymss-vst-lab-search-paths', JSON.stringify(['/old-development-fixtures']))
  await env.mounts[0]()
  assert.equal(env.read('directories').length, 0)
  assert.equal(env.calls.length, 0)
  env.preferences.set('pymss-plugin-library-directories-v1', JSON.stringify(['/chosen', '/chosen', '', 'au:system']))
  await env.mounts[0]()
  assert.deepEqual(JSON.parse(JSON.stringify(env.read('directories'))), ['/chosen'])
  assert.equal(env.calls.length, 0)
  assert.ok(env.preferences.has('pymss-vst-lab-search-paths'))
})

test('source changes discard an in-flight catalog and removing the last source keeps existing effects', async t => {
  const env = environment(t)
  env.set('directories', ['/first'])
  env.controls.scanGate = deferred()
  const scanning = env.call('scan')
  await flush()
  env.set('directories', ['/second'])
  env.controls.scanGate.resolve()
  await scanning
  assert.equal(env.read('scanReport'), null)
  assert.equal(env.read('descriptors').length, 0)
  env.set('descriptors', env.controls.report.plugins)
  env.set('selectedPluginId', JSON.stringify(['vst3:library', '/library.vst3']))
  const before = env.calls.length
  env.call('removeDirectory', 0)
  await flush()
  assert.equal(env.read('directories').length, 0)
  assert.equal(env.read('descriptors').length, 0)
  assert.equal(env.read('selectedPluginId'), null)
  assert.equal(env.calls.length, before)
  assert.deepEqual(env.props.session.pluginChain.map(slot => slot.id), ['a', 'b', 'c'])
  assert.equal(env.writes.length, 0)
})

test('Audio Unit discovery requires an explicit supported source choice', async t => {
  const env = environment(t)
  env.set('capabilities', { enabled: true, platform: 'windows', formats: ['vst3'] })
  await env.call('chooseAudioUnits')
  assert.equal(env.calls.length, 0)
  env.set('capabilities', { enabled: true, platform: 'macos', formats: ['vst3', 'au'] })
  await env.call('chooseAudioUnits')
  await env.call('chooseAudioUnits')
  assert.deepEqual(JSON.parse(JSON.stringify(env.read('directories'))), ['au:system'])
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls[0].args.paths)), ['au:system'])
  assert.equal(env.calls.filter(call => call.command === 'plugin_host_scan_report').length, 2)
})

for (const action of ['bypass', 'remove', 'moveUp']) {
  test(`${action} addresses the selected slot after the chain changes during capture`, async t => {
    const env = environment(t)
    env.trigger(action)
    await flush()
    const [a, b, c] = env.props.session.pluginChain
    env.props.session.pluginChain = [c, a, b]
    env.releaseCapture()
    await flush()
    if (action === 'remove') assert.deepEqual(env.props.session.pluginChain.map(slot => slot.id), ['c', 'a'])
    else if (action === 'moveUp') assert.deepEqual(env.props.session.pluginChain.map(slot => slot.id), ['c', 'b', 'a'])
    else {
      assert.equal(env.props.session.pluginChain.find(slot => slot.id === 'b').bypassed, true)
      assert.ok(env.props.session.pluginChain.filter(slot => slot.id !== 'b').every(slot => !slot.bypassed))
    }
  })

  test(`${action} does not edit a different slot if its target disappears during capture`, async t => {
    const env = environment(t)
    env.trigger(action)
    await flush()
    env.props.session.pluginChain = env.props.session.pluginChain.filter(slot => slot.id !== 'b')
    env.releaseCapture()
    await flush()
    assert.deepEqual(env.props.session.pluginChain.map(slot => slot.id), ['a', 'c'])
    assert.ok(env.props.session.pluginChain.every(slot => !slot.bypassed))
    assert.equal(env.writes.length, 0)
  })
}

test('a chain action cannot cross a project switch during capture', async t => {
  const env = environment(t)
  env.trigger('remove')
  await flush()
  env.props.session = { id: 'next', tracks: [], pluginChain: ['a', 'b', 'c'].map(plugin) }
  env.releaseCapture()
  await flush()
  assert.deepEqual(env.props.session.pluginChain.map(slot => slot.id), ['a', 'b', 'c'])
  assert.equal(env.writes.length, 0)
})

test('closing and reopening the manager preserves its library, paths and target without touching native state', async t => {
  const env = environment(t)
  env.props.session.tracks.push({ id: 'voice', name: 'Voice', pluginChain: [plugin('voice-effect')] })
  env.set('target', 'voice')
  env.set('directories', ['/Library/Audio/Plug-Ins/VST3'])
  env.set('descriptors', env.controls.report.plugins)
  env.set('scanReport', env.controls.report)
  await flush()
  env.call('openManager', 'voice-effect')
  assert.equal(env.read('managerOpen'), true)
  assert.equal(env.read('parameterSlotId'), 'voice-effect')
  env.call('closeManager')
  assert.equal(env.read('managerOpen'), false)
  assert.equal(env.read('parameterSlotId'), 'voice-effect')
  env.call('openManager')
  assert.equal(env.read('managerOpen'), true)
  assert.equal(env.read('target'), 'voice')
  assert.deepEqual(JSON.parse(JSON.stringify(env.read('directories'))), ['/Library/Audio/Plug-Ins/VST3'])
  assert.deepEqual(JSON.parse(JSON.stringify(env.read('descriptors'))), env.controls.report.plugins)
  assert.deepEqual(JSON.parse(JSON.stringify(env.read('scanReport'))), env.controls.report)
  assert.equal(env.calls.length, 0)
  assert.equal(env.writes.length, 0)
})

test('a scan finishing after the manager closes keeps its result for reopening', async t => {
  const env = environment(t)
  env.controls.scanGate = deferred()
  env.set('directories', ['/plugins'])
  env.call('openManager')
  const scanning = env.call('scan', true)
  await flush()
  env.call('closeManager')
  env.controls.scanGate.resolve()
  await scanning
  assert.equal(env.read('managerOpen'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(env.read('descriptors'))), env.controls.report.plugins)
  assert.deepEqual(JSON.parse(JSON.stringify(env.read('scanReport'))), env.controls.report)
  env.call('openManager')
  assert.equal(env.read('descriptors').length, 1)
  assert.equal(env.calls.filter(call => call.command === 'plugin_host_scan_report').length, 1)
  assert.equal(env.calls.some(call => call.kind === 'editor' || call.kind === 'capture'), false)
})

test('a project object replacement closes the manager and discards a late scan for the old project', async t => {
  const env = environment(t)
  env.controls.scanGate = deferred()
  env.call('openManager', 'b')
  env.set('selectedPluginId', 'selected')
  env.set('relocatingSlotId', 'b')
  env.set('directories', ['/plugins'])
  env.set('descriptors', env.controls.report.plugins)
  env.set('scanReport', env.controls.report)
  const scanning = env.call('scan')
  await flush()
  env.props.session = { ...env.props.session, pluginChain: [plugin('next')] }
  await flush()
  assert.equal(env.read('managerOpen'), false)
  assert.equal(env.read('parameterSlotId'), null)
  assert.equal(env.read('selectedPluginId'), null)
  assert.equal(env.read('relocatingSlotId'), null)
  env.controls.scanGate.resolve()
  await scanning
  assert.equal(env.read('descriptors').length, 0)
  assert.equal(env.read('scanReport'), null)
  assert.deepEqual(JSON.parse(JSON.stringify(env.read('directories'))), ['/plugins'])
})

test('changing the target clears generic parameters and deleting the active track falls back to master', async t => {
  const env = environment(t)
  env.props.session.tracks.push({ id: 'voice', name: 'Voice', pluginChain: [plugin('voice-effect')] })
  env.set('target', 'voice')
  await flush()
  env.call('openManager', 'voice-effect')
  env.set('target', 'master')
  await flush()
  assert.equal(env.read('parameterSlotId'), null)
  env.set('target', 'voice')
  await flush()
  env.call('openManager', 'voice-effect')
  env.props.session.tracks = []
  await flush()
  assert.equal(env.read('target'), 'master')
  assert.equal(env.read('parameterSlotId'), null)
  assert.equal(env.writes.length, 0)
})

test('adding a plugin cannot write a removed track after asynchronous state capture', async t => {
  const env = environment(t)
  env.props.session.tracks.push({ id: 'voice', name: 'Voice', pluginChain: [] })
  env.set('target', 'voice')
  await flush()
  env.set('descriptors', env.controls.report.plugins)
  env.set('selectedPluginId', JSON.stringify(['vst3:library', '/library.vst3']))
  const adding = env.call('addPlugin')
  await flush()
  assert.equal(env.calls.filter(call => call.kind === 'capture').length, 1)
  env.props.session.tracks = []
  await flush()
  env.releaseCapture()
  await adding
  assert.equal(env.writes.length, 0)
  assert.deepEqual(env.props.session.pluginChain.map(slot => slot.id), ['a', 'b', 'c'])
})

for (const open of [true, false]) {
  test(`late native editor ${open ? 'open' : 'close'} cannot mutate or save a replacement project`, async t => {
    const env = environment(t)
    env.controls.editorGate = deferred()
    env.releaseCapture()
    env.set('opened', open ? [] : ['b'])
    const previous = env.props.session
    const toggling = env.call('toggleEditor', 'b')
    await flush()
    assert.equal(env.calls.filter(call => call.kind === 'editor').length, 1)
    assert.equal(env.calls[0].project, previous)
    env.props.session = { ...previous, pluginChain: [plugin('next')] }
    await flush()
    env.controls.editorGate.resolve()
    await toggling
    assert.equal(env.read('opened').length, 0)
    assert.equal(env.calls.some(call => call.kind === 'capture' || call.kind === 'save'), false)
    assert.equal(env.writes.length, 0)
  })
}

test('closing a native editor cannot save a replacement project after its state capture completes', async t => {
  const env = environment(t)
  env.set('opened', ['b'])
  const previous = env.props.session
  const closing = env.call('toggleEditor', 'b')
  await flush()
  const captures = env.calls.filter(call => call.kind === 'capture')
  assert.equal(captures.length, 1)
  assert.equal(captures[0].project, previous)
  env.props.session = { ...previous, pluginChain: [plugin('next')] }
  await flush()
  env.releaseCapture()
  await closing
  assert.equal(env.calls.some(call => call.kind === 'save'), false)
  assert.equal(env.read('opened').length, 0)
})

const activeScanStatus = (scanId, path = '/slow.vst3') => ({ scanId, phase: 'scanning', currentPath: path,
  currentName: path.split('/').at(-1), elapsedMs: 3400, completed: 2, total: 7, canSkip: true })

test('controlled scanning starts progress observation before discovery and busy controls remain operable', async t => {
  const env = environment(t, { scanControl: true })
  env.set('directories', ['/plugins'])
  env.controls.scanGate = deferred()
  env.controls.scanStatus = ({ scanId }) => activeScanStatus(scanId)
  const scanning = env.call('scan', true)
  await flush()
  const commands = env.calls.filter(call => call.kind === 'invoke')
  assert.equal(commands[0].command, 'plugin_host_scan_status')
  assert.equal(commands[1].command, 'plugin_host_scan_report')
  assert.equal(commands[0].args.scanId, commands[1].args.scanId)
  assert.equal(commands[1].args.force, true)
  assert.equal(env.read('busy'), true)
  assert.equal(env.read('scanStatus').elapsedMs, 3400)
  assert.equal(env.read('scanStatus').completed, 2)
  assert.equal(env.buttonDisabled('skipScanPlugin'), false)
  assert.equal(env.buttonDisabled('stopScan'), false)
  await env.call('skipCurrentScanPlugin')
  const skipped = env.calls.find(call => call.command === 'plugin_host_skip_scan')
  assert.deepEqual(JSON.parse(JSON.stringify(skipped.args)), { scanId: commands[1].args.scanId, path: '/slow.vst3' })
  await env.call('stopScan')
  assert.equal(env.read('scanStopRequested'), true)
  assert.equal(env.buttonDisabled('skipScanPlugin'), true)
  assert.equal(env.buttonDisabled('stopScan'), true)
  env.controls.report.cancelled = true
  env.controls.scanGate.resolve()
  await scanning
  assert.equal(env.read('busy'), false)
  assert.equal(env.read('scanning'), false)
  assert.equal(env.read('scanReport').cancelled, true)
  assert.equal(env.timers.size, 0)
  assert.equal(env.writes.length, 0)
  assert.deepEqual(env.props.session.pluginChain.map(slot => slot.id), ['a', 'b', 'c'])
})

test('an older backend receives only the original scan call and never the optional controls', async t => {
  const env = environment(t)
  await env.mounts[0]()
  env.set('capabilities', { enabled: true, formats: ['vst3'], nativeEditor: true })
  env.set('directories', ['/plugins'])
  await env.call('scan')
  assert.deepEqual(env.calls.map(call => call.command), ['plugin_host_scan_report'])
  assert.equal('scanId' in env.calls[0].args, false)
  assert.equal(env.timers.size, 0)
})

test('disposing a controlled scan cancels its own identifier and discards late status and results', async t => {
  const env = environment(t, { scanControl: true })
  env.set('directories', ['/plugins'])
  env.controls.scanGate = deferred()
  env.controls.statusGate = deferred()
  env.controls.scanStatus = ({ scanId }) => activeScanStatus(scanId)
  const scanning = env.call('scan')
  await flush()
  const scanId = env.calls.find(call => call.command === 'plugin_host_scan_report').args.scanId
  env.dispose()
  assert.equal(env.read('busy'), false)
  assert.equal(env.timers.size, 0)
  assert.equal(env.calls.find(call => call.command === 'plugin_host_cancel_scan').args.scanId, scanId)
  env.controls.statusGate.resolve()
  env.controls.scanGate.resolve()
  await scanning
  await flush()
  assert.equal(env.read('scanStatus'), null)
  assert.equal(env.read('scanReport'), null)
  assert.equal(env.read('descriptors').length, 0)
  assert.equal(env.timers.size, 0)
  assert.equal(env.calls.filter(call => call.command === 'plugin_host_cancel_scan').length, 1)
  assert.equal(env.writes.length, 0)
})

test('a stale skip targets the displayed plugin path and cannot silently skip the next plugin', async t => {
  const env = environment(t, { scanControl: true })
  env.set('directories', ['/plugins'])
  env.controls.scanGate = deferred()
  env.controls.scanStatus = ({ scanId }) => activeScanStatus(scanId, '/first.vst3')
  const scanning = env.call('scan')
  await flush()
  env.controls.scanStatus = ({ scanId }) => activeScanStatus(scanId, '/next.vst3')
  env.controls.skipResult = false
  await env.call('skipCurrentScanPlugin')
  assert.equal(env.calls.find(call => call.command === 'plugin_host_skip_scan').args.path, '/first.vst3')
  assert.equal(env.read('scanFeedback'), 'editor.plugins.scanPluginAlreadyFinished')
  assert.equal(env.read('scanBlacklist').length, 0)
  await env.tick()
  assert.equal(env.read('scanStatus').currentPath, '/next.vst3')
  assert.equal(env.calls.filter(call => call.command === 'plugin_host_skip_scan').length, 1)
  env.controls.scanGate.resolve()
  await scanning
  assert.equal(env.writes.length, 0)
})

test('a closed manager keeps its controlled scan and library selection state until the report completes', async t => {
  const env = environment(t, { scanControl: true })
  env.props.session.tracks.push({ id: 'voice', name: 'Voice', pluginChain: [plugin('voice-effect')] })
  env.set('target', 'voice')
  env.set('directories', ['/plugins'])
  env.set('catalogGroupBy', 'category')
  env.set('librarySearch', 'Vendor')
  env.controls.scanStatus = ({ scanId }) => activeScanStatus(scanId)
  env.controls.scanGate = deferred()
  env.call('openManager')
  const scanning = env.call('scan')
  await flush()
  env.call('closeManager')
  await env.tick()
  assert.equal(env.read('managerOpen'), false)
  assert.equal(env.read('busy'), true)
  assert.equal(env.calls.filter(call => call.command === 'plugin_host_cancel_scan').length, 0)
  assert.equal(env.calls.filter(call => call.command === 'plugin_host_scan_status').length, 2)
  env.controls.scanGate.resolve()
  await scanning
  assert.equal(env.timers.size, 0)
  env.call('openManager')
  assert.equal(env.read('target'), 'voice')
  assert.equal(env.read('catalogGroupBy'), 'category')
  assert.equal(env.read('librarySearch'), 'Vendor')
  assert.equal(env.read('descriptors').length, 1)
  assert.equal(env.writes.length, 0)
})

test('late status, skip and scan replies cannot clear or overwrite a newer project scan', async t => {
  const env = environment(t, { scanControl: true })
  env.set('directories', ['/plugins'])
  const oldScan = deferred(), oldStatus = deferred(), oldSkip = deferred()
  env.controls.scanGate = oldScan
  env.controls.scanStatus = ({ scanId }) => activeScanStatus(scanId, '/old.vst3')
  const oldRequest = env.call('scan')
  await flush()
  const oldId = env.read('scanStatus').scanId
  env.controls.statusGate = oldStatus
  await env.tick()
  env.controls.skipGate = oldSkip
  const skipping = env.call('skipCurrentScanPlugin')
  await flush()
  env.props.session = { ...env.props.session, id: 'next', pluginChain: [plugin('untouched')] }
  await flush()
  assert.equal(env.calls.find(call => call.command === 'plugin_host_cancel_scan').args.scanId, oldId)
  env.controls.statusGate = null
  env.controls.skipGate = null
  env.controls.scanGate = deferred()
  env.controls.report = { ...env.controls.report, plugins: [{ ...env.controls.report.plugins[0], name: 'New catalog' }] }
  env.controls.scanStatus = ({ scanId }) => activeScanStatus(scanId, '/new.vst3')
  const newRequest = env.call('scan')
  await flush()
  const newId = env.read('scanStatus').scanId
  assert.notEqual(newId, oldId)
  oldStatus.resolve()
  oldSkip.resolve()
  oldScan.resolve()
  await oldRequest
  await skipping
  await flush()
  assert.equal(env.read('busy'), true)
  assert.equal(env.read('scanning'), true)
  assert.equal(env.read('scanStatus').scanId, newId)
  assert.equal(env.read('scanStatus').currentPath, '/new.vst3')
  assert.equal(env.read('scanFeedback'), '')
  assert.equal(env.timers.size, 1)
  env.controls.scanGate.resolve()
  await newRequest
  assert.equal(env.read('descriptors')[0].name, 'New catalog')
  assert.equal(env.timers.size, 0)
  assert.deepEqual(env.props.session.pluginChain.map(slot => slot.id), ['untouched'])
  assert.equal(env.writes.length, 0)
})

test('blacklisted entries survive forced scans and removing one requires an explicit later rescan', async t => {
  const env = environment(t, { scanControl: true })
  const entry = { path: '/blocked.vst3', name: 'Blocked', reason: 'manual', addedAt: 123 }
  env.controls.blacklist = [entry]
  await env.call('refreshBlacklist')
  assert.equal(env.read('scanBlacklist')[0].path, entry.path)
  env.set('directories', ['/plugins'])
  env.controls.report = { ...env.controls.report, blacklisted: [entry], cancelled: false }
  await env.call('scan', true)
  await flush()
  assert.equal(env.read('scanBlacklist').length, 1)
  const report = env.calls.find(call => call.command === 'plugin_host_scan_report')
  assert.equal(report.args.force, true)
  assert.deepEqual(Object.keys(report.args).sort(), ['force', 'paths', 'scanId'])
  await env.call('removeBlacklistedPlugin', entry.path)
  assert.equal(env.read('scanBlacklist').length, 0)
  assert.equal(env.calls.filter(call => call.command === 'plugin_host_scan_report').length, 1)
  assert.equal(env.calls.find(call => call.command === 'plugin_host_remove_scan_blacklist').args.path, entry.path)
  env.controls.report = { ...env.controls.report, blacklisted: [] }
  await env.call('scan')
  assert.equal(env.calls.filter(call => call.command === 'plugin_host_scan_report').length, 2)
  assert.deepEqual(env.props.session.pluginChain.map(slot => slot.id), ['a', 'b', 'c'])
  assert.equal(env.writes.length, 0)
})


test('a delayed blacklist refresh cannot resurrect an entry after the user removes it', async t => {
  const env = environment(t, { scanControl: true })
  const entry = { path: '/blocked.vst3', name: 'Blocked', reason: 'timeout', addedAt: 123 }
  env.controls.blacklist = [entry]
  await env.call('refreshBlacklist')
  env.controls.blacklistGate = deferred()
  const staleRefresh = env.call('refreshBlacklist')
  await flush()
  await env.call('removeBlacklistedPlugin', entry.path)
  env.controls.blacklistGate.resolve()
  await staleRefresh
  assert.equal(env.read('scanBlacklist').length, 0)
  assert.equal(env.calls.filter(call => call.command === 'plugin_host_scan_report').length, 0)
  assert.equal(env.writes.length, 0)
})

test('system Audio Units skips the explicit metadata source rather than claiming a particular component', async t => {
  const env = environment(t, { scanControl: true })
  env.set('capabilities', { enabled: true, platform: 'macos', formats: ['au'], nativeEditor: true, scanControl: true })
  env.set('directories', ['au:system'])
  env.controls.scanGate = deferred()
  env.controls.scanStatus = ({ scanId }) => ({ ...activeScanStatus(scanId, 'au:system'), currentName: 'Audio Units' })
  const scanning = env.call('scan')
  await flush()
  assert.equal(env.call('scanItemName', 'au:system', 'Audio Units'), 'editor.plugins.systemAudioUnits')
  assert.equal(env.call('scanItemName', '/shell.dll', 'Shell Bundle'), 'Shell Bundle')
  await env.call('skipCurrentScanPlugin')
  assert.equal(env.calls.find(call => call.command === 'plugin_host_skip_scan').args.path, 'au:system')
  assert.equal(env.writes.length, 0)
  env.controls.scanGate.resolve()
  await scanning
})

test('scan controls and blacklist preserve a valid accessible component template', () => {
  const parsed = parse(component, { filename: 'EditorPluginPanel.vue' })
  assert.deepEqual(parsed.errors, [])
  const result = compileTemplate({ filename: 'EditorPluginPanel.vue', id: 'scan-controls-test',
    source: parsed.descriptor.template.content, compilerOptions: { expressionPlugins: ['typescript'] } })
  assert.deepEqual(result.errors, [])
})

test('null and terminal scan status cleanly gate controls without completing the pending report early', async t => {
  const env = environment(t, { scanControl: true })
  env.set('directories', ['/plugins'])
  env.controls.scanGate = deferred()
  const scanning = env.call('scan')
  await flush()
  assert.equal(env.buttonDisabled('skipScanPlugin'), true)
  assert.equal(env.buttonDisabled('stopScan'), false)
  await env.call('skipCurrentScanPlugin')
  assert.equal(env.calls.filter(call => call.command === 'plugin_host_skip_scan').length, 0)
  env.controls.scanStatus = ({ scanId }) => ({ ...activeScanStatus(scanId), phase: 'finished', currentPath: null, canSkip: false })
  await env.tick()
  assert.equal(env.read('busy'), true)
  assert.equal(env.timers.size, 0)
  assert.equal(env.buttonDisabled('stopScan'), true)
  env.controls.scanGate.resolve()
  await scanning
  assert.equal(env.read('busy'), false)
  assert.equal(env.timers.size, 0)
})

test('generic parameters stay collapsed until requested and follow slot IDs across reordering', async t => {
  const env = environment(t)
  assert.equal(env.read('parameterSlotId'), null)
  assert.equal(env.read('parameterSlot'), undefined)
  env.trigger('parameters')
  assert.equal(env.read('parameterSlotId'), 'b')
  assert.equal(env.read('parameterSlot').id, 'b')
  env.props.session.pluginChain = [env.props.session.pluginChain[1], env.props.session.pluginChain[0]]
  await flush()
  assert.equal(env.read('parameterSlot').id, 'b')
  env.props.session.pluginChain.splice(0, 1)
  await flush()
  assert.equal(env.read('parameterSlotId'), null)
  assert.equal(env.read('parameterSlot'), undefined)
  env.call('toggleParameters', 'no-longer-present')
  assert.equal(env.read('parameterSlotId'), null)
  assert.equal(env.calls.length, 0)
  assert.equal(env.writes.length, 0)
})

test('source management consumes Escape before the modeless workbench and never cancels background scanning', async t => {
  const env = environment(t, { scanControl: true })
  env.set('directories', ['/plugins'])
  env.controls.scanGate = deferred()
  const scanning = env.call('scan')
  await flush()
  env.call('openManager')
  env.set('sourcesOpen', true)
  let prevented = false, stopped = false
  env.call('onManagerKeyCapture', { key: 'Escape', defaultPrevented: false, preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
  assert.equal(prevented, true)
  assert.equal(stopped, true)
  assert.equal(env.read('sourcesOpen'), false)
  assert.equal(env.read('managerOpen'), true)
  assert.equal(env.read('scanning'), true)
  assert.equal(env.calls.filter(call => call.command === 'plugin_host_cancel_scan').length, 0)
  env.call('closeManager')
  assert.equal(env.read('sourcesOpen'), false)
  assert.equal(env.read('scanning'), true)
  env.controls.scanGate.resolve()
  await scanning
})
