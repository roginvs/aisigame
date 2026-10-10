import { useEffect, useId, useRef, type RefObject } from 'react'
import { attachQuestionMeter, readMeterLevels } from '../audio/questionMeter.ts'

/** Стрелка в покое смотрит влево, как на магнитофоне. */
export const meterRestAngle = -46
const meterSweep = 92
const attackRate = 28
const releaseRate = 9

const leftPivot = { x: 108, y: 92 }
const rightPivot = { x: 292, y: 92 }

export function QuestionMeter(props: { node: HTMLMediaElement | null; live: boolean }) {
  const { node, live } = props
  const rawId = useId()
  const wellId = `vu-well-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const leftRef = useRef<SVGGElement>(null)
  const rightRef = useRef<SVGGElement>(null)

  useEffect(() => {
    const leftNeedle = leftRef.current
    const rightNeedle = rightRef.current
    if (!leftNeedle || !rightNeedle) return
    placeNeedle(leftNeedle, 0, leftPivot)
    placeNeedle(rightNeedle, 0, rightPivot)
    if (!live || !node) return

    let graph: ReturnType<typeof attachQuestionMeter> | null = null
    try {
      graph = attachQuestionMeter(node)
    } catch {
      return
    }

    let frame = 0
    let last = performance.now()
    const shown = { left: 0, right: 0 }
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const target = node.paused ? { left: 0, right: 0 } : readMeterLevels(graph)
      shown.left = glide(shown.left, target.left, dt)
      shown.right = glide(shown.right, target.right, dt)
      placeNeedle(leftNeedle, shown.left, leftPivot)
      placeNeedle(rightNeedle, shown.right, rightPivot)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [node, live])

  return (
    <div className="vu-meter" role="img" aria-label="Уровень звука">
      <svg viewBox="0 0 400 136">
        <defs>
          <radialGradient id={wellId} cx="50%" cy="38%" r="68%">
            <stop offset="0%" stopColor="#243140" />
            <stop offset="100%" stopColor="#0c1118" />
          </radialGradient>
        </defs>
        <rect x="0.5" y="0.5" width="399" height="135" rx="18" fill="#121920" stroke="#3d4e60" />
        <Dial cx={leftPivot.x} cy={leftPivot.y} label="L" wellId={wellId} needle={leftRef} />
        <Dial cx={rightPivot.x} cy={rightPivot.y} label="R" wellId={wellId} needle={rightRef} />
      </svg>
    </div>
  )
}

function Dial(props: {
  cx: number
  cy: number
  label: string
  wellId: string
  needle: RefObject<SVGGElement | null>
}) {
  const { cx, cy, label, wellId, needle } = props
  const ticks = [-46, -32, -18, -6, 6, 18, 32, 46]
  return (
    <g>
      <circle cx={cx} cy={cy} r="78" fill={`url(#${wellId})`} />
      <path d={arc(cx, cy, 66, -46, 46)} fill="none" stroke="#8ea0b3" strokeWidth="1.4" />
      <path d={arc(cx, cy, 66, 22, 46)} fill="none" stroke="#d4654f" strokeWidth="3" />
      {ticks.map((deg) => {
        const major = deg === -46 || deg === 6 || deg === 46
        const [x1, y1] = point(cx, cy, major ? 54 : 58, deg)
        const [x2, y2] = point(cx, cy, 70, deg)
        return (
          <line
            key={deg}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={major ? '#f4efe4' : '#6d7d8e'}
            strokeWidth={major ? 1.7 : 1}
          />
        )
      })}
      <g ref={needle} transform={`rotate(${meterRestAngle} ${cx} ${cy})`}>
        <line
          x1={cx}
          y1={cy + 14}
          x2={cx}
          y2={cy - 58}
          stroke="#f4efe4"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r="4.5" fill="#e2c27a" />
        <circle cx={cx} cy={cy} r="1.7" fill="#121920" />
      </g>
      <text
        x={cx}
        y={cy + 30}
        textAnchor="middle"
        fill="#8ea0b3"
        fontSize="13"
        fontFamily="Segoe UI, sans-serif"
      >
        {label}
      </text>
    </g>
  )
}

function placeNeedle(node: SVGGElement, unit: number, pivot: { x: number; y: number }): void {
  const angle = meterRestAngle + meterSweep * clamp(unit)
  node.setAttribute('transform', `rotate(${angle.toFixed(2)} ${pivot.x} ${pivot.y})`)
}

function glide(current: number, target: number, dt: number): number {
  const rate = target > current ? attackRate : releaseRate
  const next = current + (target - current) * (1 - Math.exp(-rate * dt))
  return next < 0.004 ? 0 : next
}

function clamp(unit: number): number {
  if (unit < 0) return 0
  if (unit > 1) return 1
  return unit
}

function point(cx: number, cy: number, radius: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180
  return [cx + radius * Math.sin(rad), cy - radius * Math.cos(rad)]
}

function arc(cx: number, cy: number, radius: number, from: number, to: number): string {
  const [x0, y0] = point(cx, cy, radius, from)
  const [x1, y1] = point(cx, cy, radius, to)
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius} ${radius} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}
