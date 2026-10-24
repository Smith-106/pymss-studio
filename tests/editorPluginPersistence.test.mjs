import assert from 'node:assert/strict'
import test, { after, afterEach } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createPinia } from 'pinia'
const vite = await createServer({ configFile:false,server:{watch:null,middlewareMode:true,hmr:false,preTransformRequests:false},appType:'custom',optimizeDeps:{noDiscovery:true},resolve:{alias:{'@':fileURLToPath(new URL('../src',import.meta.url))}} })
after(()=>vite.close())
globalThis.window={matchMedia:()=>({matches:false}),addEventListener(){},removeEventListener(){}}
Object.defineProperty(globalThis,'navigator',{value:{language:'en'},configurable:true})
const { useEditorStore }=await vite.ssrLoadModule('/src/stores/editor.ts')
const host=await vite.ssrLoadModule('/src/utils/pluginHost.ts')
const environments=[]
const hostCapabilities={enabled:true,formats:['vst3','vst2','au']}
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve))}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}}
function environment(t,{builtinEffects}={}){
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000})
  if(builtinEffects===undefined)delete hostCapabilities.builtinEffects
  else hostCapabilities.builtinEffects=builtinEffects
  const callbacks=new Map(), listeners=new Map();let callbackId=0
  const calls=[], controls={projectId:'project',revision:0,sessionId:'native-1',states:{slot:'sha256:initial'},snapshotError:false,statusError:false,updateError:false,partialSnapshot:false,omittedSlots:[],unavailablePlugins:[],openEditors:[],snapshotGate:null,parameterGate:null,parameterValues:{gain:0.5}}
  const status=()=>({projectId:controls.projectId,sessionId:controls.sessionId,stateRevision:controls.revision,openEditors:[...controls.openEditors],unavailablePlugins:[...controls.unavailablePlugins],position:0,playing:false,duration:2})
  globalThis.window={matchMedia:()=>({matches:false}),addEventListener(){},removeEventListener(){},__TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener(){}},__TAURI_INTERNALS__:{transformCallback(handler){callbacks.set(++callbackId,handler);return callbackId},async invoke(command,args){
    calls.push({command,args:JSON.parse(JSON.stringify(args||{}))})
    if(command==='plugin:event|listen'){listeners.set(args.handler,{event:args.event,handler:callbacks.get(args.handler)});return args.handler}
    if(command==='plugin:event|unlisten'){listeners.delete(args.eventId);return}
    if(command==='plugin_host_capabilities')return hostCapabilities
    if(command==='plugin_host_request'){
      const request=args.request
      if(request.op==='update'&&controls.updateError)throw new Error('Plugin Missing Effect [missing] could not be loaded')
      if(request.op==='load'){controls.projectId=request.projectId;controls.states=Object.fromEntries([...(request.project.pluginChain||[]),...request.project.tracks.flatMap(track=>track.pluginChain||[])].map(slot=>[slot.id,slot.state||'sha256:initial']))}
      if(request.op==='status'&&controls.statusError)throw new Error('The audio host session is closed')
      if(request.op==='snapshot'){
        const result={...status(),states:controls.partialSnapshot?{}:Object.fromEntries(Object.entries(controls.states).filter(([id])=>!controls.omittedSlots.includes(id)))}
        if(controls.snapshotGate)await controls.snapshotGate.promise
        if(controls.snapshotError)throw new Error('Controller state is temporarily unavailable')
        return result
      }
      if(request.op==='editor'){
        controls.openEditors=request.open?[request.slotId]:[]
        return{open:request.open,...status()}
      }
      if(request.op==='parameters'){
        if(controls.parameterGate)await controls.parameterGate.promise
        return{...status(),params:[{id:'gain',name:'Gain',min:0,max:1,default:0.5,unit:'None',taper:'Linear',choices:[]}],values:{...controls.parameterValues}}
      }
      if(request.op==='param'){
        if(controls.parameterGate)await controls.parameterGate.promise
        controls.parameterValues[request.paramId]=request.value
        controls.states[request.slotId]=`sha256:param-${request.value}`;controls.revision++
        return{...status(),value:request.value}
      }
      if(request.op==='update'&&request.stateRestoreSlotIds?.length){
        for(const slot of [...(request.project.pluginChain||[]),...request.project.tracks.flatMap(track=>track.pluginChain||[])])if(request.stateRestoreSlotIds.includes(slot.id))controls.states[slot.id]=slot.state
        controls.sessionId+='-restored';controls.revision=0
      }
      return status()
    }
    if(command==='save_editor_project'){controls.persisted=JSON.parse(JSON.stringify(args.project));return args.project}
    if(command==='load_editor_project')return controls.persisted
    if(command==='plugin_host_render')return{path:'C:/native-render.wav',duration:2,sampleRate:48000,channels:2}
    if(command==='plugin_host_cleanup_render')return
    if(command==='start_editor_mix_export'){
      for(const listener of listeners.values())if(listener.event==='pymss://worker-event')listener.handler({event:listener.event,payload:{type:'editor_mix_exported',taskId:args.payload.taskId,payload:{path:'C:/export.wav',format:'wav',duration:2,sampleRate:48000,channels:2}}})
      return{taskId:args.payload.taskId,started:true}
    }
    if(command==='save_app_store'||command==='write_frontend_log')return
    throw new Error('Unexpected command '+command)
  }}}
  const editor=useEditorStore(createPinia())
  editor.session={id:'project',name:'Project',masterVolume:1,masterPan:0,sources:[],tracks:[],pluginChain:[{id:'slot',format:'vst3',pluginId:'gain',name:'Gain',path:'C:/Gain.vst3',bypassed:false,state:'sha256:initial'}],createdAt:1,updatedAt:1}
  environments.push({editor,controls,t})
  return{editor,controls,calls,async tick(ms){t.mock.timers.tick(ms);await flush()},saved(){return calls.filter(call=>call.command==='save_editor_project')},snapshots(){return calls.filter(call=>call.command==='plugin_host_request'&&call.args.request.op==='snapshot')}}
}
afterEach(async()=>{
  for(const env of environments.splice(0)){
    env.controls.snapshotError=false;env.controls.statusError=false;env.controls.updateError=false;env.controls.partialSnapshot=false;env.controls.omittedSlots=[];env.controls.snapshotGate=null;env.controls.parameterGate=null
    const current=host.currentPluginSession()
    if(current){await host.snapshotPluginStates(current.project,{force:true});await host.unloadPluginSession(current.project.id)}
    env.editor.$dispose();env.t.mock.timers.reset()
  }
})

