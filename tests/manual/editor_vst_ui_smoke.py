"""Exercise the actual editor plugin UI with a controlled Tauri transport; no native plugin is loaded."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url', default='http://127.0.0.1:1422')
parser.add_argument('--output-dir', type=Path, default=Path('.tmp/vst-ui-smoke'))
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

MOCK = """enabled => {
  localStorage.setItem('pymss-studio:app-settings', JSON.stringify({startupOnboardingSeen:true,
    beginnerGuideProgress:{status:'skipped',step:0},locale:'zh-CN',themeMode:'light'}));
  window.__vstCalls=[]; window.__savedVstProjects=[]; window.__scanError=false; window.__scanDelay=0; window.__scanFailures=[]; window.__missingPaths=[];
  window.__vstState={sessionId:'ui-native-1',revision:0,states:{},editors:[],snapshotError:false,statusError:false};
  const callbacks=new Map(),listeners=new Map(); let next=0;
  window.__TAURI_INTERNALS__={
    metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
    transformCallback:callback=>{callbacks.set(++next,callback);return next},
    unregisterCallback:id=>callbacks.delete(id),convertFileSrc:path=>path,
    invoke:async(command,args={})=>{
      __vstCalls.push({command,args:JSON.parse(JSON.stringify(args))});
      if(command==='plugin_host_capabilities') return {enabled,platform:enabled?'windows':'linux',formats:['vst3'],nativeEditor:enabled,experimental:true};
      if(command==='plugin_host_scan_report') {
        await new Promise(resolve=>setTimeout(resolve,__scanDelay));
        if(__scanError) throw new Error('插件扫描未完成：目录不可访问');
        const plugins=[{id:'gain',classId:'gain',name:'Precision Gain',vendor:'Audio Tools',path:'C:/VST3/Gain.vst3',version:'1',isInstrument:false},
          {id:'echo',classId:'echo',name:'Stereo Echo',vendor:'Audio Tools',path:'C:/VST3/Echo.vst3',version:'1',isInstrument:false},
          {id:'synth',classId:'synth',name:'Keyboard Instrument',vendor:'Audio Tools',path:'C:/VST3/Synth.vst3',version:'1',isInstrument:true}];
        if(args.force)__scanFailures=[];
        return {plugins,failures:[...__scanFailures],scanned:args.force?3:0,cached:args.force?0:3};
      }
      if(command==='plugin_host_render') return {path:'C:/Audio/Rendered/mix.wav',duration:40,sampleRate:48000,channels:2,tailLimited:true};
      if(command==='start_editor_mix_export') {
        setTimeout(()=>{for(const listener of listeners.values())if(listener.event==='pymss://worker-event')listener.callback({event:listener.event,id:1,payload:{type:'editor_mix_exported',taskId:args.payload.taskId,payload:{path:'C:/Audio/Exported/mix.wav',duration:40,sampleRate:48000,channels:2,format:'wav'}}})},100);
        return {taskId:args.payload.taskId,started:true};
      }
      if(command==='plugin_host_request') {
        const request=args.request;
        if(request.op==='status'&&__vstState.statusError)throw new Error('The audio host session is closed');
        const slots=request.project?[...(request.project.pluginChain||[]),...request.project.tracks.flatMap(track=>track.pluginChain||[])]:[];
        if((request.op==='load'||request.op==='update')&&slots.some(slot=>!slot.bypassed&&__missingPaths.includes(slot.path)))throw new Error('Plugin file was not found: C:/Missing/Gain.vst3');
        if(request.op==='load'){__vstState.statusError=false;__vstState.states={};__vstState.editors=[]}
        if(request.op==='load'||request.op==='update')for(const slot of [...(request.project.pluginChain||[]),...request.project.tracks.flatMap(track=>track.pluginChain||[])])__vstState.states[slot.id] ||= slot.state||'sha256:initial';
        if(request.op==='load'||request.op==='update'){__vstState.graph=slots;for(const slot of slots)if(slot.bypassed&&__missingPaths.includes(slot.path))delete __vstState.states[slot.id]}
        if(request.op==='snapshot'&&__vstState.snapshotError)throw new Error('Controller state is temporarily unavailable');
        if(request.op==='editor')__vstState.editors=request.open?[request.slotId]:[];
        return {projectId:request.projectId,sessionId:__vstState.sessionId,stateRevision:__vstState.revision,openEditors:__vstState.editors,
          position:0,playing:false,duration:10,sampleRate:48000,unavailablePlugins:(__vstState.graph||[]).filter(slot=>slot.bypassed&&__missingPaths.includes(slot.path)).map(slot=>({slotId:slot.id,message:'Plugin file was not found'})),...(request.op==='snapshot'?{states:{...__vstState.states}}:{}),...(request.op==='editor'?{open:request.open}:{})};
      }
      if(command==='plugin:event|listen') {listeners.set(args.handler,{event:args.event,callback:callbacks.get(args.handler)});return args.handler}
      if(command==='plugin:event|unlisten') {listeners.delete(args.eventId);return}
      if(command==='load_app_store') {try{return JSON.parse(localStorage.getItem('pymss-studio:'+args.name))}catch{return null}}
      if(command==='save_app_store') {localStorage.setItem('pymss-studio:'+args.name,JSON.stringify(args.data));return}
      if(command==='get_build_info') return {version:'0.0.12',variant:'vst-lab',updateSupported:false};
      if(command==='get_runtime_info') return {supported:false,installedEnvironments:[],coreUpdateSupported:false};
      if(command==='load_editor_project')return __savedVstProjects.filter(project=>project.id===args.projectId).at(-1);
      if(command==='save_editor_project'){__savedVstProjects.push(JSON.parse(JSON.stringify(args.project)));return args.project}
      if(command==='list_editor_projects'||command==='list_models'||command==='list_tasks') return [];
      return null;
    }
  };
}"""
SETUP = """async () => {
  const app=document.querySelector('#app').__vue_app__.config.globalProperties;
  window.__editor=app.$pinia._s.get('editor');
  app.$pinia._s.get('settings').initialized=true;
  __editor.session={id:'vst-ui-project',name:'Audio Session',masterVolume:1,masterPan:0,
    sources:[],tracks:[{id:'track',sourceId:'',role:'stem',name:'人声',volume:1,pan:0,
      muted:false,solo:false,fadeIn:0,fadeOut:0,clips:[],effects:{clarity:0,compressor:0,reverb:0,delay:0,delayTime:.24}}],createdAt:1,updatedAt:1};
  __editor.selectTrack('track');
  await app.$router.replace({name:'editor',query:{projectId:'vst-ui-project'}});
}"""
GEOMETRY = """() => {
 const panel=document.querySelector('.plugin-panel'), rect=panel.getBoundingClientRect();
 const failures=[];
 for(const el of panel.querySelectorAll('button,input,.n-select,.plugin-panel__slot')){
   const r=el.getBoundingClientRect();
   if(r.width&&r.height&&(r.left<rect.left-.5||r.right>rect.right+.5)) failures.push({text:el.textContent.trim(),left:r.left,right:r.right});
 }
 return {viewport:{width:innerWidth,height:innerHeight},panel:{left:rect.left,right:rect.right,width:rect.width},
   documentOverflow:document.documentElement.scrollWidth>innerWidth,panelOverflow:rect.left<0||rect.right>innerWidth+.5,failures};
}"""

with sync_playwright() as playwright:
    browser=playwright.chromium.launch(headless=True,args=['--no-proxy-server'])
    results=[]
    for enabled in (True,False):
        context=browser.new_context(viewport={'width':1280,'height':820})
        page=context.new_page()
        page.set_default_timeout(15000)
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.add_init_script(f'({MOCK})({json.dumps(enabled)})')
        page.goto(args.url.rstrip('/')+'/#/editor',wait_until='domcontentloaded',timeout=60000)
        page.wait_for_load_state('networkidle',timeout=60000)
        page.locator('.editor-transport').wait_for(state='visible')
        page.evaluate(SETUP)
        toggle=page.locator('.editor-shell__inspector-toggle')
        if toggle.get_attribute('aria-pressed') == 'false':
            toggle.click()
        page.locator('.editor-inspector').wait_for(state='visible')
        panel=page.locator('.plugin-panel')
        if not enabled:
            expect(panel).to_have_count(0)
            page.screenshot(path=str(args.output_dir/'unsupported-platform-1280x820.png'))
            results.append({'scenario':'disabled-platform','panelVisible':False,'pageErrors':errors})
            context.close()
            continue
        expect(panel).to_be_visible()
        print('Plugin panel mounted',flush=True)
        directory='C:/Audio/VST3/Additional Effects and Signal Processing'
        panel.get_by_placeholder('VST3 搜索目录',exact=True).fill(directory)
        panel.get_by_role('button',name='添加目录',exact=True).click()
        expect(panel.locator('.plugin-panel__directory')).to_contain_text(directory)
        panel.get_by_role('button',name='扫描插件',exact=True).click()
        page.wait_for_function("__vstCalls.some(c=>c.command==='plugin_host_scan_report')")
        assert page.evaluate("__vstCalls.find(c=>c.command==='plugin_host_scan_report').args.paths")==[directory]
        def choose_plugin(name):
            panel.locator('.n-select').nth(1).click()
            page.locator('.n-base-select-option').filter(has_text=name).click()
        choose_plugin('Precision Gain')
        panel.get_by_role('button',name='添加到插件链',exact=True).click()
        expect(panel.locator('.plugin-panel__slot')).to_have_count(1)
        page.wait_for_function("__editor.session.tracks[0].pluginChain.length===1")
        choose_plugin('Stereo Echo')
        panel.get_by_role('button',name='添加到插件链',exact=True).click()
        expect(panel.locator('.plugin-panel__slot')).to_have_count(2)
        panel.locator('.plugin-panel__slot').nth(1).get_by_role('button',name='上移插件',exact=True).click()
        page.wait_for_function("__editor.session.tracks[0].pluginChain[0].pluginId==='echo'")
        first=panel.locator('.plugin-panel__slot').first
        first.get_by_role('checkbox',name='旁路',exact=True).click()
        page.wait_for_function("__editor.session.tracks[0].pluginChain[0].bypassed")
        first.get_by_role('button',name='打开界面',exact=True).click()
        expect(first.get_by_role('button',name='关闭界面',exact=True)).to_be_visible()
        page.evaluate("() => { const id=__editor.session.tracks[0].pluginChain[0].id;__vstState.states[id]='sha256:gui-live';__vstState.revision++ }")
        page.wait_for_function("__savedVstProjects.some(project=>project.tracks[0].pluginChain?.[0]?.state==='sha256:gui-live')")
        assert page.evaluate("__vstCalls.filter(c=>c.args?.request?.op==='play').length")==0
        page.evaluate("() => { const id=__editor.session.tracks[0].pluginChain[0].id;__vstState.states[id]='sha256:gui-retry';__vstState.snapshotError=true;__vstState.revision++ }")
        expect(panel.locator('.n-alert')).to_contain_text('Controller state is temporarily unavailable')
        expect(panel.get_by_role('button',name='重试保存',exact=True)).to_be_visible()
        panel.locator('.n-alert').scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        page.screenshot(path=str(args.output_dir/'plugin-state-save-error-1280x820.png'))
        assert page.evaluate('__editor.pluginStateDirty') is True
        page.evaluate('__vstState.snapshotError=false')
        panel.get_by_role('button',name='重试保存',exact=True).click()
        expect(panel.locator('.n-alert')).to_have_count(0)
        page.wait_for_function("__savedVstProjects.some(project=>project.tracks[0].pluginChain?.[0]?.state==='sha256:gui-retry')")
        results.append({'scenario':'native-window-autosave-without-playback-and-failure-retry','passed':True})
        page.evaluate('__vstState.statusError=true')
        expect(panel.get_by_role('button',name='重新加载插件',exact=True)).to_be_visible()
        panel.get_by_role('button',name='重新加载插件',exact=True).click()
        expect(page.get_by_text('是否从工程最近成功保存的状态重新加载插件？原生插件窗口中尚未捕获的修改可能丢失，当前时间线和混音编辑将保留。',exact=True)).to_be_visible()
        page.get_by_role('button',name='确认',exact=True).click()
        expect(panel.locator('.n-alert')).to_have_count(0)
        expect(first.get_by_role('button',name='打开界面',exact=True)).to_be_visible()
        first.get_by_role('button',name='打开界面',exact=True).click()
        first.get_by_role('button',name='关闭界面',exact=True).click()
        results.append({'scenario':'explicit-dead-session-reload-with-loss-warning','passed':True})
        assert page.evaluate("__vstCalls.filter(c=>c.command==='plugin_host_request'&&c.args.request.op==='editor').map(c=>c.args.request.open)")==[True,True,False]
        for width,height in ((1280,820),(980,680)):
            page.set_viewport_size({'width':width,'height':height})
            panel.scroll_into_view_if_needed()
            page.wait_for_timeout(200)
            geometry=page.evaluate(GEOMETRY)
            page.screenshot(path=str(args.output_dir/f'plugin-track-chain-{width}x{height}.png'))
            results.append({'scenario':'track-chain','geometry':geometry})
            assert not geometry['documentOverflow'] and not geometry['panelOverflow'] and not geometry['failures'],geometry
        first.get_by_role('button',name='移除',exact=True).click()
        expect(panel.locator('.plugin-panel__slot')).to_have_count(1)
        panel.locator('.n-select').first.click()
        page.locator('.n-base-select-option').filter(has_text='主输出').click()
        expect(panel.locator('.plugin-panel__slot')).to_have_count(0)
        choose_plugin('Stereo Echo')
        panel.get_by_role('button',name='添加到插件链',exact=True).click()
        page.wait_for_function("__editor.session.pluginChain.length===1")
        assert page.evaluate("__editor.session.tracks[0].pluginChain.length")==1
        page.screenshot(path=str(args.output_dir/'plugin-master-chain-980x680.png'))
        page.evaluate('__scanDelay=1600')
        panel.get_by_role('button',name='扫描插件',exact=True).click()
        expect(panel).to_have_attribute('aria-busy','true')
        expect(panel.get_by_role('button',name='添加到插件链',exact=True)).to_be_disabled()
        page.screenshot(path=str(args.output_dir/'plugin-scan-loading-980x680.png'))
        expect(panel).to_have_attribute('aria-busy','false')
        page.evaluate('__scanDelay=0;__scanError=true')
        panel.get_by_role('button',name='扫描插件',exact=True).click()
        expect(panel.locator('.n-alert')).to_contain_text('插件扫描未完成：目录不可访问')
        expect(panel).to_have_attribute('aria-busy','false')
        panel.locator('.n-alert').scroll_into_view_if_needed()
        page.screenshot(path=str(args.output_dir/'plugin-scan-error-980x680.png'))
        panel.get_by_role('button',name='移除搜索目录',exact=True).click()
        expect(panel.locator('.plugin-panel__directory')).to_have_count(0)
        page.evaluate('__scanError=false')
        panel.get_by_role('button',name='扫描插件',exact=True).click()
        page.wait_for_function("__vstCalls.filter(c=>c.command==='plugin_host_scan_report').at(-1).args.paths.length===0")
        expect(panel.locator('.n-alert')).to_have_count(0)
        page.evaluate("__scanFailures=[{path:'C:/Unavailable/Effects.vst3',message:'Module probe timed out'}]")
        panel.get_by_role('button',name='扫描插件',exact=True).click()
        expect(panel.locator('.plugin-panel__scan-failures')).to_contain_text('Module probe timed out')
        panel.get_by_role('button',name='重新检测失败项',exact=True).click()
        expect(panel.locator('.plugin-panel__scan-failures')).to_have_count(0)
        assert page.evaluate("__vstCalls.filter(c=>c.command==='plugin_host_scan_report').at(-1).args.force") is True
        results.append({'scenario':'scan-failure-detail-and-force-reprobe','passed':True})
        page.evaluate("""() => {
          __missingPaths=['C:/Missing/Gain.vst3'];
          const trackSlot=__editor.session.tracks[0].pluginChain[0];
          __vstState.states[trackSlot.id]='sha256:healthy-unflushed';
          __editor.setPluginChain(null,[...__editor.session.pluginChain,{id:'missing-slot',format:'vst3',pluginId:'gain',name:'Precision Gain',path:'C:/Missing/Gain.vst3',bypassed:false,state:'sha256:missing-retained',future:{value:7}}]);
        }""")
        expect(panel.locator('.n-alert')).to_contain_text('Plugin file was not found')
        missing=panel.locator('.plugin-panel__slot').last
        missing.get_by_role('checkbox',name='旁路',exact=True).click()
        page.wait_for_function("__savedVstProjects.at(-1)?.pluginChain?.find(slot=>slot.id==='missing-slot')?.bypassed===true")
        assert page.evaluate("__savedVstProjects.at(-1).pluginChain.find(slot=>slot.id==='missing-slot').state")=='sha256:missing-retained'
        assert page.evaluate("__savedVstProjects.at(-1).tracks[0].pluginChain[0].state")=='sha256:healthy-unflushed'
        expect(missing.locator('.plugin-panel__warning')).to_contain_text('原有状态仍保留')
        missing.get_by_role('button',name='重新定位',exact=True).click()
        panel.locator('.n-select').nth(1).click()
        expect(page.locator('.n-base-select-option').filter(has_text='Precision Gain')).to_be_visible()
        expect(page.locator('.n-base-select-option:visible').filter(has_text='C:/VST3/Gain.vst3')).to_be_visible()
        expect(page.locator('.n-base-select-option').filter(has_text='Stereo Echo')).to_have_count(0)
        geometry=page.evaluate(GEOMETRY)
        assert not geometry['documentOverflow'] and not geometry['panelOverflow'] and not geometry['failures'],geometry
        page.screenshot(path=str(args.output_dir/'plugin-relocation-menu-980x680.png'))
        page.locator('.n-base-select-option').filter(has_text='Precision Gain').click()
        panel.get_by_role('button',name='应用插件位置',exact=True).click()
        page.wait_for_function("__editor.session.pluginChain.find(slot=>slot.id==='missing-slot').path==='C:/VST3/Gain.vst3'")
        relocated=page.evaluate("__editor.session.pluginChain.find(slot=>slot.id==='missing-slot')")
        assert relocated['state']=='sha256:missing-retained' and relocated['future']=={'value':7}
        missing.get_by_role('checkbox',name='旁路',exact=True).click()
        page.wait_for_function("__savedVstProjects.at(-1)?.pluginChain?.find(slot=>slot.id==='missing-slot')?.bypassed===false")
        expect(missing.locator('.plugin-panel__warning')).to_have_count(0)
        page.screenshot(path=str(args.output_dir/'plugin-missing-relinked-980x680.png'))
        results.append({'scenario':'safe-bypass-retains-healthy-gui-and-missing-state-same-class-relocation','passed':True})
        page.get_by_role('button',name='导出混音',exact=True).click()
        page.locator('.editor-export-modal').get_by_role('button',name='导出混音',exact=True).click()
        expect(page.get_by_text('插件尾音已按 30 秒上限截断。导出文件可能未包含完整衰减。',exact=True)).to_be_visible()
        expect(page.locator('.editor-export-modal')).not_to_be_visible()
        page.wait_for_timeout(400)
        page.screenshot(path=str(args.output_dir/'plugin-export-tail-warning-980x680.png'))
        assert page.evaluate('__editor.lastExport.pluginTailLimited') is True
        results.append({'scenario':'export-tail-limit-visible-warning','shown':True})
        page.evaluate('__scanDelay=1000')
        panel.get_by_role('button',name='扫描插件',exact=True).click()
        page.evaluate("() => {__editor.session={...__editor.session,id:'next-project',pluginChain:[],tracks:[],sources:[]}}")
        expect(panel).to_have_attribute('aria-busy','false')
        panel.locator('.n-select').nth(1).click()
        expect(page.locator('.n-base-select-option:visible')).to_have_count(0)
        page.keyboard.press('Escape')
        expect(panel.get_by_role('button',name='添加到插件链',exact=True)).to_be_disabled()
        results.append({'scenario':'late-scan-cannot-populate-another-project','passed':True})
        assert not errors,errors
        results.append({'scenario':'scan-add-reorder-bypass-remove-native-editor-master-loading-error-recovery','pageErrors':errors})
        context.close()
    browser.close()
    report={'results':results,'limitations':'Browser UI and mocked Tauri messages only. Native binaries, plugin windows, DSP, device output and three-platform compatibility are not exercised.'}
    (args.output_dir/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
