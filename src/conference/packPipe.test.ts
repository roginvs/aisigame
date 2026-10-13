import { expect, it, vi } from 'vitest'
import { createPackPipeJoiner } from './packPipe.ts'

it.each(['closed', 'failed'])('recreates the joiner peer after a %s channel', async (failure) => {
  class FakeChannel {
    label = 'aisigame-pack'
    binaryType = 'arraybuffer'
    readyState = 'open'
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: (() => void) | null = null
    close = vi.fn()
  }
  const peers: FakePeer[] = []
  class FakePeer {
    constructor() { peers.push(this) }
    localDescription: { sdp: string } | null = null
    connectionState = 'connected'
    onicecandidate = null
    ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null
    onconnectionstatechange = null
    setRemoteDescription = vi.fn(async () => {})
    createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer' }))
    async setLocalDescription(desc: { sdp: string }) { this.localDescription = desc }
    close = vi.fn()
  }
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  const sendSignal = vi.fn()
  const joiner = createPackPipeJoiner({
    clientId: 'guest', authToken: 'token', sendSignal,
    onOpen: vi.fn(), onState: vi.fn(), onInbound: vi.fn(),
  })
  const offer = { type: 'packPipeOffer', targetClientId: 'guest', authorityToken: 'master', sdp: 'offer' } as const
  try {
    joiner.handleSignal(offer)
    await vi.waitFor(() => expect(sendSignal).toHaveBeenCalledTimes(1))
    const channel = new FakeChannel()
    peers[0]!.ondatachannel?.({ channel })
    channel.onopen?.()
    if (failure === 'closed') channel.onclose?.()
    else channel.onerror?.()
    joiner.handleSignal(offer)
    await vi.waitFor(() => expect(sendSignal).toHaveBeenCalledTimes(2))
    expect(peers).toHaveLength(2)
    expect(peers[0]!.close).toHaveBeenCalledOnce()
    expect(channel.close).toHaveBeenCalledOnce()
    expect(peers[1]!.setRemoteDescription).toHaveBeenCalledOnce()
  } finally {
    joiner.dispose()
    vi.unstubAllGlobals()
  }
})