test('native window edits autosave without starting playback and unchanged revisions do not recapture',async t=>{
 const env=environment(t)
 await host.openPluginEditor(env.editor.session,'slot')
 await env.tick(900)
 env.calls.length=0
 env.controls.states.slot='sha256:gui-edit';env.controls.revision++
 await env.tick(1000)
 await env.tick(899)
 assert.equal(env.snapshots().length,0)
 await env.tick(1)
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:gui-edit')
 assert.equal(env.saved().at(-1).args.project.pluginChain[0].state,'sha256:gui-edit')
 assert.equal(env.editor.pluginStateDirty,false)
 assert.equal(env.snapshots().length,1)
 await env.tick(3000)
 assert.equal(env.snapshots().length,1)
 assert.equal(env.calls.filter(call=>call.args?.request?.op==='play').length,0)
})

test('capture failure keeps state dirty, retries once, and explicit retry saves the retained live state',async t=>{
 const env=environment(t)
 await host.openPluginEditor(env.editor.session,'slot')
 await env.tick(900)
 env.calls.length=0
 env.controls.states.slot='sha256:unsaved';env.controls.revision++;env.controls.snapshotError=true
 await host.pluginHostRequest({op:'status',projectId:'project'})
 await env.tick(900)
 assert.equal(env.editor.pluginStateDirty,true)
 assert.match(env.editor.pluginStateError,/temporarily unavailable/)
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:initial')
 assert.equal(env.saved().length,0)
 await env.tick(2000)
 assert.equal(env.snapshots().length,2)
 await env.tick(20000)
 assert.equal(env.snapshots().length,2)
 env.controls.snapshotError=false
 await env.editor.retryPluginStateSave()
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:unsaved')
 assert.equal(env.saved().at(-1).args.project.pluginChain[0].state,'sha256:unsaved')
 assert.equal(env.editor.pluginStateError,null)
 assert.equal(env.editor.pluginStateDirty,false)
})

test('failed explicit save and close never acknowledge success or unload; close captures before release',async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 env.calls.length=0
 env.controls.states.slot='sha256:final-window-state';env.controls.snapshotError=true
 await assert.rejects(env.editor.saveProject(),/temporarily unavailable/)
 await assert.rejects(env.editor.releasePluginSession(env.editor.session),/temporarily unavailable/)
 assert.equal(env.saved().length,0)
 assert.equal(env.calls.filter(call=>call.args?.request?.op==='unload').length,0)
 env.controls.snapshotError=false
 await env.editor.releasePluginSession(env.editor.session)
 assert.equal(env.saved().at(-1).args.project.pluginChain[0].state,'sha256:final-window-state')
 assert.equal(env.calls.at(-1).args.request.op,'unload')
 assert.equal(host.currentPluginSession(),null)
})

