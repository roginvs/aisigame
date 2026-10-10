const ones: Record<string, number> = {
  ноль: 0,
  один: 1,
  одна: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
}

const teens: Record<string, number> = {
  десять: 10,
  одиннадцать: 11,
  двенадцать: 12,
  тринадцать: 13,
  четырнадцать: 14,
  пятнадцать: 15,
  шестнадцать: 16,
  семнадцать: 17,
  восемнадцать: 18,
  девятнадцать: 19,
}

const tens: Record<string, number> = {
  двадцать: 20,
  тридцать: 30,
  сорок: 40,
  пятьдесят: 50,
  шестьдесят: 60,
  семьдесят: 70,
  восемьдесят: 80,
  девяносто: 90,
}

const hundreds: Record<string, number> = {
  сто: 100,
  двести: 200,
  триста: 300,
  четыреста: 400,
  пятьсот: 500,
  шестьсот: 600,
  семьсот: 700,
  восемьсот: 800,
  девятьсот: 900,
}

export function parseBet(text: string, max: number): number | null {
  if (max < 1) return null
  const clean = text.trim().toLowerCase().replaceAll('ё', 'е')
  if (/ва[-\s]?банк|ол-?ин|all-?in|^все$/.test(clean) || /\bвсе\b/.test(clean)) return max
  const digits = clean.match(/\d+/)
  if (digits) return clamp(Number(digits[0]), max)
  const words = clean.replace(/[^a-zа-я\s]/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return null
  let total = 0
  let current = 0
  let seen = false
  for (const word of words) {
    if (word === 'тысяча' || word === 'тысячи' || word === 'тысяч') {
      current = (current || 1) * 1000
      total += current
      current = 0
      seen = true
      continue
    }
    const value = hundreds[word] ?? tens[word] ?? teens[word] ?? ones[word]
    if (value === undefined) continue
    current += value
    seen = true
  }
  total += current
  if (!seen || total < 1) return null
  return clamp(total, max)
}

function clamp(amount: number, max: number): number | null {
  if (!Number.isInteger(amount) || amount < 1 || amount > max) return null
  return amount
}
