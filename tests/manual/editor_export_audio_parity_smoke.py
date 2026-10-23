"""Compare editor export PCM against the native preview graph in a real audio engine."""
import argparse
import json
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url', default='http://localhost:1420')
parser.add_argument('--browser', choices=['chromium', 'webkit'], default='chromium')
args = parser.parse_args()

with sync_playwright() as playwright:
    browser = getattr(playwright, args.browser).launch(headless=True)
    page = browser.new_page()
    page.add_init_script("localStorage.setItem('pymss-studio:app-settings',JSON.stringify({startupOnboardingSeen:true,beginnerGuideProgress:{status:'skipped',step:0}}))")
    page.goto(args.url)
    page.wait_for_load_state('networkidle')
    results = page.evaluate("""async()=>{
      const {renderEditorClip}=await import('/src/utils/editorRender.ts');
      const {createEditorEffectNodes,applyEditorTrackEffects}=await import('/src/utils/editorEffects.ts');
      const cases=[{}, {compressor:.62}, {clarity:.62}, {reverb:.35}, {delay:.28},
        {clarity:.62,compressor:.62,reverb:.35,delay:.28}];
      const results=[];
      for(const rate of [44100,48000])for(const channels of [1,2])for(const effect of cases){
        const duration=5.5,frames=Math.ceil((duration+2)*rate),offset=.125;
        const effects={clarity:0,compressor:0,reverb:0,delay:0,delayTime:.24,...effect};
        const track={volume:.82,pan:.25,effects};
        const clip={id:'clip',assetId:'input',start:0,offset,duration,volume:.76,fadeIn:.2,fadeOut:.3,muted:false};
        const source={id:'input',name:'input',path:'input.wav',channels,sampleRate:rate,duration:6};
        const data=Array.from({length:channels},(_,ch)=>Float32Array.from({length:6*rate},(_,i)=>{
          const t=i/rate,a=.12+.28*(.5+.5*Math.sin(t*3.7));
          return a*(Math.sin(2*Math.PI*(220+ch*37)*t)+.3*Math.sin(2*Math.PI*1100*t));
        }));
        const actualCtx=new OfflineAudioContext(2,frames,rate);
        const actual=await renderEditorClip(actualCtx,source,track,clip,async(_,index)=>{
          const start=index*4*rate,length=Math.min(4*rate,data[0].length-start);
          if(length<=0)return null;
          const buffer=actualCtx.createBuffer(channels,length,rate);
          for(let c=0;c<channels;c++)buffer.copyToChannel(data[c].subarray(start,start+length),c);
          return buffer;
        },new AbortController().signal);
        // A continuous source through the preview's native effect nodes is the
        // reference; export reads it in separate four-second decoder windows.
        const ctx=new OfflineAudioContext(2,frames,rate),nodes=createEditorEffectNodes(ctx);
        const input=ctx.createBufferSource(),clipGain=ctx.createGain(),volume=ctx.createGain();
        const splitter=ctx.createChannelSplitter(2),left=ctx.createGain(),right=ctx.createGain();
        const buffer=ctx.createBuffer(channels,data[0].length,rate);
        data.forEach((samples,c)=>buffer.copyToChannel(samples,c));input.buffer=buffer;
        input.connect(clipGain);clipGain.connect(volume);volume.gain.value=track.volume;
        volume.connect(splitter);splitter.connect(left,0);splitter.connect(right,channels===1?0:1);
        left.gain.value=.75;right.gain.value=1;
        left.connect(nodes.balanceMerger,0,0);right.connect(nodes.balanceMerger,0,1);
        applyEditorTrackEffects(nodes,effects,ctx);nodes.effectOutputGain.connect(ctx.destination);
        clipGain.gain.setValueAtTime(0,0);clipGain.gain.linearRampToValueAtTime(clip.volume,clip.fadeIn);
        clipGain.gain.setValueAtTime(clip.volume,duration-clip.fadeOut);clipGain.gain.linearRampToValueAtTime(0,duration);
        input.start(0,Math.round(offset*rate)/rate,duration);
        const expected=await ctx.startRendering();
        let error=0,energy=0,max=0;
        for(let c=0;c<2;c++){
          const a=actual.getChannelData(c),b=expected.getChannelData(c);
          for(let i=0;i<a.length;i++){const d=a[i]-b[i];error+=d*d;energy+=b[i]*b[i];max=Math.max(max,Math.abs(d));}
        }
        const relative=Math.sqrt(error/Math.max(1e-20,energy));
        if(energy<1e-6||relative>1e-5||max>1e-5)throw new Error(JSON.stringify({rate,channels,effect,relative,max,energy}));
        results.push({rate,channels,effect,relativeError:relative,maxSampleError:max});
      }
      return results;
    }""")
    print(json.dumps({'browser': args.browser, 'cases': len(results), 'maxSampleError': max(r['maxSampleError'] for r in results), 'maxRelativeError': max(r['relativeError'] for r in results)}, indent=2))
    browser.close()