test('late snapshots cannot overwrite an explicit undo and only changed state slots are restored',async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 env.calls.length=0
 env.controls.states.slot='sha256:live-new'
 env.controls.snapshotGate=deferred()
 const capturing=host.snapshotPluginStates(env.editor.session,{force:true})
 await flush()
 env.editor.session.pluginChain[0].state='sha256:undo-old'
 env.controls.snapshotGate.resolve()
 await capturing
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:undo-old')
 await host.ensurePluginSession(env.editor.session)
 const update=env.calls.find(call=>call.args?.request?.op==='update')
 assert.deepEqual(update.args.request.stateRestoreSlotIds,['slot'])
 assert.equal(update.args.request.project.pluginChain[0].state,'sha256:undo-old')
 assert.equal(env.controls.states.slot,'sha256:undo-old')
 env.controls.snapshotGate=null
 await host.snapshotPluginStates(env.editor.session,{force:true})
 const updates=env.calls.filter(call=>call.args?.request?.op==='update').length
 await host.ensurePluginSession(env.editor.session)
 assert.equal(env.calls.filter(call=>call.args?.request?.op==='update').length,updates)
})

test('a rebuilt session with revision zero captures once even after a higher previous revision',async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 env.controls.revision=40
 await host.pluginHostRequest({op:'status',projectId:'project'})
 await env.tick(900)
 env.calls.length=0
 env.controls.sessionId='native-rebuilt';env.controls.revision=0;env.controls.states.slot='sha256:rebuilt-live'
 await host.pluginHostRequest({op:'status',projectId:'project'})
 await env.tick(900)
 assert.equal(env.snapshots().length,1)
 assert.equal(env.saved().at(-1).args.project.pluginChain[0].state,'sha256:rebuilt-live')
})

test('snapshot, unload and next project load share one queue and cannot apply state across projects',async t=>{
 const env=environment(t)
 const previous=env.editor.session
 await host.ensurePluginSession(previous)
 await env.tick(900)
 env.calls.length=0
 env.controls.snapshotGate=deferred();env.controls.states.slot='sha256:previous-live'
 const capture=host.snapshotPluginStates(previous,{force:true})
 await flush()
 const next={...previous,id:'next',pluginChain:[{...previous.pluginChain[0],state:'sha256:next-project'}]}
 const unload=host.unloadPluginSession('project')
 const load=host.ensurePluginSession(next)
 env.editor.session=next
 env.controls.snapshotGate.resolve()
 await capture;await unload;await load
 assert.equal(next.pluginChain[0].state,'sha256:next-project')
 assert.equal(previous.pluginChain[0].state,'sha256:previous-live')
 assert.deepEqual(env.calls.filter(call=>call.command==='plugin_host_request').map(call=>call.args.request.op),['snapshot','unload','load'])
 env.controls.snapshotGate=null
})

test('an open editor without revision notifications captures opaque state with a low-frequency fallback',async t=>{
 const env=environment(t)
 await host.openPluginEditor(env.editor.session,'slot')
 await env.tick(900)
 env.calls.length=0
 env.controls.states.slot='sha256:preset-ui-state'
 await env.tick(15000)
 await env.tick(900)
 assert.equal(env.snapshots().length,1)
 assert.equal(env.saved().at(-1).args.project.pluginChain[0].state,'sha256:preset-ui-state')
 env.controls.openEditors=[]
 await host.pluginHostRequest({op:'status',projectId:'project'})
 env.calls.length=0
 await env.tick(30000)
 assert.equal(env.snapshots().length,0)
})

test('a failed previous-project capture prevents destructive replacement and can be retried after navigation',async t=>{
 const env=environment(t)
 const previous=env.editor.session
 await host.ensurePluginSession(previous)
 await env.tick(900)
 env.controls.states.slot='sha256:old-unsaved';env.controls.snapshotError=true
 await assert.rejects(env.editor.releasePluginSession(previous),/temporarily unavailable/)
 const next={...previous,id:'next',pluginChain:[{...previous.pluginChain[0],state:'sha256:next-state'}]}
 env.editor.session=next
 await flush()
 env.calls.length=0
 await assert.rejects(host.ensurePluginSession(env.editor.session),/temporarily unavailable/)
 assert.equal(env.calls.filter(call=>call.args?.request?.op==='load').length,0)
 env.controls.snapshotError=false
 await env.editor.retryPluginStateSave()
 assert.ok(env.saved().some(call=>call.args.project.id==='project'&&call.args.project.pluginChain[0].state==='sha256:old-unsaved'))
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:next-state')
 await host.ensurePluginSession(env.editor.session)
 assert.equal(host.currentPluginSession().project.id,'next')
})

