"""Verify editor default buttons and reset gestures with the real sliders and undo store."""
import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--url", default="http://127.0.0.1:1434")
parser.add_argument("--output-dir", type=Path, default=Path(".tmp/editor-slider-reset"))
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=["--no-proxy-server"])
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.set_default_timeout(15000)
    errors = []
    console_errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.add_init_script("""localStorage.setItem('pymss-studio:app-settings', JSON.stringify({
      startupOnboardingSeen:true,locale:'zh-CN',themeMode:'light'
    }))""")
    page.goto(args.url.rstrip("/") + "/#/editor", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_load_state("networkidle", timeout=60000)
    print("Editor loaded", flush=True)
    page.locator(".editor-transport").wait_for(state="visible")
    page.evaluate("""async () => {
      const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s;
      window.__editor = stores.get('editor');
      window.__saved = [];
      window.__TAURI_INTERNALS__ = {
        metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
        transformCallback:()=>1,
        invoke:async(command,args)=>{
          if(command==='save_editor_project') {
            __saved.push(structuredClone(args.project));
            return args.project;
          }
          if(command==='save_app_store'||command==='write_frontend_log') return;
          if(command==='plugin:event|listen'||command==='plugin:event|unlisten') return 1;
          throw new Error('Unexpected command: '+command);
        }
      };
      __editor.session = {
        id:'slider-reset-project',name:'Mix',masterVolume:0.65,masterPan:0.35,
        sources:[],tracks:[{id:'track',sourceId:'',role:'stem',name:'Vocals',
          volume:0.42,pan:-0.3,muted:false,solo:false,fadeIn:0,fadeOut:0,clips:[]}],
        createdAt:1,updatedAt:1
      };
      __editor.selectTrack('track');
      await document.querySelector('#app').__vue_app__.config.globalProperties.$router.replace({
        name:'editor',query:{projectId:'slider-reset-project'}
      });
    }""")
    toggle = page.locator(".editor-shell__inspector-toggle")
    toggle.wait_for(state="visible")
    if toggle.get_attribute("aria-pressed") == "false":
        toggle.click()
    inspector = page.locator(".editor-inspector")
    inspector.wait_for(state="visible")
    sliders = inspector.locator(".editor-parameter-slider")
    expect(sliders).to_have_count(2)
    results = []

    def value(expression):
        return page.evaluate(expression)

    def check_reset(slider, expression, default, label):
        before = value(expression)
        assert not value("__editor.canUndo"), label
        slider.scroll_into_view_if_needed()
        button = slider.locator(".editor-parameter-slider__reset")
        expect(button).to_be_enabled()
        assert button.get_attribute("aria-label")
        button.click()
        page.wait_for_function(f"{expression} === {default}")
        expect(button).to_be_disabled()
        assert value("__editor.canUndo"), label
        page.evaluate("__editor.undo()")
        page.wait_for_function(f"{expression} === {json.dumps(before)}")
        assert not value("__editor.canUndo"), f"{label}: intermediate undo entry"
        page.evaluate("__editor.redo()")
        page.wait_for_function(f"{expression} === {default}")
        page.evaluate("__editor.undo()")
        page.wait_for_function(f"{expression} === {json.dumps(before)}")
        results.append(label)
        print(f"Default reset and undo verified: {label}", flush=True)

    cases = [("volume", 1), ("pan", 0)]
    for index, (field, default) in enumerate(cases):
        check_reset(sliders.nth(index), f"__editor.session.tracks[0].{field}", default, field)

    # The surrounding field must not forward rail clicks to the reset button.
    rail = sliders.first.locator(".n-slider")
    box = rail.bounding_box()
    assert box is not None
    page.mouse.click(box["x"] + box["width"] * 0.85, box["y"] + box["height"] / 2)
    page.wait_for_function("__editor.session.tracks[0].volume!==0.42")
    assert value("__editor.session.tracks[0].volume") > 1.5, "rail click also activated Default"
    page.evaluate("__editor.undo()")
    assert value("__editor.session.tracks[0].volume") == 0.42
    sliders.first.locator(".editor-parameter-slider__reset").focus()
    page.keyboard.press("Space")
    page.wait_for_function("__editor.session.tracks[0].volume===1")
    page.evaluate("__editor.undo()")
    assert value("__editor.session.tracks[0].volume") == 0.42
    assert not value("__editor.canUndo")
    print("Inspector rail and Space activation verified", flush=True)

    page.locator(".master-summary").click()
    master = page.locator(".master-popover .editor-parameter-slider")
    expect(master).to_have_count(2)
    for index, (field, default) in enumerate((("masterVolume", 1), ("masterPan", 0))):
        check_reset(master.nth(index), f"__editor.session.{field}", default, field)
    page.evaluate("""() => {
      window.__volumeUpdates=[];
      const update=__editor.setMasterVolume;
      __editor.setMasterVolume=value=>{__volumeUpdates.push(value);return update(value)};
    }""")
    # Double-click the thumb edge, where a positional mousedown would change gain.
    handle = master.first.locator("[role=slider]")
    box = handle.bounding_box()
    assert box is not None
    page.mouse.dblclick(box["x"] + box["width"] * 0.75, box["y"] + box["height"] / 2, delay=60)
    page.wait_for_function("__editor.masterVolume === 1")
    assert value("__volumeUpdates") == [1], f"thumb reset briefly changed the gain: {value('__volumeUpdates')}"
    print("Thumb edge reset verified", flush=True)
    page.evaluate("__editor.undo()")
    assert value("__editor.masterVolume") == 0.65
    assert not value("__editor.canUndo")
    page.evaluate("__editor.session.masterVolume=1")
    master.first.locator("[role=slider]").dblclick(delay=60)
    assert value("__editor.masterVolume") == 1
    assert not value("__editor.canUndo")

    page.evaluate("__editor.session.masterVolume=0.1;__editor.clearHistory();__volumeUpdates=[]")
    page.wait_for_function("document.querySelector('.master-popover [role=slider]').getAttribute('aria-valuenow')==='0.1'")
    rail = master.first.locator(".n-slider")
    box = rail.bounding_box()
    assert box is not None
    page.keyboard.down("Alt")
    try:
        page.mouse.click(box["x"] + box["width"] * 0.95, box["y"] + box["height"] / 2)
    finally:
        page.keyboard.up("Alt")
    page.wait_for_function("__editor.masterVolume===1")
    assert value("__volumeUpdates") == [1], "Alt reset briefly jumped toward 190%"
    print("Alt reset verified", flush=True)
    page.evaluate("__editor.undo()")
    assert value("__editor.masterVolume") == 0.1
    assert not value("__editor.canUndo")

    page.evaluate("__volumeUpdates=[]")
    page.wait_for_function("document.querySelector('.master-popover [role=slider]').getAttribute('aria-valuenow')==='0.1'")
    page.mouse.dblclick(box["x"] + box["width"] * 0.95, box["y"] + box["height"] / 2, delay=60)
    page.wait_for_function("__editor.masterVolume>1.7")
    assert value("__volumeUpdates") == [value("__editor.masterVolume")], "rail double-click unexpectedly reset gain"
    master.first.locator(".editor-parameter-slider__reset").focus()
    page.keyboard.press("Enter")
    page.wait_for_function("__editor.masterVolume===1")

    master.last.locator(".editor-parameter-slider__reset").click()
    page.wait_for_function("__editor.masterPan === 0")
    page.evaluate("__editor.saveProject()")
    assert value("__saved.at(-1).masterVolume") == 1
    assert value("__saved.at(-1).masterPan") == 0
    assert "100%" in master.first.locator(".editor-parameter-slider__reset").get_attribute("title")
    page.screenshot(path=str(args.output_dir / "reset-controls.png"), full_page=True)
    page.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings').themeMode='dark'")
    page.wait_for_timeout(250)
    page.screenshot(path=str(args.output_dir / "reset-controls-dark.png"), full_page=True)
    assert not errors, errors
    assert not console_errors, console_errors
    browser.close()
    print(json.dumps({"resetControls": results, "gainWithoutIntermediateValues": "passed", "keyboard": "passed",
                      "undoRedo": "passed", "save": "passed"}, ensure_ascii=False))
