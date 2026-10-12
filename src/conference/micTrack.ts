/** Underlying browser track for a Jitsi local audio/video track. */
export function mediaStreamTrackFromJitsi(track: {
  getTrack?: () => MediaStreamTrack | undefined
  getOriginalStream?: () => MediaStream | undefined
} | null | undefined): MediaStreamTrack | null {
  if (!track) return null
  const direct = track.getTrack?.()
  if (direct) return direct
  const stream = track.getOriginalStream?.()
  return stream?.getAudioTracks()[0] ?? null
}

/** True when the device track is gone — mute/unmute alone will not bring audio back. */
export function micTrackIsDead(track: MediaStreamTrack | null | undefined): boolean {
  return !track || track.readyState === 'ended'
}