test('an incomplete snapshot fails instead of saving old plugin data as a successful capture',async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 env.calls.length=0;env.controls.partialSnapshot=true
 await assert.rejects(env.editor.saveProject(),/could not be captured|无法捕获/)
 assert.equal(env.saved().length,0)
 assert.equal(env.editor.pluginStateDirty,true)
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:initial')
 env.controls.partialSnapshot=false
 await env.editor.retryPluginStateSave()
 assert.equal(env.saved().length,1)
})

test('a dead host stays dirty until explicit recovery restores saved slots and preserves timeline edits',async t=>{
 const env=environment(t)
 await host.openPluginEditor(env.editor.session,'slot')
 await env.tick(900)
 env.calls.length=0
 env.editor.session.masterVolume=0.33
 env.controls.states.slot='sha256:uncaptured-dead-state';env.controls.snapshotError=true;env.controls.statusError=true
 await assert.rejects(host.pluginHostRequest({op:'status',projectId:'project'}),/session is closed/)
 await assert.rejects(env.editor.retryPluginStateSave(),/session is closed/)
 assert.equal(env.editor.pluginStateDirty,true)
 assert.equal(env.editor.pluginStateUnavailable,true)
 assert.equal(env.calls.filter(call=>call.args?.request?.op==='load').length,0)
 assert.equal(env.saved().length,0)
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:initial')
 env.controls.statusError=false;env.controls.snapshotError=false
 await env.editor.restoreSavedPluginSession()
 assert.equal(env.calls.filter(call=>call.args?.request?.op==='load').length,1)
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:initial')
 assert.equal(env.editor.session.masterVolume,0.33)
 assert.equal(env.saved().at(-1).args.project.masterVolume,0.33)
 assert.equal(env.editor.pluginStateUnavailable,false)
 assert.equal(env.editor.pluginStateError,null)
})

test('retry probes an unavailable session and captures a surviving controller without reloading it',async t=>{
 const env=environment(t)
 await host.openPluginEditor(env.editor.session,'slot')
 await env.tick(900)
 env.calls.length=0;env.controls.statusError=true
 await assert.rejects(host.pluginHostRequest({op:'status',projectId:'project'}),/session is closed/)
 env.controls.statusError=false;env.controls.states.slot='sha256:surviving-gui-edit'
 await env.editor.retryPluginStateSave()
 assert.equal(env.calls.filter(call=>call.args?.request?.op==='load').length,0)
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:surviving-gui-edit')
 assert.equal(env.editor.pluginStateUnavailable,false)
 assert.equal(env.editor.pluginStateError,null)
})

test('an unavailable bypassed slot keeps its opaque state while healthy GUI edits save and availability alone does not recapture',async t=>{
 const env=environment(t)
 env.editor.session.pluginChain.push({id:'missing',format:'vst3',pluginId:'missing-class',name:'Missing Effect',path:'C:/Unavailable.vst3',bypassed:true,state:'sha256:retained',future:{value:42}})
 env.controls.omittedSlots=['missing'];env.controls.unavailablePlugins=[{slotId:'missing',message:'Plugin file was not found'}]
 await host.ensurePluginSession(env.editor.session)
 env.controls.states.slot='sha256:healthy-gui'
 await env.editor.saveProject()
 const saved=env.saved().at(-1).args.project.pluginChain
 assert.equal(saved[0].state,'sha256:healthy-gui')
 assert.equal(saved[1].state,'sha256:retained')
 assert.deepEqual(saved[1].future,{value:42})
 assert.deepEqual(host.currentPluginSession().unavailablePlugins,[{slotId:'missing',message:'Plugin file was not found'}])
 env.calls.length=0
 env.controls.unavailablePlugins=[{slotId:'missing',message:'Plugin state is not available'}]
 await host.pluginHostRequest({op:'status',projectId:'project'})
 await env.tick(3000)
 assert.equal(env.snapshots().length,0)
 assert.equal(env.saved().length,0)
})

