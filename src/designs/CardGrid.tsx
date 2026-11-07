import { Bar, Spark, ThreadBars } from './primitives'
import { deviceStates, DesignProps, netMax } from './snapshot'
import { col, DASH, gb, num, poly, rate, rateStr, STATE, TH } from './tokens'

export default function CardGrid({ s, h, half }: DesignProps) {
  return half ? <CardsHalf s={s} h={h} half /> : <CardsFull s={s} h={h} half={false} />
}

/* ── 1920×1040 ─────────────────────────────────────────────── */
function CardsFull({ s, h }: DesignProps) {
  const cpuColor = col(s.cpu.load, TH.cpuLoad)
  const gpuColor = col(s.gpu.load, TH.gpuLoad)
  const ramColor = col(s.ram.pct, TH.ram)
  const nMax = netMax(h.netDown, h.netUp)
  const down = rate(s.net.downBps)
  const up = rate(s.net.upBps)

  return (
    <div className="d-cards">
      <header className="cg-top drag-region">
        <div className="cg-top-left">
          <span className="cg-host">{s.hostname}</span>
          <span className="cg-meta">
            {s.os} · аптайм {s.uptime}
            {s.sensorCount != null && ` · ${s.sensorCount} датчиков`}
            {s.ready && !s.elevated && (
              <b style={{ color: STATE.warn, fontWeight: 400 }}> · нет прав администратора</b>
            )}
          </span>
        </div>
        <div className="cg-top-right">
          <span className="cg-date">{s.date}</span>
          <span className="cg-clock">{s.clock}</span>
        </div>
      </header>

      <div className="cg-grid">
        {/* процессор */}
        <section className="cg-card cg-span2">
          <div className="cg-card-head">
            <span className="cg-label">ПРОЦЕССОР</span>
            <span className="cg-card-meta">
              {s.cpu.cores ?? DASH} ядер · {s.cpu.threadCount} потоков
            </span>
          </div>
          <div className="cg-headline">
            <div className="cg-big">
              <span className="cg-big-num" style={{ color: cpuColor }}>{num.int(s.cpu.load)}</span>
              <span className="cg-big-unit">%</span>
            </div>
            <div className="cg-secondary">
              <div>
                <div className="cg-sec-v" style={{ color: col(s.cpu.temp, TH.cpuTemp) }}>{num.deg(s.cpu.temp)}</div>
                <div className="cg-sec-l">температура</div>
              </div>
              <div>
                <div className="cg-sec-v">{num.ghz(s.cpu.clockGHz)}</div>
                <div className="cg-sec-l">ГГц</div>
              </div>
              <div>
                <div className="cg-sec-v" style={{ color: col(s.cpu.maxCoreTemp, TH.cpuTemp) }}>
                  {num.deg(s.cpu.maxCoreTemp)}
                </div>
                <div className="cg-sec-l">макс. ядро</div>
              </div>
              <div>
                <div className="cg-sec-v">{num.watt(s.cpu.powerW)}</div>
                <div className="cg-sec-l">Вт</div>
              </div>
            </div>
          </div>
          <div className="cg-spark">
            <Spark lines={[{ points: poly(h.cpuLoad, 100), stroke: cpuColor, width: 1.5 }]} />
          </div>
          <ThreadBars values={s.cpu.threads} threshold={TH.thread} gap={5} className="cg-threads" />
        </section>

        {/* видеокарта */}
        <section className="cg-card cg-span2">
          <div className="cg-card-head">
            <span className="cg-label">ВИДЕОКАРТА</span>
            <span className="cg-card-meta">{s.gpu.name}</span>
          </div>
          <div className="cg-headline">
            <div className="cg-big">
              <span className="cg-big-num" style={{ color: gpuColor }}>{num.int(s.gpu.load)}</span>
              <span className="cg-big-unit">%</span>
            </div>
            <div className="cg-secondary">
              <div>
                <div className="cg-sec-v" style={{ color: col(s.gpu.temp, TH.gpuTemp) }}>{num.deg(s.gpu.temp)}</div>
                <div className="cg-sec-l">температура</div>
              </div>
              <div>
                <div className="cg-sec-v" style={{ color: col(s.gpu.hotspot, TH.gpuHotspot) }}>
                  {num.deg(s.gpu.hotspot)}
                </div>
                <div className="cg-sec-l">hotspot</div>
              </div>
              <div>
                <div className="cg-sec-v">{s.gpu.fanPct == null ? DASH : `${num.int(s.gpu.fanPct)}%`}</div>
                <div className="cg-sec-l">вентилятор</div>
              </div>
              <div>
                <div className="cg-sec-v">{num.watt(s.gpu.powerW)}</div>
                <div className="cg-sec-l">Вт</div>
              </div>
            </div>
          </div>
          <div className="cg-spark">
            <Spark lines={[{ points: poly(h.gpuLoad, 100), stroke: gpuColor, width: 1.5 }]} />
          </div>
          <div className="cg-meter">
            <div className="cg-meter-head">
              <span>видеопамять</span>
              <b>{num.one(s.gpu.vramUsedGB)} / {num.one(s.gpu.vramTotalGB)} ГБ</b>
            </div>
            <Bar pct={s.gpu.vramPct} color={col(s.gpu.vramPct, TH.vram)} height={10} className="cg-bar" />
          </div>
        </section>

        {/* память */}
        <section className="cg-card cg-span2">
          <span className="cg-label">ПАМЯТЬ</span>
          <div className="cg-mem-row">
            <div className="cg-mem-big">
              <span className="cg-mem-num" style={{ color: ramColor }}>{num.one(s.ram.usedGB)}</span>
              <span className="cg-mem-total">/ {num.one(s.ram.totalGB)} ГБ</span>
            </div>
            <div className="cg-mem-side">
              <div className="cg-mem-side-v">{num.int(s.ram.pct)}%</div>
              <div className="cg-mem-side-l">занято</div>
            </div>
            <div className="cg-mem-side right">
              <div className="cg-mem-side-v">{num.one(s.ram.swapUsedGB)}</div>
              <div className="cg-mem-side-l">файл подкачки, ГБ</div>
            </div>
          </div>
          <Bar pct={s.ram.pct} color={ramColor} height={12} className="cg-bar" />
          <Bar pct={s.ram.swapPct} color="#4e5458" height={8} className="cg-bar" />
        </section>

        {/* сеть */}
        <section className="cg-card">
          <span className="cg-label">СЕТЬ</span>
          <div className="cg-net">
            <div>
              <div className="cg-net-v">{down.value}</div>
              <div className="cg-net-l">входящий, {down.unit}</div>
            </div>
            <div>
              <div className="cg-net-v">{up.value}</div>
              <div className="cg-net-l">исходящий, {up.unit}</div>
            </div>
          </div>
          <div className="cg-spark">
            <Spark
              lines={[
                { points: poly(h.netDown, nMax), stroke: '#878d91', width: 1.5 },
                { points: poly(h.netUp, nMax), stroke: '#4a5054', width: 1.5 },
              ]}
            />
          </div>
          <div className="cg-net-note">{s.net.label} · шкала {rateStr(nMax)}</div>
        </section>

        {/* вентиляторы */}
        <section className="cg-card">
          <span className="cg-label">ВЕНТИЛЯТОРЫ</span>
          <div className="cg-fans">
            {s.fans.length === 0 && <span className="cg-empty">датчики недоступны</span>}
            {s.fans.map(f => (
              <div className="cg-fan-row" key={f.name}>
                <span className="cg-fan-name">{f.name}</span>
                <Bar pct={f.pct} color="#5d6367" height={6} className="cg-fan-bar cg-bar" />
                <span className="cg-fan-rpm">{f.rpm > 0 ? f.rpm : DASH}</span>
              </div>
            ))}
          </div>
        </section>

        {/* накопители */}
        <section className="cg-card cg-span3">
          <div className="cg-card-head">
            <span className="cg-label">НАКОПИТЕЛИ</span>
            <span className="cg-card-meta">занято / свободно · чтение / запись МБ/с · температура</span>
          </div>
          <div className="cg-disks">
            {s.disks.length === 0 && <span className="cg-empty">накопители не найдены</span>}
            {s.disks.map(d => (
              <div className="cg-disk-row" key={d.name}>
                <span className="cg-disk-name">{d.name}</span>
                <Bar pct={d.usedPct} color={col(d.usedPct, TH.diskSpace)} height={10} className="cg-disk-bar cg-bar" />
                <span className="cg-disk-space">
                  {gb(d.usedGB)} <i>/ {gb(d.freeGB)} своб.</i>
                </span>
                <span className="cg-disk-rw">{d.rw}</span>
                <span className="cg-disk-temp" style={{ color: col(d.temp, TH.diskTemp) }}>{d.asleep ? 'сон' : num.deg(d.temp)}</span>
              </div>
            ))}
          </div>
        </section>

        {/* состояние */}
        <section className="cg-card">
          <span className="cg-label">СОСТОЯНИЕ</span>
          {deviceStates(s).map(st => (
            <div className="cg-state-row" key={st.label}>
              <div className="cg-state-dot" style={{ background: st.color }} />
              <span className="cg-state-label">{st.label}</span>
              <span className="cg-state-value" style={{ color: st.color }}>{st.value}</span>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}

/* ── 960×1040 ──────────────────────────────────────────────── */
function CardsHalf({ s, h }: DesignProps) {
  const cpuColor = col(s.cpu.load, TH.cpuLoad)
  const gpuColor = col(s.gpu.load, TH.gpuLoad)
  const ramColor = col(s.ram.pct, TH.ram)
  const nMax = netMax(h.netDown, h.netUp)
  const down = rate(s.net.downBps)
  const up = rate(s.net.upBps)

  return (
    <div className="d-cards half">
      <header className="cg-top drag-region">
        <span className="cg-host">{s.hostname}</span>
        <span className="cg-clock">{s.clock}</span>
      </header>

      <div className="cg-grid">
        <section className="cg-card cg-span2">
          <div className="cg-card-head">
            <span className="cg-label">ПРОЦЕССОР</span>
            <span className="cg-card-meta">{s.cpu.cores ?? DASH}C / {s.cpu.threadCount}T</span>
          </div>
          <div className="cg-headline">
            <div className="cg-big">
              <span className="cg-big-num" style={{ color: cpuColor }}>{num.int(s.cpu.load)}</span>
              <span className="cg-big-unit">%</span>
            </div>
            <div className="cg-secondary">
              <div>
                <div className="cg-sec-v" style={{ color: col(s.cpu.temp, TH.cpuTemp) }}>{num.deg(s.cpu.temp)}</div>
                <div className="cg-sec-l">темп.</div>
              </div>
              <div>
                <div className="cg-sec-v">{num.ghz(s.cpu.clockGHz)}</div>
                <div className="cg-sec-l">ГГц</div>
              </div>
              <div>
                <div className="cg-sec-v">{num.watt(s.cpu.powerW)}</div>
                <div className="cg-sec-l">Вт</div>
              </div>
            </div>
          </div>
          <div className="cg-spark">
            <Spark lines={[{ points: poly(h.cpuLoad, 100), stroke: cpuColor, width: 1.5 }]} />
          </div>
          <ThreadBars values={s.cpu.threads} threshold={TH.thread} gap={4} className="cg-threads" />
        </section>

        <section className="cg-card cg-span2">
          <div className="cg-card-head">
            <span className="cg-label">ВИДЕОКАРТА</span>
            <span className="cg-card-meta">{num.one(s.gpu.vramTotalGB)} ГБ</span>
          </div>
          <div className="cg-headline">
            <div className="cg-big">
              <span className="cg-big-num" style={{ color: gpuColor }}>{num.int(s.gpu.load)}</span>
              <span className="cg-big-unit">%</span>
            </div>
            <div className="cg-secondary">
              <div>
                <div className="cg-sec-v" style={{ color: col(s.gpu.temp, TH.gpuTemp) }}>{num.deg(s.gpu.temp)}</div>
                <div className="cg-sec-l">темп.</div>
              </div>
              <div>
                <div className="cg-sec-v">{num.one(s.gpu.vramUsedGB)}</div>
                <div className="cg-sec-l">ГБ VRAM</div>
              </div>
              <div>
                <div className="cg-sec-v">{num.watt(s.gpu.powerW)}</div>
                <div className="cg-sec-l">Вт</div>
              </div>
            </div>
          </div>
          <div className="cg-spark">
            <Spark lines={[{ points: poly(h.gpuLoad, 100), stroke: gpuColor, width: 1.5 }]} />
          </div>
          <Bar pct={s.gpu.vramPct} color={col(s.gpu.vramPct, TH.vram)} height={10} className="cg-bar" />
        </section>

        <section className="cg-card">
          <span className="cg-label">ПАМЯТЬ</span>
          <div className="cg-mem-big">
            <span className="cg-mem-num" style={{ color: ramColor }}>{num.one(s.ram.usedGB)}</span>
            <span className="cg-mem-total">/ {num.one(s.ram.totalGB)} ГБ</span>
          </div>
          <Bar pct={s.ram.pct} color={ramColor} height={10} className="cg-bar" />
          <div className="cg-meter-head">
            <span>подкачка</span>
            <b>{num.one(s.ram.swapUsedGB)} ГБ</b>
          </div>
          <Bar pct={s.ram.swapPct} color="#4e5458" height={7} className="cg-bar" />
        </section>

        <section className="cg-card">
          <span className="cg-label">СЕТЬ</span>
          <div className="cg-net">
            <div>
              <div className="cg-net-v">{down.value}</div>
              <div className="cg-net-l">вх. {down.unit}</div>
            </div>
            <div>
              <div className="cg-net-v">{up.value}</div>
              <div className="cg-net-l">исх. {up.unit}</div>
            </div>
          </div>
          <div className="cg-spark">
            <Spark lines={[{ points: poly(h.netDown, nMax), stroke: '#878d91', width: 1.5 }]} />
          </div>
        </section>

        <section className="cg-card cg-span2">
          <div className="cg-card-head">
            <span className="cg-label">НАКОПИТЕЛИ И ВЕНТИЛЯТОРЫ</span>
            <span className="cg-card-meta">свободно · чт / зп · аптайм {s.uptime}</span>
          </div>
          <div className="cg-disks">
            {s.disks.map(d => (
              <div className="cg-disk-row" key={d.name}>
                <span className="cg-disk-name">{d.name}</span>
                <Bar pct={d.usedPct} color={col(d.usedPct, TH.diskSpace)} height={8} className="cg-disk-bar cg-bar" />
                <span className="cg-disk-space">{gb(d.freeGB)}</span>
                <span className="cg-disk-rw">{d.rw}</span>
                <span className="cg-disk-temp" style={{ color: col(d.temp, TH.diskTemp) }}>{d.asleep ? 'сон' : num.deg(d.temp)}</span>
              </div>
            ))}
          </div>
          <div className="cg-inline-fans">
            {s.fans.map(f => (
              <span key={f.name}>
                {f.name} <b>{f.rpm > 0 ? f.rpm : DASH}</b>
              </span>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
