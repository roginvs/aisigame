export function createHostOutputReader(): (analyser: AnalyserNode | null) => number {
  let samples: Uint8Array<ArrayBuffer> | null = null
  return (analyser) => {
    if (!analyser) return 0
    if (!samples || samples.length !== analyser.fftSize) samples = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(samples)
    let sum = 0
    for (const value of samples) {
      const centered = (value - 128) / 128
      sum += centered * centered
    }
    const rms = Math.sqrt(sum / Math.max(1, samples.length))
    return Math.min(1, rms * 4)
  }
}
