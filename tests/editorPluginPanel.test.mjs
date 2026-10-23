import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import { clonePluginChain, pluginDescriptorFormat, pluginDescriptorLabels, pluginSlotMatchesDescriptor } from '../src/utils/editorPlugins.ts'

const component = readFileSync(new URL('../src/components/editor/EditorPluginPanel.vue', import.meta.url), 'utf8')
const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const source = ts.createSourceFile('panel.ts', script, ts.ScriptTarget.Latest, true)
const code = ts.transpileModule(source.statements.filter(item => !ts.isImportDeclaration(item)).map(item => item.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const flush = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)) }
const plugin = id => ({ id, format: 'vst3', pluginId: id, name: id, path: `/${id}.vst3`, bypassed: false })
function environment(t) {
  let releaseCapture
  const capture = new Promise(resolve => { releaseCapture = resolve })
  const props = reactive({ session: { id: 'project', tracks: [], pluginChain: ['a', 'b', 'c'].map(plugin) }, selectedTrackId: null })
  const writes = []
  const context = vm.createContext({
    computed, ref, watch, defineProps: () => props, useI18n: () => ({ t: key => key }),
    useEditorStore: () => ({
      async capturePluginState() { await capture },
      setPluginChain(trackId, chain) { writes.push({ trackId, chain }); props.session.pluginChain = chain },
    }),
    useEditorPlaybackStore: () => ({}), observePluginSession: () => () => {}, onScopeDispose() {}, onMounted() {},
    clonePluginChain, pluginDescriptorFormat, pluginDescriptorLabels, pluginSlotMatchesDescriptor,
  })
  const scope = effectScope()
  scope.run(() => vm.runInContext(code, context))
  t.after(() => scope.stop())
  function trigger(action) {
    context.slot = props.session.pluginChain[1]
    context.index = 1
    const line = component.split('\n').find(line => line.includes(`t('editor.plugins.${action}')`))
    const expression = line.match(action === 'bypass' ? /@update:checked="([^"]+)"/ : /@click="([^"]+)"/)[1]
    const eventCode = ts.transpileModule(`const handler = ${action === 'bypass' ? expression : `() => ${expression}`}; handler`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText
    return vm.runInContext(eventCode, context)(true)
  }
  return { props, writes, trigger, releaseCapture }
}

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