for(const action of ['bypass','remove','relocate'])test(`safe ${action} captures the surviving graph before repairing a failed project update`,async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 const missing={id:'missing',format:'vst3',pluginId:'missing-class',name:'Missing Effect',path:'C:/Missing.vst3',bypassed:false,state:'sha256:missing-retained',future:{version:7}}
 env.controls.states.slot='sha256:uncaptured-healthy-gui';env.controls.revision++
 env.editor.setPluginChain(null,[...env.editor.session.pluginChain,missing])
 env.controls.updateError=true
 await assert.rejects(host.ensurePluginSession(env.editor.session),/Missing Effect/)
 env.calls.length=0
 await env.editor.capturePluginState(env.editor.session,true,true)
 assert.equal(env.calls.filter(call=>call.args?.request?.op==='update').length,0)
 assert.equal(env.snapshots().length,1)
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:uncaptured-healthy-gui')
 const repaired=JSON.parse(JSON.stringify(env.editor.session.pluginChain))
 if(action==='bypass')repaired[1].bypassed=true
 else if(action==='remove')repaired.splice(1,1)
 else repaired[1].path='C:/Relocated/Missing.vst3'
 env.editor.setPluginChain(null,repaired)
 if(action==='remove'){
   env.editor.undo()
   assert.equal(env.editor.session.pluginChain[1].state,'sha256:missing-retained')
   assert.equal(env.editor.session.pluginChain[0].state,'sha256:uncaptured-healthy-gui')
   env.editor.redo()
 }
 env.controls.updateError=false
 if(action==='relocate')env.controls.states.missing='sha256:missing-retained'
 await host.ensurePluginSession(env.editor.session)
 await env.editor.saveProject()
 const saved=env.saved().at(-1).args.project.pluginChain
 assert.equal(saved[0].state,'sha256:uncaptured-healthy-gui')
 if(action!=='remove'){
   assert.equal(saved[1].state,'sha256:missing-retained')
   assert.equal(saved[1].pluginId,'missing-class')
   assert.deepEqual(saved[1].future,{version:7})
   assert.equal(saved[1].path,action==='relocate'?'C:/Relocated/Missing.vst3':'C:/Missing.vst3')
 }
})

test('recovery never captures an old controller into a different class, location or explicit state restore',async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 env.controls.states.slot='sha256:other-live-controller'
 for(const change of [{pluginId:'other-class'},{path:'C:/Different.vst3'},{state:'sha256:history-restore'},{format:'au'}]){
   const original={...env.editor.session.pluginChain[0]}
   Object.assign(env.editor.session.pluginChain[0],change)
   await env.editor.capturePluginState(env.editor.session,true,true)
   assert.notEqual(env.editor.session.pluginChain[0].state,'sha256:other-live-controller')
   env.editor.session.pluginChain[0]=original
 }
})

test('a recovery edit cannot discard a dead session or an incomplete enabled controller snapshot',async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 env.controls.partialSnapshot=true
 await assert.rejects(env.editor.capturePluginState(env.editor.session,true,true),/could not be captured|无法捕获/)
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:initial')
 env.controls.partialSnapshot=false;env.controls.statusError=true
 await assert.rejects(host.pluginHostRequest({op:'status',projectId:'project'}),/session is closed/)
 await assert.rejects(env.editor.capturePluginState(env.editor.session,true,true),/session is closed/)
 assert.equal(env.editor.pluginStateUnavailable,true)
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:initial')
})

for(const format of ['vst2','au'])test(`${format} controllers require complete snapshots and retain opaque state on bypass`,async t=>{
 const env=environment(t)
 env.editor.session.pluginChain[0].format=format
 await host.ensurePluginSession(env.editor.session)
 env.controls.states.slot=`sha256:${format}-live`
 await env.editor.saveProject()
 assert.equal(env.saved().at(-1).args.project.pluginChain[0].state,`sha256:${format}-live`)
 env.controls.omittedSlots=['slot']
 await assert.rejects(host.snapshotPluginStates(env.editor.session,{force:true}),/could not be captured|无法捕获/)
 env.editor.session.pluginChain[0].bypassed=true
 await host.ensurePluginSession(env.editor.session)
 await host.snapshotPluginStates(env.editor.session,{force:true})
 assert.equal(env.editor.session.pluginChain[0].state,`sha256:${format}-live`)
})

test('generic parameter edits use plain values, become dirty, and autosave their opaque state',async t=>{
 const env=environment(t)
 const response=await host.getPluginParameters(env.editor.session,'slot')
 assert.equal(response.params[0].id,'gain')
 assert.equal(response.values.gain,0.5)
 await env.tick(900)
 env.calls.length=0
 const acknowledged=await host.setPluginParameter(env.editor.session,'slot','gain',0.75)
 assert.equal(acknowledged.value,0.75)
 assert.equal(host.currentPluginSession().dirty,true)
 const request=env.calls.find(call=>call.args?.request?.op==='param').args.request
 assert.deepEqual(request,{op:'param',slotId:'slot',paramId:'gain',value:0.75,projectId:'project'})
 await env.tick(900)
 assert.equal(env.saved().at(-1).args.project.pluginChain[0].state,'sha256:param-0.75')
 assert.equal(host.currentPluginSession().dirty,false)
})

