import { Bar, Ring, Spark, ThreadBars } from './primitives'
import { deviceStates, DesignProps, netMax } from './snapshot'
import { col, DASH, gb, num, poly, rate, rateStr, STATE, tempPct, TH } from './tokens'

/** Дизайн резервирует пять ячеек — при меньшем числе вентиляторов не растягиваем. */
function fanColumns(count: number): string {
  return `repeat(${Math.max(5, count)}, 1fr)`
}

export default function DenseConsole({ s, h, half }: DesignProps) {
  return half ? <DenseHalf s={s} h={h} half /> : <DenseFull s={s} h={h} half={false} />
}

/* ── 1920×1040 ─────────────────────────────────────────────── */
function DenseFull({ s, h }: DesignProps) {
  const cpuColor = col(s.cpu.load, TH.cpuLoad)
  const cpuTempColor = col(s.cpu.temp, TH.cpuTemp)
  const gpuColor = col(s.gpu.load, TH.gpuLoad)
  const gpuTempColor = col(s.gpu.temp, TH.gpuTemp)
  const nMax = netMax(h.netDown, h.netUp)
  const down = rate(s.net.downBps)
  const up = rate(s.net.upBps)

  return (
    <div className="d-dense">
      <header className="dc-top drag-region">
        <div className="dc-top-group">
          <span className="dc-host">{s.hostname}</span>
          <span>ДАТЧИКОВ {s.sensorCount ?? DASH}</span>
          <span>ОПРОС {s.pollMs ?? DASH} МС</span>
          <span>АПТАЙМ {s.uptime}</span>
          {s.ready && !s.elevated && <span style={{ color: STATE.warn }}>НЕТ ПРАВ АДМИНИСТРАТОРА</span>}
        </div>
        <div className="dc-top-group">
          <span>{s.date}</span>
          <span className="dc-clock">{s.clock}</span>
        </div>
      </header>

      <div className="dc-mid">
        {/* процессор */}
        <section className="dc-panel">
          <div className="dc-head">
            <span>ЦЕНТРАЛЬНЫЙ ПРОЦЕССОР</span>
            <span className="dc-head-meta">
              {s.cpu.cores ?? DASH} ЯДЕР / {s.cpu.threadCount} ПОТОКОВ
            </span>
          </div>

          <div className="dc-ring-row">
            <Ring
              loadPct={s.cpu.load}
              loadColor={cpuColor}
              tempPct={tempPct(s.cpu.temp)}
              tempColor={cpuTempColor}
              style={{ height: '100%', aspectRatio: '1' }}
            >
              <div className="dc-ring-value" style={{ color: cpuColor }}>{num.int(s.cpu.load)}</div>
              <div className="dc-ring-label">ЗАГРУЗКА %</div>
            </Ring>
          </div>

          <div className="dc-stats">
            <div className="dc-stat-group">
              <div>
                <div className="dc-stat-v" style={{ color: cpuTempColor }}>{num.deg(s.cpu.temp)}</div>
                <div className="dc-stat-l">ТЕМПЕРАТУРА</div>
              </div>
              <div>
                <div className="dc-stat-v">{num.ghz(s.cpu.clockGHz)}</div>
                <div className="dc-stat-l">ГГЦ СРЕДН.</div>
              </div>
              <div>
                <div className="dc-stat-v">{num.watt(s.cpu.powerW)}</div>
                <div className="dc-stat-l">ВАТТ</div>
              </div>
            </div>
            <div className="dc-stat-group right">
              <div>
                <div className="dc-stat-v" style={{ color: col(s.cpu.maxCoreTemp, TH.cpuTemp) }}>
                  {num.deg(s.cpu.maxCoreTemp)}
                </div>
                <div className="dc-stat-l">МАКС. ЯДРО</div>
              </div>
              <div>
                <div className="dc-stat-v">{s.cpu.minThread == null ? DASH : `${num.int(s.cpu.minThread)}%`}</div>
                <div className="dc-stat-l">МИН. ПОТОК</div>
              </div>
            </div>
          </div>

          <div className="dc-block">
            <div className="dc-block-label">ЗАГРУЗКА ПО ПОТОКАМ</div>
            <ThreadBars values={s.cpu.threads} threshold={TH.thread} gap={4} className="dc-threads" />
            <div className="dc-block-foot">
              <span>T0</span>
              <span>T{Math.max(0, s.cpu.threads.length - 1)}</span>
            </div>
          </div>
        </section>

        {/* видеокарта */}
        <section className="dc-panel">
          <div className="dc-head">
            <span>ГРАФИЧЕСКИЙ ПРОЦЕССОР</span>
            <span className="dc-head-meta">{num.one(s.gpu.vramTotalGB)} ГБ VRAM</span>
          </div>

          <div className="dc-ring-row">
            <Ring
              loadPct={s.gpu.load}
              loadColor={gpuColor}
              tempPct={tempPct(s.gpu.temp)}
              tempColor={gpuTempColor}
              style={{ height: '100%', aspectRatio: '1' }}
            >
              <div className="dc-ring-value" style={{ color: gpuColor }}>{num.int(s.gpu.load)}</div>
              <div className="dc-ring-label">ЯДРО %</div>
            </Ring>
          </div>

          <div className="dc-stats">
            <div className="dc-stat-group">
              <div>
                <div className="dc-stat-v" style={{ color: gpuTempColor }}>{num.deg(s.gpu.temp)}</div>
                <div className="dc-stat-l">ТЕМПЕРАТУРА</div>
              </div>
              <div>
                <div className="dc-stat-v">{num.int(s.gpu.coreMHz)}</div>
                <div className="dc-stat-l">МГЦ ЯДРО</div>
              </div>
              <div>
                <div className="dc-stat-v">{num.watt(s.gpu.powerW)}</div>
                <div className="dc-stat-l">ВАТТ</div>
              </div>
            </div>
            <div className="dc-stat-group right">
              <div>
                <div className="dc-stat-v" style={{ color: col(s.gpu.hotspot, TH.gpuHotspot) }}>
                  {num.deg(s.gpu.hotspot)}
                </div>
                <div className="dc-stat-l">HOTSPOT</div>
              </div>
              <div>
                <div className="dc-stat-v">{num.one(s.gpu.vramUsedGB)}</div>
                <div className="dc-stat-l">ГБ VRAM</div>
              </div>
            </div>
          </div>

          <div className="dc-gpu-bottom">
            <div>
              <div className="dc-meter-head">
                <span>ВИДЕОПАМЯТЬ</span>
                <b>{num.one(s.gpu.vramUsedGB)} / {num.one(s.gpu.vramTotalGB)} ГБ</b>
              </div>
              <Bar pct={s.gpu.vramPct} color={col(s.gpu.vramPct, TH.vram)} height={14} />
            </div>

            <div>
              <div className="dc-meter-head">
                <span>ШИНА ПАМЯТИ</span>
                <b>{num.int(s.gpu.busPct)} %</b>
              </div>
              <Bar pct={s.gpu.busPct ?? 0} color="#4c5256" height={14} />
            </div>

            <div className="dc-block">
              <div className="dc-block-label">ЗАГРУЗКА ПО БЛОКАМ</div>
              <div className="dc-engines">
                {s.gpu.engines.map(e => (
                  <div className="dc-engine" key={e.name}>
                    <div className="dc-engine-track">
                      <div
                        className="dc-engine-fill"
                        style={{ height: `${e.value ?? 0}%`, background: col(e.value, TH.thread) }}
                      />
                    </div>
                    <div className="dc-engine-foot">
                      <span>{e.name}</span>
                      <b>{e.value == null ? DASH : `${e.value}%`}</b>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="dc-gpu-foot">
              <span>ПАМЯТЬ {num.int(s.gpu.memMHz)} МГЦ</span>
              <span>ВЕНТИЛЯТОР {num.int(s.gpu.fanPct)} %</span>
              <span>{s.gpu.name}</span>
            </div>
          </div>
        </section>

        {/* правая колонка */}
        <div className="dc-side">
          <section className="dc-sub">
            <div className="dc-head"><span>ОПЕРАТИВНАЯ ПАМЯТЬ</span></div>
            <div className="dc-ram-row">
              <span className="dc-ram-used" style={{ color: col(s.ram.pct, TH.ram) }}>{num.one(s.ram.usedGB)}</span>
              <span className="dc-ram-total">/ {num.one(s.ram.totalGB)} ГБ</span>
              <span className="dc-ram-pct" style={{ color: col(s.ram.pct, TH.ram) }}>{num.int(s.ram.pct)}%</span>
            </div>
            <Bar pct={s.ram.pct} color={col(s.ram.pct, TH.ram)} height={14} />
            <div className="dc-kv">
              <span>ФАЙЛ ПОДКАЧКИ</span>
              <b>{num.one(s.ram.swapUsedGB)} / {num.one(s.ram.swapTotalGB)} ГБ</b>
            </div>
            <Bar pct={s.ram.swapPct} color="#4c5256" height={8} />
          </section>

          <section className="dc-sub">
            <div className="dc-head">
              <span>НАКОПИТЕЛИ</span>
              <span className="dc-head-meta">ЧТ / ЗП МБ/С</span>
            </div>
            {s.disks.map(d => (
              <div className="dc-disk" key={d.name}>
                <div className="dc-disk-head">
                  <span className="dc-disk-name">{d.name}</span>
                  <b>
                    {d.rw}
                    <span style={{ color: col(d.temp, TH.diskTemp) }}> · {d.asleep ? 'СОН' : num.deg(d.temp)}</span>
                  </b>
                </div>
                <Bar pct={d.usedPct} color={col(d.usedPct, TH.diskSpace)} height={8} />
                <div className="dc-disk-foot">
                  <span>ЗАНЯТО {gb(d.usedGB)} ИЗ {gb(d.totalGB)}</span>
                  <b>СВОБОДНО {gb(d.freeGB)}</b>
                </div>
              </div>
            ))}
          </section>

          <section className="dc-sub">
            <div className="dc-head">
              <span>СЕТЬ</span>
              <span className="dc-head-meta">{s.net.nic.toUpperCase()}</span>
            </div>
            <div className="dc-net-nums">
              <div>
                <div className="dc-net-v">{down.value}</div>
                <div className="dc-net-l">ВХОД {down.unit.toUpperCase()}</div>
              </div>
              <div>
                <div className="dc-net-v">{up.value}</div>
                <div className="dc-net-l">ИСХОД {up.unit.toUpperCase()}</div>
              </div>
            </div>
            <div className="dc-graph">
              <Spark
                lines={[
                  { points: poly(h.netDown, nMax), stroke: '#8b9296' },
                  { points: poly(h.netUp, nMax), stroke: '#474d51' },
                ]}
              />
            </div>
            <div className="dc-note">
              {s.net.label} · ПИНГ {num.int(s.net.pingMs)} МС · ШКАЛА {rateStr(nMax).toUpperCase()}
            </div>
          </section>
        </div>
      </div>

      {/* нижняя полоса */}
      <div className="dc-bottom">
        <section className="dc-bcell">
          <div className="dc-head"><span>ВЕНТИЛЯТОРЫ</span></div>
          <div className="dc-fans" style={{ gridTemplateColumns: fanColumns(s.fans.length) }}>
            {s.fans.length === 0 && <div className="dc-note">ДАТЧИКИ НЕДОСТУПНЫ</div>}
            {s.fans.map(f => (
              <div className="dc-fan" key={f.name}>
                <div className="dc-fan-name">{f.name.toUpperCase()}</div>
                <div className="dc-fan-rpm">{f.rpm > 0 ? f.rpm : DASH}</div>
                <Bar pct={f.pct} color="#5b6165" height={6} />
                <div className="dc-fan-pct">{num.int(f.pct)} % ОТ МАКС.</div>
              </div>
            ))}
          </div>
        </section>

        <section className="dc-bcell">
          <div className="dc-head"><span>ТЕМПЕРАТУРЫ, 45 С</span></div>
          <div className="dc-temp-graph">
            <Spark
              lines={[
                { points: poly(h.cpuTemp, 100), stroke: cpuTempColor },
                { points: poly(h.gpuTemp, 100), stroke: '#7d8387' },
              ]}
            />
          </div>
          <div className="dc-legend">
            <span>— ЦП {num.deg(s.cpu.temp)}</span>
            <span>— ГП {num.deg(s.gpu.temp)}</span>
            <span>ПОРОГ 80°</span>
          </div>
        </section>

        <section className="dc-bcell">
          <div className="dc-head"><span>СОСТОЯНИЕ</span></div>
          <div className="dc-states">
            {deviceStates(s).map(st => (
              <div className="dc-state" key={st.label}>
                <div className="dc-state-dot" style={{ background: st.color }} />
                <span className="dc-state-label">{st.label}</span>
                <span className="dc-state-value" style={{ color: st.color }}>{st.value}</span>
              </div>
            ))}
          </div>
          <div className="dc-foot-note">НОРМА · ТЕПЛО ≥ 70 · ЖАРКО ≥ 85</div>
        </section>
      </div>
    </div>
  )
}

/* ── 960×1040 ──────────────────────────────────────────────── */
function DenseHalf({ s }: DesignProps) {
  const down = rate(s.net.downBps)
  const up = rate(s.net.upBps)
  const cpuColor = col(s.cpu.load, TH.cpuLoad)
  const cpuTempColor = col(s.cpu.temp, TH.cpuTemp)
  const gpuColor = col(s.gpu.load, TH.gpuLoad)
  const gpuTempColor = col(s.gpu.temp, TH.gpuTemp)

  return (
    <div className="d-dense half">
      <header className="dc-top drag-region">
        <span className="dc-host">{s.hostname}</span>
        <span style={s.ready && !s.elevated ? { color: STATE.warn } : undefined}>
          {s.ready && !s.elevated ? 'НЕТ ПРАВ АДМИНИСТРАТОРА' : `АПТАЙМ ${s.uptime}`}
        </span>
        <span className="dc-clock">{s.clock}</span>
      </header>

      <div className="dc-modules">
        <div className="dch-row">
          <Ring
            loadPct={s.cpu.load}
            loadColor={cpuColor}
            tempPct={tempPct(s.cpu.temp)}
            tempColor={cpuTempColor}
            style={{ height: '100%', aspectRatio: '1' }}
          >
            <div className="dch-ring-value" style={{ color: cpuColor }}>{num.int(s.cpu.load)}</div>
            <div className="dch-ring-label">ЗАГРУЗКА %</div>
          </Ring>
          <div className="dch-col">
            <div className="dch-title">ПРОЦЕССОР</div>
            <div className="dch-stats">
              <div>
                <div className="dch-stat-v" style={{ color: cpuTempColor }}>{num.deg(s.cpu.temp)}</div>
                <div className="dch-stat-l">ТЕМПЕРАТУРА</div>
              </div>
              <div>
                <div className="dch-stat-v">{num.ghz(s.cpu.clockGHz)}</div>
                <div className="dch-stat-l">ГГЦ СРЕДН.</div>
              </div>
              <div>
                <div className="dch-stat-v">{num.watt(s.cpu.powerW)}</div>
                <div className="dch-stat-l">ВАТТ</div>
              </div>
            </div>
            <ThreadBars values={s.cpu.threads} threshold={TH.thread} gap={2} className="dch-threads" />
          </div>
        </div>

        <div className="dch-row">
          <Ring
            loadPct={s.gpu.load}
            loadColor={gpuColor}
            tempPct={tempPct(s.gpu.temp)}
            tempColor={gpuTempColor}
            style={{ height: '100%', aspectRatio: '1' }}
          >
            <div className="dch-ring-value" style={{ color: gpuColor }}>{num.int(s.gpu.load)}</div>
            <div className="dch-ring-label">ЯДРО %</div>
          </Ring>
          <div className="dch-col">
            <div className="dch-title">ВИДЕОКАРТА</div>
            <div className="dch-stats">
              <div>
                <div className="dch-stat-v" style={{ color: gpuTempColor }}>{num.deg(s.gpu.temp)}</div>
                <div className="dch-stat-l">ТЕМПЕРАТУРА</div>
              </div>
              <div>
                <div className="dch-stat-v" style={{ color: col(s.gpu.hotspot, TH.gpuHotspot) }}>
                  {num.deg(s.gpu.hotspot)}
                </div>
                <div className="dch-stat-l">HOTSPOT</div>
              </div>
              <div>
                <div className="dch-stat-v">{num.watt(s.gpu.powerW)}</div>
                <div className="dch-stat-l">ВАТТ</div>
              </div>
            </div>
            <div className="dch-vram">
              <div className="dch-vram-head">
                <span>ВИДЕОПАМЯТЬ</span>
                <b>{num.one(s.gpu.vramUsedGB)} / {num.one(s.gpu.vramTotalGB)} ГБ</b>
              </div>
              <Bar pct={s.gpu.vramPct} color={col(s.gpu.vramPct, TH.vram)} height={12} />
            </div>
          </div>
        </div>

        <div className="dch-block">
          <div className="dch-head">
            <span>ПАМЯТЬ</span>
            <b>{num.one(s.ram.usedGB)} / {num.one(s.ram.totalGB)} ГБ · {num.int(s.ram.pct)} %</b>
          </div>
          <Bar pct={s.ram.pct} color={col(s.ram.pct, TH.ram)} height={16} />
          <div className="dc-kv">
            <span>ФАЙЛ ПОДКАЧКИ</span>
            <b>{num.one(s.ram.swapUsedGB)} / {num.one(s.ram.swapTotalGB)} ГБ</b>
          </div>
          <Bar pct={s.ram.swapPct} color="#4c5256" height={8} />
          <div className="dch-fans">
            {s.fans.map(f => (
              <span key={f.name}>
                {f.name.toUpperCase()} <b>{f.rpm > 0 ? f.rpm : DASH}</b>
              </span>
            ))}
          </div>
        </div>

        <div className="dch-block">
          <div className="dch-head">
            <span>ДИСКИ И СЕТЬ</span>
            <span className="meta">СВОБОДНО · ЧТ / ЗП МБ/С</span>
          </div>
          {s.disks.map(d => (
            <div className="dch-disk" key={d.name}>
              <span className="dch-disk-name">{d.name}</span>
              <Bar pct={d.usedPct} color={col(d.usedPct, TH.diskSpace)} height={8} className="dch-disk-bar" />
              <span className="dch-disk-free">{gb(d.freeGB)}</span>
              <span className="dch-disk-rw">{d.rw}</span>
              <span className="dch-disk-temp" style={{ color: col(d.temp, TH.diskTemp) }}>{d.asleep ? 'СОН' : num.deg(d.temp)}</span>
            </div>
          ))}
          <div className="dch-net">
            <div>
              <div className="dch-net-v">{down.value}</div>
              <div className="dch-net-l">ВХОД {down.unit.toUpperCase()}</div>
            </div>
            <div>
              <div className="dch-net-v">{up.value}</div>
              <div className="dch-net-l">ИСХОД {up.unit.toUpperCase()}</div>
            </div>
            <div className="dch-net-note">
              {s.net.label} · ПИНГ {num.int(s.net.pingMs)} МС
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
