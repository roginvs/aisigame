export type VideoInput = Pick<MediaDeviceInfo, 'deviceId' | 'kind'>

/** Следующая камера в стабильном порядке enumerateDevices, с переходом в начало. */
export function nextCameraDeviceId(devices: readonly VideoInput[], currentDeviceId: string | null): string | null {
  const cameras = devices.filter((device) => device.kind === 'videoinput' && device.deviceId)
  if (cameras.length === 0) return null
  const current = cameras.findIndex((device) => device.deviceId === currentDeviceId)
  return cameras[(current + 1) % cameras.length]?.deviceId ?? null
}

export type CameraFacing = 'user' | 'environment'

/** Телефон/планшет: две камеры одновременно не держит, переключаем по facingMode. */
export function isMobileCameraDevice(nav: { userAgent?: string; maxTouchPoints?: number; platform?: string } | undefined): boolean {
  if (!nav) return false
  const ua = nav.userAgent ?? ''
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true
  // iPadOS притворяется Mac-ом: выдаёт тач.
  return /Mac/i.test(nav.platform ?? ua) && (nav.maxTouchPoints ?? 0) > 1
}

/** facingMode дорожки: настройки браузера, потом Jitsi, потом что сами просили. */
export function cameraFacing(settings: { facingMode?: string } | undefined, jitsiFacing: string | undefined, requested: CameraFacing | null): CameraFacing | null {
  for (const value of [settings?.facingMode, jitsiFacing, requested]) {
    if (value === 'user' || value === 'environment') return value
  }
  return null
}

/** Зеркалим только свою картинку и только фронтальную; неизвестную свою — тоже. Чужие — никогда. */
export function shouldMirrorVideo(isLocal: boolean, facing: CameraFacing | null): boolean {
  return isLocal && facing !== 'environment'
}

/**
 * Смена камеры на телефоне: сначала освобождаем старую, потом открываем другую по facingMode;
 * не вышло — открываем прежнюю обратно и сообщаем ошибку.
 */
export async function switchFacingCamera<T>(ops: {
  current: CameraFacing
  release: () => Promise<void>
  open: (facing: CameraFacing) => Promise<T>
  install: (track: T, facing: CameraFacing) => Promise<void>
  dispose: (track: T) => void
}): Promise<{ facing: CameraFacing; restored: boolean; error?: unknown }> {
  const next: CameraFacing = ops.current === 'user' ? 'environment' : 'user'
  await ops.release()
  let error: unknown
  for (const [facing, restored] of [[next, false], [ops.current, true]] as const) {
    let track: T | null = null
    try {
      track = await ops.open(facing)
      await ops.install(track, facing)
      return restored ? { facing, restored, error } : { facing, restored }
    } catch (failure) {
      if (track) ops.dispose(track)
      if (!restored) error = failure
      else throw error ?? failure
    }
  }
  throw error
}
