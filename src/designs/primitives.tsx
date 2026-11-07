import { CSSProperties, ReactNode } from 'react'
import { arc, col, Threshold } from './tokens'

/**
 * Кольцевой датчик: внешнее кольцо — нагрузка, внутреннее — температура.
 * Цифры внутри — HTML-оверлей, а не текст в SVG (шрифт приложения, без дрожания).
 * Цвета дорожек берутся из CSS-переменных варианта дизайна.
 */
export function Ring({
  loadPct,
  loadColor,
  tempPct,
  tempColor,
  style,
  children,
}: {
  loadPct: number
  loadColor: string
  tempPct: number
  tempColor: string
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <div className="ring" style={style}>
      <svg viewBox="0 0 200 200">
        <circle cx="100" cy="100" r="82" fill="none" stroke="var(--ring-track-outer)" strokeWidth="14" />
        <circle
          cx="100" cy="100" r="82" fill="none"
          stroke={loadColor} strokeWidth="14"
          strokeDasharray={arc(loadPct, 82)}
          transform="rotate(-90 100 100)"
        />
        <circle cx="100" cy="100" r="62" fill="none" stroke="var(--ring-track-inner)" strokeWidth="5" />
        <circle
          cx="100" cy="100" r="62" fill="none"
          stroke={tempColor} strokeWidth="5"
          strokeDasharray={arc(tempPct, 62)}
          transform="rotate(-90 100 100)"
        />
      </svg>
      <div className="ring-overlay">{children}</div>
    </div>
  )
}

export interface SparkLine {
  points: string
  stroke: string
  width?: number
}

/** Плоский график: polyline в viewBox 0 0 100 40, толщина не масштабируется. */
export function Spark({ lines, className }: { lines: SparkLine[]; className?: string }) {
  return (
    <svg className={className ? `spark ${className}` : 'spark'} viewBox="0 0 100 40" preserveAspectRatio="none">
      {lines.map((l, i) => (
        <polyline
          key={i}
          points={l.points}
          fill="none"
          stroke={l.stroke}
          strokeWidth={l.width ?? 1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}

/** Горизонтальная шкала заполнения. */
export function Bar({
  pct,
  color,
  height,
  className,
}: {
  pct: number
  color: string
  height: number
  className?: string
}) {
  return (
    <div className={className ? `bar ${className}` : 'bar'} style={{ height }}>
      <div className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  )
}

/** Гистограмма загрузки по потокам: одна колонка на поток. */
export function ThreadBars({
  values,
  threshold,
  gap,
  className,
  style,
}: {
  values: number[]
  threshold: Threshold
  gap: number
  className?: string
  style?: CSSProperties
}) {
  const cols = values.length || 1
  return (
    <div
      className={className ? `threads ${className}` : 'threads'}
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gap, ...style }}
    >
      {values.map((v, i) => (
        <div className="thread-track" key={i}>
          <div className="thread-fill" style={{ height: `${Math.max(0, Math.min(100, v))}%`, background: col(v, threshold) }} />
        </div>
      ))}
    </div>
  )
}

/** Полукруглый датчик вентилятора (вариант 1c). */
export function FanDial({ pct, rpm, height }: { pct: number; rpm: number; height: number }) {
  const len = Math.PI * 38
  const filled = (len * Math.max(0, Math.min(100, pct))) / 100
  return (
    <div className="fan-dial" style={{ height }}>
      <svg viewBox="0 0 100 62">
        <path d="M 12 54 A 38 38 0 0 1 88 54" fill="none" stroke="var(--ring-track-outer)" strokeWidth="8" />
        <path
          d="M 12 54 A 38 38 0 0 1 88 54"
          fill="none"
          stroke="#6b7175"
          strokeWidth="8"
          strokeDasharray={`${filled.toFixed(1)} ${len.toFixed(1)}`}
        />
      </svg>
      <div className="fan-dial-value">{rpm > 0 ? rpm : '—'}</div>
    </div>
  )
}
