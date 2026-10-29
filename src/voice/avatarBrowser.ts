import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client'
import type { AvatarDeps } from './avatarLayer'

// Loaded only when a learner picks Avatar + Voice, so voice-only never downloads LiveKit.

const TAP_WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('clinicsim-tap', Tap)
`

export const browserAvatarDeps: AvatarDeps = {
  openSocket: (url) => new WebSocket(url) as unknown as ReturnType<AvatarDeps['openSocket']>,

  async joinRoom(url, token, media, onDisconnected) {
    const room = new Room({ adaptiveStream: true })
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Video) track.attach(media.video)
      else if (track.kind === Track.Kind.Audio) track.attach(media.audio)
    })
    let leaving = false
    room.on(RoomEvent.Disconnected, () => {
      if (!leaving) onDisconnected()
    })
    await room.connect(url, token)
    return {
      leave() {
        leaving = true
        void room.disconnect()
        media.video.srcObject = null
        media.audio.srcObject = null
      },
    }
  },

  async tap(stream, onFrame) {
    const context = new AudioContext()
    await context.resume().catch(() => undefined)
    const source = context.createMediaStreamSource(stream)
    // Pulled from the destination so the graph runs, but silent: the learner hears the avatar's audio instead.
    const sink = context.createGain()
    sink.gain.value = 0
    sink.connect(context.destination)
    let node: AudioNode
    if (context.audioWorklet) {
      const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }))
      await context.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      const worklet = new AudioWorkletNode(context, 'clinicsim-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' })
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data, context.sampleRate)
      node = worklet
    } else {
      const processor = context.createScriptProcessor(2048, 1, 1)
      processor.onaudioprocess = (e) => onFrame(e.inputBuffer.getChannelData(0).slice(0), context.sampleRate)
      node = processor
    }
    source.connect(node)
    node.connect(sink)
    return {
      stop() {
        source.disconnect()
        node.disconnect()
        void context.close().catch(() => undefined)
      },
    }
  },

  now: () => Date.now(),
}
