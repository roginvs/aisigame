export type VideoInput = Pick<MediaDeviceInfo, 'deviceId' | 'kind'>

/** Следующая камера в стабильном порядке enumerateDevices, с переходом в начало. */
export function nextCameraDeviceId(devices: readonly VideoInput[], currentDeviceId: string | null): string | null {
  const cameras = devices.filter((device) => device.kind === 'videoinput' && device.deviceId)
  if (cameras.length === 0) return null
  const current = cameras.findIndex((device) => device.deviceId === currentDeviceId)
  return cameras[(current + 1) % cameras.length]?.deviceId ?? null
}