test('parameter writes and state capture share the session queue',async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 env.calls.length=0;env.controls.parameterGate=deferred()
 const edit=host.setPluginParameter(env.editor.session,'slot','gain',0.25)
 await flush()
 const snapshot=host.snapshotPluginStates(env.editor.session,{force:true})
 await flush()
 assert.equal(env.snapshots().length,0)
 env.controls.parameterGate.resolve()
 await edit;await snapshot
 assert.deepEqual(env.calls.filter(call=>call.command==='plugin_host_request').map(call=>call.args.request.op),['param','snapshot'])
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:param-0.25')
})

test('parameter reads reject a slot relocated while its response is pending',async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 env.controls.parameterGate=deferred()
 const reading=host.getPluginParameters(env.editor.session,'slot')
 await flush()
 env.editor.session.pluginChain[0].path='C:/Relocated/Gain.vst3'
 env.controls.parameterGate.resolve()
 await assert.rejects(reading,/audio session changed|音频会话已变更/)
})

test('non-finite parameter values are rejected before reaching the native process',async t=>{
 const env=environment(t)
 for(const value of [NaN,Infinity,-Infinity])await assert.rejects(host.setPluginParameter(env.editor.session,'slot','gain',value),/invalid|无效/)
 assert.equal(env.calls.filter(call=>call.command==='plugin_host_request').length,0)
})

for(const change of ['parameters','undo','relocation']){
 test(`plugin export freezes the complete project after ${change} during native capture`,async t=>{
  const env=environment(t)
  await host.ensurePluginSession(env.editor.session)
  await env.tick(900)
  if(change==='undo'){
    env.editor.setMasterVolume(0.2)
    env.editor.setPluginChain(null,[{...env.editor.session.pluginChain[0],state:'sha256:history-new'}])
    env.editor.setMasterVolume(0.8)
  }
  env.controls.states.slot='sha256:captured-native'
  env.controls.revision++
  env.controls.snapshotGate=deferred()
  env.calls.length=0
  const exporting=env.editor.exportMix({format:'wav'})
  await flush()
  assert.ok(env.snapshots().length>0)
  if(change==='parameters')env.editor.setMasterVolume(0.25)
  else if(change==='undo')env.editor.undo()
  else{
    env.editor.session.pluginChain[0].path='C:/Relocated/Gain.vst3'
    env.editor.setMasterPan(-0.5)
  }
  env.controls.snapshotGate.resolve()
  await exporting
  const rendered=env.calls.find(call=>call.command==='plugin_host_render').args.project
  assert.equal(rendered.masterVolume,env.editor.session.masterVolume)
  assert.equal(rendered.masterPan,env.editor.session.masterPan)
  assert.deepEqual(rendered.pluginChain,JSON.parse(JSON.stringify(env.editor.session.pluginChain)))
  if(change==='parameters')assert.equal(rendered.pluginChain[0].state,'sha256:captured-native')
  if(change==='undo')assert.equal(rendered.pluginChain[0].state,'sha256:initial')
  if(change==='relocation')assert.equal(rendered.pluginChain[0].path,'C:/Relocated/Gain.vst3')
 })
}

test('plugin export retains the originating project when another project opens during capture',async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 const original=env.editor.session
 env.controls.states.slot='sha256:original-native'
 env.controls.snapshotGate=deferred()
 env.calls.length=0
 const exporting=env.editor.exportMix({format:'wav'})
 await flush()
 env.editor.session={...JSON.parse(JSON.stringify(original)),id:'next',masterVolume:0.4,pluginChain:[{...original.pluginChain[0],state:'sha256:next-project'}]}
 env.controls.snapshotGate.resolve()
 await exporting
 const rendered=env.calls.find(call=>call.command==='plugin_host_render').args.project
 assert.equal(rendered.id,'project')
 assert.equal(rendered.masterVolume,1)
 assert.equal(rendered.pluginChain[0].state,'sha256:original-native')
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:next-project')
})

