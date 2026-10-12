/** Underlying browser track for a Jitsi local audio/video track. */
export function mediaStreamTrackFromJitsi(track: {
  getTrack?: () => MediaStreamTrack | undefined
  getOriginalStream?: () => MediaStream | undefined
} | null | undefined): MediaStreamTrack | null {
  if (!track) return null
  const direct = track.getTrack?.()
  if (direct) return direct
  const stream = track.getOriginalStream?.()
  if (!stream) return null
  return stream.getAudioTracks()[0] ?? stream.getVideoTracks()[0] ?? null
}

/** True when the device track is gone — mute/unmute alone will not bring audio back. */
export function micTrackIsDead(track: MediaStreamTrack | null | undefined): boolean {
  return !track || track.readyState === 'ended'
}

/** Живая незаглушенная видеодорожка — иначе плитка должна показать placeholder, не последний кадр. */
export function jitsiVideoLive(track: {
  isMuted?: () => boolean
  getTrack?: () => MediaStreamTrack | undefined
  getOriginalStream?: () => MediaStream | undefined
} | null | undefined): boolean {
  if (!track || track.isMuted?.()) return false
  return !micTrackIsDead(mediaStreamTrackFromJitsi(track))
}
