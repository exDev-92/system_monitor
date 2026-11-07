import { Bar, FanDial, Ring, Spark, ThreadBars } from './primitives'
import { DesignProps, netMax } from './snapshot'
import { col, DASH, gb, num, poly, rate, rateStr, STATE, tempPct, TH } from './tokens'

/** Дизайн резервирует пять ячеек — при меньшем числе вентиляторов не растягиваем. */
function fanColumns(count: number): string {
  return `repeat(${Math.max(5, count)}, 1fr)`
}

/** История под кольцом: загрузка ярче, температура приглушённее — шкала общая, 0…100. */
function HudHistory({ load, temp }: { load: number[]; temp: number[] }) {
  return (
    <div className="hud-history">
      <div className="hud-meter-head">
        <span>ИСТОРИЯ</span>
        <span>ЗАГРУЗКА % · ТЕМПЕРАТУРА °</span>
      </div>
      <div className="hud-graph">
        <Spark
          lines={[
            { points: poly(temp, 100), stroke: '#484e51', width: 1.2 },
            { points: poly(load, 100), stroke: '#8b9195', width: 1.2 },
          ]}
        />
      </div>
    </div>
  )
}

export default function IndustrialHud({ s, h, half }: DesignProps) {
  return half ? <HudHalf s={s} h={h} half /> : <HudFull s={s} h={h} half={false} />
}