test('cancelling plugin export during capture never starts an offline render',async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 env.controls.snapshotGate=deferred()
 env.calls.length=0
 const exporting=env.editor.exportMix({format:'wav'})
 await flush()
 assert.equal(await env.editor.cancelExport(),true)
 env.controls.snapshotGate.resolve()
 await assert.rejects(exporting,error=>error.name==='EditorExportCancelledError')
 assert.equal(env.calls.filter(call=>call.command==='plugin_host_render').length,0)
 assert.equal(env.calls.filter(call=>call.command==='start_editor_mix_export').length,0)
})

test('plugin export revalidates built-in effects added during capture',async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 env.controls.snapshotGate=deferred()
 env.calls.length=0
 const exporting=env.editor.exportMix({format:'wav'})
 await flush()
 env.editor.session.tracks.push({id:'track',sourceId:'source',role:'stem',name:'Track',volume:1,pan:0,muted:false,solo:false,fadeIn:0,fadeOut:0,effects:{reverb:0.2}})
 env.controls.snapshotGate.resolve()
 try{
  await assert.rejects(exporting,/effects|效果/)
  assert.equal(env.calls.filter(call=>call.command==='plugin_host_render').length,0)
 }finally{env.editor.session.tracks=[]}
})

test('saving AUv2 and AUv3 with identical component codes preserves separate states and variant metadata',async t=>{
 const env=environment(t)
 env.editor.session.pluginChain=[
   {id:'au2-slot',format:'au',pluginId:'au:aufx:gain:test',path:'au:aufx:gain:test',name:'Gain',bypassed:true,state:'sha256:au2-saved',auVersion:2,future:{keep:'v2'}},
   {id:'au3-slot',format:'au',pluginId:'au3:aufx:gain:test',path:'au3:aufx:gain:test',name:'Gain',bypassed:false,state:'sha256:au3-saved',auVersion:3,future:{keep:'v3'}},
 ]
 await host.ensurePluginSession(env.editor.session)
 env.controls.omittedSlots=['au2-slot']
 env.controls.states['au3-slot']='sha256:au3-live'
 await env.editor.saveProject()
 const saved=env.saved().at(-1).args.project.pluginChain
 assert.equal(saved[0].state,'sha256:au2-saved')
 assert.equal(saved[1].state,'sha256:au3-live')
 assert.equal(saved[0].auVersion,2)
 assert.equal(saved[1].auVersion,3)
 assert.notEqual(saved[0].pluginId,saved[1].pluginId)
 assert.deepEqual(saved.map(slot=>slot.future),[{keep:'v2'},{keep:'v3'}])
})

test('recovery cannot capture an AUv2 controller state after the slot is changed to AUv3',async t=>{
 const env=environment(t)
 const slot=env.editor.session.pluginChain[0]
 Object.assign(slot,{format:'au',pluginId:'au:aufx:gain:test',path:'au:aufx:gain:test',auVersion:2,state:'sha256:au2-saved'})
 await host.ensurePluginSession(env.editor.session)
 env.controls.states.slot='sha256:au2-uncaptured'
 Object.assign(slot,{pluginId:'au3:aufx:gain:test',path:'au3:aufx:gain:test',auVersion:3,state:'sha256:au3-saved'})
 await env.editor.capturePluginState(env.editor.session,true,true)
 assert.equal(slot.state,'sha256:au3-saved')
 assert.equal(slot.auVersion,3)
})

for(const operation of ['read','write']){
 for(const change of ['undo','relocation','shell child','AU variant']){
  test(`queued parameter ${operation} rejects a changed ${change} before contacting its replacement`,async t=>{
   const env=environment(t)
   await host.ensurePluginSession(env.editor.session)
   await env.tick(900)
   env.controls.snapshotGate=deferred()
   const capturing=host.snapshotPluginStates(env.editor.session,{force:true})
   await flush()
   env.calls.length=0
   const pending=operation==='read'?host.getPluginParameters(env.editor.session,'slot'):host.setPluginParameter(env.editor.session,'slot','gain',0.75)
   const rejected=assert.rejects(pending,/audio session changed|音频会话已变更/)
   const slot=env.editor.session.pluginChain[0]
   if(change==='undo')slot.state='sha256:history-restore'
   else if(change==='relocation')slot.path='C:/Replacement/Gain.vst3'
   else if(change==='shell child')slot.isShellChild=true
   else slot.auVersion=3
   env.controls.snapshotGate.resolve()
   await capturing
   await rejected
   assert.equal(env.calls.filter(call=>['parameters','param'].includes(call.args?.request?.op)).length,0)
  })
 }
}

