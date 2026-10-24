import type { EditorTrackEffects } from '../types/editor'

export type EditorEffectNodes = {
  balanceMerger?: ChannelMergerNode | null
  clarityFilter?: BiquadFilterNode | null
  compressorNode?: DynamicsCompressorNode | null
  effectDryGain?: GainNode | null
  reverbNode?: ConvolverNode | null
  reverbWetGain?: GainNode | null
  delayNode?: DelayNode | null
  delayFeedbackGain?: GainNode | null
  delayWetGain?: GainNode | null
  effectOutputGain?: GainNode | null
  effectsSignature?: string
  effectsRoutingSignature?: string
}

const impulses = new WeakMap<BaseAudioContext, AudioBuffer>()
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function createEditorEffectNodes(ctx: BaseAudioContext) {
  const nodes = {
    balanceMerger: ctx.createChannelMerger(2),
    clarityFilter: ctx.createBiquadFilter(),
    compressorNode: ctx.createDynamicsCompressor(),
    effectDryGain: ctx.createGain(),
    reverbNode: ctx.createConvolver(),
    reverbWetGain: ctx.createGain(),
    delayNode: ctx.createDelay(1.2),
    delayFeedbackGain: ctx.createGain(),
    delayWetGain: ctx.createGain(),
    effectOutputGain: ctx.createGain(),
  }
  nodes.effectDryGain.connect(nodes.effectOutputGain)
  nodes.reverbWetGain.connect(nodes.effectOutputGain)
  nodes.delayWetGain.connect(nodes.effectOutputGain)
  return nodes
}

function reverbImpulse(ctx: BaseAudioContext) {
  const cached = impulses.get(ctx)
  if (cached) return cached
  const length = Math.max(1, Math.floor(ctx.sampleRate * 1.35))
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let index = 0; index < data.length; index++) {
      const decay = Math.pow(1 - index / data.length, 2.4)
      const stereoDelay = channel === 1 && index < Math.floor(ctx.sampleRate * .013)
      const noise = Math.sin((index + 1) * 12.9898 + channel * 78.233) * 43758.5453
      data[index] = stereoDelay ? 0 : ((noise - Math.floor(noise)) * 2 - 1) * decay * (index === 0 ? .7 : .22)
    }
  }
  impulses.set(ctx, buffer)
  return buffer
}

/** Preview and export must configure and route the same native effects. */
export function applyEditorTrackEffects(entry: EditorEffectNodes, effects: EditorTrackEffects | undefined, ctx: BaseAudioContext) {
  if (!entry.clarityFilter || !entry.compressorNode || !entry.effectDryGain || !entry.reverbWetGain || !entry.delayWetGain || !entry.delayNode || !entry.delayFeedbackGain) return
  const reverb = clamp(Number(effects?.reverb ?? 0), 0, 1)
  const delay = clamp(Number(effects?.delay ?? 0), 0, 1)
  const delayTime = clamp(Number(effects?.delayTime ?? .24), .05, 1.2)
  const clarity = clamp(Number(effects?.clarity ?? 0), 0, 1)
  const compressor = clamp(Number(effects?.compressor ?? 0), 0, 1)
  const signature = [reverb, delay, delayTime, clarity, compressor].join(':')
  if (entry.effectsSignature === signature) return
  entry.effectsSignature = signature
  entry.clarityFilter.type = 'highpass'
  entry.clarityFilter.frequency.value = 20 + clarity * 180
  entry.clarityFilter.Q.value = .7
  entry.compressorNode.threshold.value = compressor > 0 ? -36 + compressor * 14 : -100
  entry.compressorNode.ratio.value = compressor > 0 ? 1 + compressor * 7 : 1
  entry.compressorNode.knee.value = compressor > 0 ? 18 : 0
  entry.compressorNode.attack.value = .003
  entry.compressorNode.release.value = .25
  entry.effectDryGain.gain.value = 1
  entry.reverbWetGain.gain.value = reverb * .45
  entry.delayWetGain.gain.value = delay * .38
  entry.delayNode.delayTime.value = delayTime
  entry.delayFeedbackGain.gain.value = delay * .52
  if (!entry.balanceMerger || !entry.effectOutputGain) return
  const routingSignature = [clarity > 0, compressor > 0, reverb > 0, delay > 0].join(':')
  if (entry.effectsRoutingSignature === routingSignature) return
  entry.effectsRoutingSignature = routingSignature
  entry.balanceMerger.disconnect()
  entry.clarityFilter.disconnect()
  entry.compressorNode.disconnect()
  entry.reverbNode?.disconnect()
  entry.delayNode.disconnect()
  entry.delayFeedbackGain.disconnect()
  let input: AudioNode = entry.balanceMerger
  if (clarity > 0) { input.connect(entry.clarityFilter); input = entry.clarityFilter }
  if (compressor > 0) { input.connect(entry.compressorNode); input = entry.compressorNode }
  input.connect(entry.effectDryGain)
  if (reverb > 0 && entry.reverbNode) {
    if (!entry.reverbNode.buffer) entry.reverbNode.buffer = reverbImpulse(ctx)
    input.connect(entry.reverbNode)
    entry.reverbNode.connect(entry.reverbWetGain)
  }
  if (delay > 0) {
    input.connect(entry.delayNode)
    entry.delayNode.connect(entry.delayFeedbackGain)
    entry.delayFeedbackGain.connect(entry.delayNode)
    entry.delayNode.connect(entry.delayWetGain)
  }
}