/* ── 1920×1040 ─────────────────────────────────────────────── */
function HudFull({ s, h }: DesignProps) {
  const nMax = netMax(h.netDown, h.netUp)
  const ramColor = col(s.ram.pct, TH.ram)
  const down = rate(s.net.downBps)
  const up = rate(s.net.upBps)

  return (
    <div className="d-hud">
      <header className="hud-top drag-region">
        <div className="hud-top-group">
          <span className="hud-host">{s.hostname}</span>
          <span style={s.ready && !s.elevated ? { color: STATE.warn } : undefined}>
            {s.ready && !s.elevated ? 'НЕТ ПРАВ АДМИНИСТРАТОРА' : 'ТЕЛЕМЕТРИЯ АКТИВНА'}
          </span>
          <span>АПТАЙМ {s.uptime}</span>
        </div>
        <div className="hud-top-group">
          <span>{s.date}</span>
          <span className="hud-clock">{s.clock}</span>
        </div>
      </header>

      <div className="hud-mid">
        {/* процессор */}
        <section className="hud-panel">
          <div className="hud-head">
            <span>ПРОЦЕССОР</span>
            <span className="hud-head-meta">{s.cpu.cores ?? DASH}C / {s.cpu.threadCount}T</span>
          </div>
          <Ring
            loadPct={s.cpu.load}
            loadColor={col(s.cpu.load, TH.cpuLoad)}
            tempPct={tempPct(s.cpu.temp)}
            tempColor={col(s.cpu.temp, TH.cpuTemp)}
            style={{ width: 268, height: 268 }}
          >
            <div className="hud-ring-value">{num.int(s.cpu.load)}</div>
            <div className="hud-ring-label">ЗАГРУЗКА %</div>
          </Ring>
          <div className="hud-stats">
            <div>
              <div className="hud-stat-v" style={{ color: col(s.cpu.temp, TH.cpuTemp) }}>{num.deg(s.cpu.temp)}</div>
              <div className="hud-stat-l">ТЕМПЕРАТУРА</div>
            </div>
            <div>
              <div className="hud-stat-v">{num.ghz(s.cpu.clockGHz)}</div>
              <div className="hud-stat-l">ГГЦ</div>
            </div>
            <div>
              <div className="hud-stat-v" style={{ color: col(s.cpu.maxCoreTemp, TH.cpuTemp) }}>
                {num.deg(s.cpu.maxCoreTemp)}
              </div>
              <div className="hud-stat-l">МАКС. ЯДРО</div>
            </div>
            <div>
              <div className="hud-stat-v">{num.watt(s.cpu.powerW)}</div>
              <div className="hud-stat-l">ВАТТ</div>
            </div>
          </div>
          <HudHistory load={h.cpuLoad} temp={h.cpuTemp} />
          <div className="hud-block">
            <div className="hud-meter-head"><span>ЗАГРУЗКА ПО ПОТОКАМ</span></div>
            <ThreadBars values={s.cpu.threads} threshold={TH.thread} gap={4} className="hud-threads" />
          </div>
        </section>

        {/* видеокарта */}
        <section className="hud-panel">
          <div className="hud-head">
            <span>ВИДЕОКАРТА</span>
            <span className="hud-head-meta">{num.one(s.gpu.vramTotalGB)} ГБ VRAM</span>
          </div>
          <Ring
            loadPct={s.gpu.load}
            loadColor={col(s.gpu.load, TH.gpuLoad)}
            tempPct={tempPct(s.gpu.temp)}
            tempColor={col(s.gpu.temp, TH.gpuTemp)}
            style={{ width: 268, height: 268 }}
          >
            <div className="hud-ring-value">{num.int(s.gpu.load)}</div>
            <div className="hud-ring-label">ЯДРО %</div>
          </Ring>
          <div className="hud-stats">
            <div>
              <div className="hud-stat-v" style={{ color: col(s.gpu.temp, TH.gpuTemp) }}>{num.deg(s.gpu.temp)}</div>
              <div className="hud-stat-l">ТЕМПЕРАТУРА</div>
            </div>
            <div>
              <div className="hud-stat-v" style={{ color: col(s.gpu.hotspot, TH.gpuHotspot) }}>
                {num.deg(s.gpu.hotspot)}
              </div>
              <div className="hud-stat-l">HOTSPOT</div>
            </div>
            <div>
              <div className="hud-stat-v">{s.gpu.fanPct == null ? DASH : `${num.int(s.gpu.fanPct)}%`}</div>
              <div className="hud-stat-l">ВЕНТИЛЯТОР</div>
            </div>
            <div>
              <div className="hud-stat-v">{num.watt(s.gpu.powerW)}</div>
              <div className="hud-stat-l">ВАТТ</div>
            </div>
          </div>
          <HudHistory load={h.gpuLoad} temp={h.gpuTemp} />
          <div className="hud-block">
            <div className="hud-meter">
              <div className="hud-meter-head">
                <span>ВИДЕОПАМЯТЬ</span>
                <b>{num.one(s.gpu.vramUsedGB)} / {num.one(s.gpu.vramTotalGB)} ГБ</b>
              </div>
              <Bar pct={s.gpu.vramPct} color={col(s.gpu.vramPct, TH.vram)} height={16} />
            </div>
            <div className="hud-meter">
              <div className="hud-meter-head">
                <span>ШИНА ПАМЯТИ</span>
                <b>{num.int(s.gpu.busPct)} %</b>
              </div>
              <Bar pct={s.gpu.busPct ?? 0} color="#4e5458" height={10} />
            </div>
            <div className="hud-engines">
              {s.gpu.engines.map(e => (
                <span key={e.name}>{e.name} <b>{e.value == null ? DASH : `${e.value}%`}</b></span>
              ))}
            </div>
          </div>
        </section>

        {/* память + сеть */}
        <div className="hud-side">
          <section className="hud-sub">
            <div className="hud-sub-title">ПАМЯТЬ</div>
            <div className="hud-mem-row">
              <span className="hud-mem-used" style={{ color: ramColor }}>{num.one(s.ram.usedGB)}</span>
              <span className="hud-mem-total">/ {num.one(s.ram.totalGB)} ГБ</span>
              <span className="hud-mem-pct" style={{ color: ramColor }}>{num.int(s.ram.pct)}%</span>
            </div>
            <Bar pct={s.ram.pct} color={ramColor} height={20} />
            <div className="hud-meter-head">
              <span>ФАЙЛ ПОДКАЧКИ</span>
              <b>{num.one(s.ram.swapUsedGB)} / {num.one(s.ram.swapTotalGB)} ГБ</b>
            </div>
            <Bar pct={s.ram.swapPct} color="#4e5458" height={10} />
          </section>

          <section className="hud-sub">
            <div className="hud-sub-title">СЕТЬ</div>
            <div className="hud-net">
              <div>
                <div className="hud-net-v">{down.value}</div>
                <div className="hud-net-l">ВХОД {down.unit.toUpperCase()}</div>
              </div>
              <div>
                <div className="hud-net-v">{up.value}</div>
                <div className="hud-net-l">ИСХОД {up.unit.toUpperCase()}</div>
              </div>
            </div>
            <div className="hud-graph">
              <Spark
                lines={[
                  { points: poly(h.netDown, nMax), stroke: '#8b9195', width: 1.2 },
                  { points: poly(h.netUp, nMax), stroke: '#484e51', width: 1.2 },
                ]}
              />
            </div>
            <div className="hud-meter-head">
              <span>{s.net.label} · ПИНГ {num.int(s.net.pingMs)} МС</span>
              <b>ШКАЛА {rateStr(nMax).toUpperCase()}</b>
            </div>
          </section>
        </div>
      </div>

      {/* нижняя полоса */}
      <div className="hud-bottom">
        <section className="hud-bcell">
          <div className="hud-sub-title">ВЕНТИЛЯТОРЫ, RPM</div>
          <div className="hud-fans" style={{ gridTemplateColumns: fanColumns(s.fans.length) }}>
            {s.fans.length === 0 && <span className="hud-empty">ДАТЧИКИ НЕДОСТУПНЫ</span>}
            {s.fans.map(f => (
              <div className="hud-fan" key={f.name}>
                <FanDial pct={f.pct} rpm={f.rpm} height={70} />
                <div className="hud-fan-name">{f.name.toUpperCase()}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="hud-bcell">
          <div className="hud-head">
            <span>НАКОПИТЕЛИ</span>
            <span className="hud-head-meta">ЗАНЯТО / СВОБОДНО · ЧТ / ЗП МБ/С · ТЕМПЕРАТУРА</span>
          </div>
          {s.disks.length === 0 && <span className="hud-empty">НАКОПИТЕЛИ НЕ НАЙДЕНЫ</span>}
          {s.disks.map(d => (
            <div className="hud-disk-row" key={d.name}>
              <span className="hud-disk-name">{d.name}</span>
              <Bar pct={d.usedPct} color={col(d.usedPct, TH.diskSpace)} height={14} className="hud-disk-bar" />
              <span className="hud-disk-space">{gb(d.usedGB)} / {gb(d.freeGB)}</span>
              <span className="hud-disk-rw">{d.rw}</span>
              <span className="hud-disk-temp" style={{ color: col(d.temp, TH.diskTemp) }}>{d.asleep ? 'СОН' : num.deg(d.temp)}</span>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}

/* ── 960×1040 ──────────────────────────────────────────────── */
function HudHalf({ s, h }: DesignProps) {
  const nMax = netMax(h.netDown, h.netUp)
  const ramColor = col(s.ram.pct, TH.ram)
  const down = rate(s.net.downBps)
  const up = rate(s.net.upBps)

  return (
    <div className="d-hud half">
      <header className="hud-top drag-region">
        <span className="hud-host">{s.hostname}</span>
        <span className="hud-clock">{s.clock}</span>
      </header>

      <div className="hud-stack">
        <div className="hud-pair">
          <section className="hud-panel">
            <div className="hud-head"><span>ПРОЦЕССОР</span></div>
            <Ring
              loadPct={s.cpu.load}
              loadColor={col(s.cpu.load, TH.cpuLoad)}
              tempPct={tempPct(s.cpu.temp)}
              tempColor={col(s.cpu.temp, TH.cpuTemp)}
              style={{ width: 168, height: 168 }}
            >
              <div className="hud-ring-value">{num.int(s.cpu.load)}</div>
              <div className="hud-ring-label">ЗАГРУЗКА %</div>
            </Ring>
            <div className="hud-stats">
              <div>
                <div className="hud-stat-v" style={{ color: col(s.cpu.temp, TH.cpuTemp) }}>{num.deg(s.cpu.temp)}</div>
                <div className="hud-stat-l">ТЕМП.</div>
              </div>
              <div>
                <div className="hud-stat-v">{num.ghz(s.cpu.clockGHz)}</div>
                <div className="hud-stat-l">ГГЦ</div>
              </div>
              <div>
                <div className="hud-stat-v" style={{ color: col(s.cpu.maxCoreTemp, TH.cpuTemp) }}>
                  {num.deg(s.cpu.maxCoreTemp)}
                </div>
                <div className="hud-stat-l">МАКС.</div>
              </div>
              <div>
                <div className="hud-stat-v">{num.watt(s.cpu.powerW)}</div>
                <div className="hud-stat-l">ВТ</div>
              </div>
            </div>
          </section>

          <section className="hud-panel">
            <div className="hud-head"><span>ВИДЕОКАРТА</span></div>
            <Ring
              loadPct={s.gpu.load}
              loadColor={col(s.gpu.load, TH.gpuLoad)}
              tempPct={tempPct(s.gpu.temp)}
              tempColor={col(s.gpu.temp, TH.gpuTemp)}
              style={{ width: 168, height: 168 }}
            >
              <div className="hud-ring-value">{num.int(s.gpu.load)}</div>
              <div className="hud-ring-label">ЯДРО %</div>
            </Ring>
            <div className="hud-stats">
              <div>
                <div className="hud-stat-v" style={{ color: col(s.gpu.temp, TH.gpuTemp) }}>{num.deg(s.gpu.temp)}</div>
                <div className="hud-stat-l">ТЕМП.</div>
              </div>
              <div>
                <div className="hud-stat-v" style={{ color: col(s.gpu.hotspot, TH.gpuHotspot) }}>
                  {num.deg(s.gpu.hotspot)}
                </div>
                <div className="hud-stat-l">HOTSPOT</div>
              </div>
              <div>
                <div className="hud-stat-v">{num.one(s.gpu.vramUsedGB)}</div>
                <div className="hud-stat-l">ГБ</div>
              </div>
              <div>
                <div className="hud-stat-v">{num.watt(s.gpu.powerW)}</div>
                <div className="hud-stat-l">ВТ</div>
              </div>
            </div>
          </section>
        </div>

        <section className="hud-sub">
          <div className="hud-kv">
            <span>ПАМЯТЬ</span>
            <b>{num.one(s.ram.usedGB)} / {num.one(s.ram.totalGB)} ГБ</b>
          </div>
          <Bar pct={s.ram.pct} color={ramColor} height={20} />
          <div className="hud-meter-head">
            <span>ФАЙЛ ПОДКАЧКИ</span>
            <b>{num.one(s.ram.swapUsedGB)} / {num.one(s.ram.swapTotalGB)} ГБ</b>
          </div>
          <Bar pct={s.ram.swapPct} color="#4e5458" height={10} />
        </section>

        <section className="hud-sub">
          <div className="hud-head">
            <span>НАКОПИТЕЛИ</span>
            <span className="hud-head-meta">СВОБОДНО · ЧТ / ЗП</span>
          </div>
          {s.disks.map(d => (
            <div className="hud-disk-row" key={d.name}>
              <span className="hud-disk-name">{d.name}</span>
              <Bar pct={d.usedPct} color={col(d.usedPct, TH.diskSpace)} height={12} className="hud-disk-bar" />
              <span className="hud-disk-space">{gb(d.freeGB)}</span>
              <span className="hud-disk-rw">{d.rw}</span>
              <span className="hud-disk-temp" style={{ color: col(d.temp, TH.diskTemp) }}>{d.asleep ? 'СОН' : num.deg(d.temp)}</span>
            </div>
          ))}
        </section>

        <section className="hud-sub">
          <div className="hud-sub-title">ВЕНТИЛЯТОРЫ, RPM</div>
          <div className="hud-fans" style={{ gridTemplateColumns: fanColumns(s.fans.length) }}>
            {s.fans.length === 0 && <span className="hud-empty">ДАТЧИКИ НЕДОСТУПНЫ</span>}
            {s.fans.map(f => (
              <div className="hud-fan" key={f.name}>
                <FanDial pct={f.pct} rpm={f.rpm} height={54} />
                <div className="hud-fan-name">{f.name.toUpperCase()}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="hud-sub hud-grow">
          <div className="hud-head">
            <span>СЕТЬ</span>
            <span className="hud-head-meta">АПТАЙМ {s.uptime}</span>
          </div>
          <div className="hud-net">
            <div>
              <div className="hud-net-v">{down.value}</div>
              <div className="hud-net-l">ВХОД {down.unit.toUpperCase()}</div>
            </div>
            <div>
              <div className="hud-net-v">{up.value}</div>
              <div className="hud-net-l">ИСХОД {up.unit.toUpperCase()}</div>
            </div>
          </div>
          <div className="hud-graph">
            <Spark
              lines={[
                { points: poly(h.netDown, nMax), stroke: '#8b9195', width: 1.2 },
                { points: poly(h.netUp, nMax), stroke: '#484e51', width: 1.2 },
              ]}
            />
          </div>
        </section>
      </div>
    </div>
  )
}