test('a queued parameter write rejects a session replaced before it starts',async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 env.controls.snapshotGate=deferred()
 const capturing=host.snapshotPluginStates(env.editor.session,{force:true})
 await flush()
 const status=host.pluginHostRequest({op:'status',projectId:'project'})
 const editing=host.setPluginParameter(env.editor.session,'slot','gain',0.75)
 const rejected=assert.rejects(editing,/audio session changed|音频会话已变更/)
 env.controls.sessionId='replacement-session'
 env.controls.snapshotGate.resolve()
 await capturing;await status;await rejected
 assert.equal(env.calls.filter(call=>call.args?.request?.op==='param').length,0)
})

test('queued parameter writes allow opaque state captured by the same controller and concurrent mix edits',async t=>{
 const env=environment(t)
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 env.controls.states.slot='sha256:captured-live'
 env.controls.snapshotGate=deferred()
 const capturing=host.snapshotPluginStates(env.editor.session,{force:true})
 await flush()
 const editing=host.setPluginParameter(env.editor.session,'slot','gain',0.75)
 env.editor.setMasterVolume(0.7)
 env.controls.snapshotGate.resolve()
 await capturing;await editing
 assert.equal(env.controls.parameterValues.gain,0.75)
 assert.equal(env.editor.session.pluginChain[0].state,'sha256:captured-live')
})

const builtinTrack=effects=>({id:'track',sourceId:'source',role:'stem',name:'Track',volume:1,pan:0,muted:false,solo:false,fadeIn:0,fadeOut:0,effects})
const builtinSettings={reverb:0.2,delay:0.3,delayTime:0.4,clarity:0.5,compressor:0.6}

test('a capable host receives all built-in effects for plugin playback and subsequent updates',async t=>{
 const env=environment(t,{builtinEffects:true})
 env.editor.session.tracks=[builtinTrack({...builtinSettings})]
 await host.ensurePluginSession(env.editor.session)
 await host.pluginHostRequest({op:'play',projectId:'project',position:0})
 const load=env.calls.find(call=>call.args?.request?.op==='load').args.request
 assert.deepEqual(load.project.tracks[0].effects,builtinSettings)
 assert.ok(env.calls.some(call=>call.args?.request?.op==='play'))
 env.editor.session.tracks[0].effects={...builtinSettings,delayTime:0.7,compressor:0.25}
 await host.ensurePluginSession(env.editor.session)
 const update=env.calls.findLast(call=>call.args?.request?.op==='update').args.request
 assert.deepEqual(update.project.tracks[0].effects,env.editor.session.tracks[0].effects)
})

for(const builtinEffects of [undefined,false]){
 test(`a host with ${builtinEffects===undefined?'missing':'disabled'} built-in effects capability keeps rejecting plugin effects`,async t=>{
  const env=environment(t,{builtinEffects})
  env.editor.session.tracks=[builtinTrack({...builtinSettings})]
  try{
   await assert.rejects(host.ensurePluginSession(env.editor.session),/built-in effects|内置效果/)
   assert.equal(env.calls.filter(call=>call.args?.request?.op==='load').length,0)
   await assert.rejects(env.editor.exportMix(),/built-in effects|内置效果/)
   assert.equal(env.calls.filter(call=>call.command==='plugin_host_render').length,0)
  }finally{env.editor.session.tracks=[]}
 })
}

test('plugin export freezes built-in effects changed during capture and encodes a neutral track',async t=>{
 const env=environment(t,{builtinEffects:true})
 env.editor.session.tracks=[builtinTrack({...builtinSettings,reverb:0.1})]
 await host.ensurePluginSession(env.editor.session)
 await env.tick(900)
 env.controls.snapshotGate=deferred()
 const exporting=env.editor.exportMix({format:'wav'})
 await flush()
 env.editor.session.tracks=[builtinTrack({...builtinSettings})]
 env.editor.setMasterVolume(0.35)
 env.controls.snapshotGate.resolve()
 await exporting
 const rendered=env.calls.find(call=>call.command==='plugin_host_render').args.project
 assert.equal(rendered.masterVolume,0.35)
 assert.deepEqual(rendered.tracks[0].effects,builtinSettings)
 const encoded=env.calls.find(call=>call.command==='start_editor_mix_export').args.payload.project
 assert.equal(encoded.masterVolume,1)
 assert.equal(encoded.masterPan,0)
 assert.equal(encoded.tracks.length,1)
 assert.equal(encoded.tracks[0].effects,undefined)
 assert.equal(encoded.tracks[0].volume,1)
 assert.equal(encoded.assets[0].path,'C:/native-render.wav')
 assert.equal(env.calls.filter(call=>call.command==='cleanup_editor_export_render').length,0)
})
