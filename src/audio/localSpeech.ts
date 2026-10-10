export function speakExact(text: string): Promise<void> {
  const synth = window.speechSynthesis
  if (!synth || !text.trim()) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve()
    }
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = 'ru-RU'
    utter.rate = 1
    const voice = synth.getVoices().find((item) => item.lang.toLowerCase().startsWith('ru'))
    if (voice) utter.voice = voice
    utter.onend = finish
    utter.onerror = finish
    const timer = window.setTimeout(finish, Math.min(15_000, 900 + text.length * 90))
    synth.cancel()
    synth.speak(utter)
  })
}
