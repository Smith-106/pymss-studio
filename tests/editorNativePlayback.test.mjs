import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { computed, effectScope, reactive, nextTick, watch } from 'vue'
import { createPinia } from 'pinia'
import { useEditorPlaybackStore } from '../src/stores/editorPlayback.ts'
import { hasEditorPlugins, pluginProjectSignature } from '../src/utils/editorPlugins.ts'
const source = ts.createSourceFile('native.ts', readFileSync(new URL('../src/composables/useEditorNativePlayback.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const code = ts.transpileModule(source.statements.filter(item => !ts.isImportDeclaration(item)).map(item => item.getText(source)).join('\n').replace('export function useEditorNativePlayback', 'function useEditorNativePlayback'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)) }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function environment(t, { ensureGate, statusGate } = {}) {
  const playback = useEditorPlaybackStore(createPinia())
  const editor = reactive({ session: { id: 'project', tracks: [], sources: [], masterVolume: 1, masterPan: 0,
    pluginChain: [{ id: 'slot', format: 'vst3', pluginId: 'gain', name: 'Gain', path: 'gain.vst3', bypassed: false }] } })
  editor.releasePluginSession = async project => { calls.push(['unload', project.id]) }
  const calls = [], timers = new Map(), cleanup = []
  let timerId = 0, position = 0, playing = false
  const create = vm.runInNewContext(`${code}\nuseEditorNativePlayback`, {
    computed, watch, hasEditorPlugins, pluginProjectSignature, useEditorPlaybackStore: () => playback,
    onBeforeUnmount: action => cleanup.push(action),
    setTimeout: action => { timers.set(++timerId, action); return timerId }, clearTimeout: id => timers.delete(id),
    ensurePluginSession: async project => { calls.push(['ensure', project.id]); if (ensureGate) await ensureGate.promise },
    snapshotPluginStates: async project => { calls.push(['snapshot', project.id]); return false },
    unloadPluginSession: async projectId => { calls.push(['unload', projectId]) },
    pluginHostRequest: async request => {
      calls.push([request.op, request.projectId, request])
      if (request.op === 'play') { playing = true; position = request.position }
      if (request.op === 'pause') playing = false
      if (request.op === 'seek') position = request.position
      if (request.op === 'status' && statusGate) return statusGate.promise
      return { projectId: request.projectId, position, playing, duration: 10, masterLevel: [0.5, 0.25] }
    },
  })
  const scope = effectScope()
  const native = scope.run(() => create(editor, () => {}))
  t.after(async () => { cleanup.forEach(action => action()); scope.stop(); await flush(); playback.$dispose() })
  return { native, editor, playback, calls, timers, async poll() { const pending = [...timers.values()]; timers.clear(); await Promise.all(pending.map(action => action())) } }
}

test('native transport sends control messages and applies host meters without PCM', async t => {
  const env = environment(t)
  assert.equal(await env.native.play(2), true)
  assert.equal(env.playback.currentTime, 2)
  assert.deepEqual(env.playback.masterLevel, [0.5, 0.25])
  env.native.seek(4)
  await flush()
  assert.equal(env.playback.currentTime, 4)
  env.native.pause(true)
  await flush()
  assert.equal(env.playback.status, 'paused')
  assert.equal(env.playback.currentTime, 0)
  assert.ok(env.calls.some(call => call[0] === 'play' && call[2].position === 2))
  assert.ok(env.calls.every(call => !call[2] || !('pcm' in call[2])))
})
test('pause cancels pending startup before the old request can start audio', async t => {
  const gate = deferred()
  const env = environment(t, { ensureGate: gate })
  const playing = env.native.play(3)
  env.native.pause()
  gate.resolve()
  assert.equal(await playing, false)
  assert.equal(env.playback.status, 'paused')
  assert.equal(env.calls.filter(call => call[0] === 'play').length, 0)
})
test('a status response from an old request cannot overwrite a newer seek', async t => {
  const gate = deferred()
  const env = environment(t, { statusGate: gate })
  await env.native.play(1)
  const polling = env.poll()
  env.native.seek(7)
  await flush()
  gate.resolve({ projectId: 'project', position: 2, playing: true, duration: 10 })
  await polling
  assert.equal(env.playback.currentTime, 7)
})
test('changing projects discards delayed startup and releases the previous session', async t => {
  const gate = deferred()
  const env = environment(t, { ensureGate: gate })
  const playing = env.native.play(1)
  env.editor.session = { ...env.editor.session, id: 'next' }
  await flush()
  gate.resolve()
  assert.equal(await playing, false)
  assert.ok(env.calls.some(call => call[0] === 'unload' && call[1] === 'project'))
  assert.equal(env.calls.filter(call => call[0] === 'play').length, 0)
})
