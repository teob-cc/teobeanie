// Energy.tsx — the Energy tab: what the house uses and pays now, today and over the
// periods, the price curve, a day's hours, the showers and what is wrong with the data.
// Read-only: it reads the ledger (api/energy, src/energy/types.ts) and never calls a
// service. Its tab shows once api/energy answers available: true.

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EnergyOverview, Ledger } from "../../../src/energy/types";
import type { HouseView } from "../../../src/house/view";
import { energySummary } from "../../../src/house/summary";
import { BarList, EnergyFlow } from "../components/HouseViz";
import { HourBars, PeriodBars, PriceBars } from "../components/EnergyCharts";
import { StatTile } from "../components/Tile";
import { rel } from "../format";
import {
  addDays,
  bandChip,
  byCarrier,
  copLine,
  byUse,
  clock,
  flagLabel,
  fmtEur,
  fmtKwh,
  fmtM3,
  fmtPrice,
  fmtQty,
  fmtWhen,
  perDegreeDay,
  PERIODS,
  periodTitle,
  priceMarks,
  priceNow,
  seasonVerdict,
  sumShowers,
  type MoneyRow,
  type Period,
} from "../energy";
import { useNow } from "../useHouse";
import { useEnergy, useHours, usePeriods, useSeasons, type LoadState } from "../useEnergy";
import type { VerticalProps } from "../verticals";

export function Energy({ connected, visible, house, onAvailable }: VerticalProps) {
  const { overview: o, error, loadedAt, reload } = useEnergy(visible, connected);
  const available = o?.available === true;
  useEffect(() => onAvailable(available), [available, onAvailable]);
  // Periods and hours load the first time the tab is opened, not before.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (visible) setOpened(true);
  }, [visible]);
  const now = useNow(30_000);
  const [day, setDay] = useState<string | null>(null);
  const today = o?.today.key ?? null;
  useEffect(() => {
    if (opened && day === null && today !== null) setDay(today);
  }, [opened, day, today]);

  if (o === null || !o.available) return null;
  return (
    <div className="energy">
      <header className="view-head">
        <h2>Energy</h2>
        <span className="muted small tnum">{loadedAt !== null ? `updated ${rel(now, loadedAt)}` : ""}</span>
      </header>
      {error !== null && (
        <div className="banner" role="alert">
          could not refresh the energy figures: {error}
          <button onClick={reload}>retry</button>
        </div>
      )}
      <NowBand o={o} house={house} now={now} />
      <MoneyBand o={o} enabled={opened} selectedDay={day} onDay={setDay} />
      <PricesBand o={o} now={now} />
      <DayBand o={o} day={day} onDay={setDay} />
      <HeatPumpBand enabled={opened} stamp={loadedAt} />
      <ShowersBand o={o} />
      {/* TODO(E3): a Comfort band (rooms against their setpoints, the boiler, the ventilation) belongs here, from its own lane. */}
      <DataBand o={o} />
    </div>
  );
}

function Band({ title, line, children }: { title: string; line?: ReactNode; children: ReactNode }) {
  return (
    <section className="eband" aria-label={title}>
      <header className="eband-head">
        <h3 className="eband-title">{title}</h3>
        {line !== undefined && <span className="eband-line">{line}</span>}
      </header>
      <div className="eband-body">{children}</div>
    </section>
  );
}

/** A route that answered 404 or an error: a plain sentence instead of the band's content. */
function Unavailable({ state, what, error }: { state: LoadState; what: string; error: string | null }) {
  if (state === "loading") return <p className="muted small">loading {what}…</p>;
  if (state === "missing") return <p className="muted small">This version of the add-on does not serve {what} yet; an update brings it.</p>;
  return <p className="muted small">Could not load {what}{error !== null ? ` (${error})` : ""}.</p>;
}

// ---- now -------------------------------------------------------------------------

function NowBand({ o, house, now }: { o: EnergyOverview; house: HouseView | null; now: number }) {
  // The live watts come from the House view's energy entities, as the House tab's flow does.
  const live = useMemo(() => (house === null ? null : energySummary(Object.values(house.entities).filter((e) => e.section === "energy"))), [house]);
  const price = priceNow(o, now);
  const chip = bandChip(o.prices.band);
  const t = o.today;
  const flow = live !== null && (live.net !== null || live.solar !== null);
  return (
    <Band title="Now" line={live?.net != null ? (live.net >= 0 ? "importing" : "exporting") : undefined}>
      <div className="hviz">
        {flow ? (
          <EnergyFlow solar={live.solar} home={live.home} net={live.net} />
        ) : (
          <BarList
            rows={[
              { key: "in", label: "Imported today", value: t.electricity.importKwh, text: fmtKwh(t.electricity.importKwh) },
              { key: "out", label: "Exported today", value: t.electricity.exportKwh, text: fmtKwh(t.electricity.exportKwh) },
              { key: "solar", label: "Solar today", value: t.solar.kWh, text: fmtKwh(t.solar.kWh), tone: "var(--series-2)" },
            ].filter((r) => r.value > 0 || r.key === "in")}
          />
        )}
        <div className="stat-row estats">
          <StatTile label="Electricity now" value={price !== null ? fmtPrice(price) : "—"} sub={chip !== null ? <span className={chip.className}>{chip.text}</span> : "no price known"} />
          <StatTile label="Today so far" value={fmtEur(t.total)} sub={`${fmtKwh(t.electricity.importKwh)} in · ${fmtM3(t.gas.m3)} gas`} />
          <StatTile
            label="By the end of today"
            value={o.projected !== undefined ? `≈ ${fmtEur(o.projected.total)}` : "—"}
            sub={o.projected !== undefined ? "at the last 7 days' use, today's prices" : "not projected yet"}
          />
        </div>
      </div>
    </Band>
  );
}

// ---- money -----------------------------------------------------------------------

/** Money rows as bars on one scale; a negative row draws no bar and says why in its tooltip. */
function moneyBars(rows: MoneyRow[]) {
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    value: Math.max(0, r.value),
    text: fmtEur(r.value),
    tone: r.tone,
    title: `${r.label}: ${fmtEur(r.value)}${r.detail ? ` (${r.detail})` : ""}${r.value < 0 ? ", more credited than paid" : ""}`,
  }));
}

function MoneyBand({ o, enabled, selectedDay, onDay }: { o: EnergyOverview; enabled: boolean; selectedDay: string | null; onDay: (day: string) => void }) {
  const t = o.today;
  const carriers = byCarrier(t);
  const uses = byUse(t);
  const max = Math.max(0, ...carriers.map((r) => r.value), ...uses.map((r) => r.value));
  const attributed = t.gas.heatingM3 !== undefined || t.gas.hotWaterM3 !== undefined;
  const [period, setPeriod] = useState<Period>("day");
  const p = usePeriods(period, t.key, enabled, o.at);
  const [picked, setPicked] = useState<string | null>(null);
  // The bar the summary speaks of: the one clicked, the day shown below, else the latest.
  const selected = p.rows.find((r) => r.key === (period === "day" ? (selectedDay ?? picked) : picked)) ?? p.rows[p.rows.length - 1] ?? null;
  return (
    <Band title="Money" line={<span className="tnum">{fmtEur(t.total)} today so far</span>}>
      <div className="emoney">
        <div className="hpanel">
          <div className="hpanel-title">Today by carrier</div>
          <BarList rows={moneyBars(carriers)} max={max} />
          <div className="hfacts small">
            <span>
              import <b className="tnum">{fmtEur(t.electricity.importCost)}</b>
            </span>
            <span>
              export <b className="tnum">{fmtEur(-t.electricity.exportCredit)}</b>
            </span>
          </div>
        </div>
        <div className="hpanel">
          <div className="hpanel-title">Today by use</div>
          <BarList rows={moneyBars(uses)} max={max} />
          {!attributed && t.gas.m3 > 0 && <div className="hfacts small muted">Gas is not divided between heating and hot water: no boiler state is known.</div>}
        </div>
      </div>

      <div className="toolbar eperiods">
        <div className="seg" role="tablist" aria-label="period">
          {PERIODS.map((c) => (
            <button key={c.period} role="tab" aria-selected={period === c.period} className={period === c.period ? "tab active" : "tab"} onClick={() => setPeriod(c.period)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      {p.rows.length > 0 ? (
        <>
          <PeriodBars
            period={period}
            rows={p.rows}
            earlier={p.earlier}
            selected={selected?.key ?? null}
            onSelect={(key) => {
              setPicked(key);
              if (period === "day") onDay(key);
            }}
          />
          {selected !== null && <PeriodLine period={period} row={selected} earlier={p.earlier.get(selected.key)} />}
          {period === "day" && <p className="muted small">Click a day for its hours.</p>}
        </>
      ) : p.state === "ready" ? (
        <p className="muted small">No closed days yet: the history fills in as the ledger closes days.</p>
      ) : (
        <Unavailable state={p.state} what="the periods" error={p.error} />
      )}
    </Band>
  );
}

function PeriodLine({ period, row, earlier }: { period: Period; row: Ledger; earlier: Ledger | undefined }) {
  const pdd = perDegreeDay(row);
  const change = earlier !== undefined && earlier.total > 0 ? (row.total - earlier.total) / earlier.total : null;
  return (
    <div className="hfacts small eperiod-line">
      <span>
        {periodTitle(period, row.key)}
        {row.complete ? "" : " so far"} <b className="tnum">{row.estimated ? "≈ " : ""}{fmtEur(row.total)}</b>
      </span>
      {earlier !== undefined && (
        <span>
          a year earlier <b className="tnum">{fmtEur(earlier.total)}</b>
          {change !== null && row.complete && <span className="muted tnum"> ({change >= 0 ? "+" : "−"}{Math.abs(Math.round(change * 100))}%)</span>}
        </span>
      )}
      {pdd !== null && (
        <span title={`${fmtQty(row.degreeDays ?? 0, "degree days")}`}>
          <b className="tnum">{fmtEur(pdd)}</b> per degree day
        </span>
      )}
      {row.estimated && <span className="muted">≈ some hours priced from an estimate</span>}
    </div>
  );
}

// ---- prices ----------------------------------------------------------------------

function PricesBand({ o, now }: { o: EnergyOverview; now: number }) {
  const el = o.prices.electricity;
  const marks = priceMarks(el, now);
  const price = priceNow(o, now);
  const chip = bandChip(o.prices.band);
  const gas = o.prices.gas.find((p) => p.start <= now && now < p.end) ?? o.prices.gas[o.prices.gas.length - 1];
  return (
    <Band title="Prices" line={price !== null ? <span className="tnum">{fmtPrice(price)} now</span> : undefined}>
      <PriceBars points={el} at={now} timeZone={o.timeZone} />
      <div className="hfacts small">
        {price !== null && (
          <span>
            now <b className="tnum">{fmtPrice(price)}</b> {chip !== null && <span className={chip.className}>{chip.text}</span>}
          </span>
        )}
        {marks.min >= 0 && (
          <span>
            cheapest <b className="tnum">{fmtPrice(el[marks.min]!.price)}</b> at {clock(el[marks.min]!.start, o.timeZone)}
          </span>
        )}
        {marks.max >= 0 && (
          <span>
            most expensive <b className="tnum">{fmtPrice(el[marks.max]!.price)}</b> at {clock(el[marks.max]!.start, o.timeZone)}
          </span>
        )}
        {gas !== undefined && (
          <span>
            gas <b className="tnum">{fmtPrice(gas.price, "m³")}</b>
          </span>
        )}
      </div>
    </Band>
  );
}

// ---- a day's hours -----------------------------------------------------------------

function DayBand({ o, day, onDay }: { o: EnergyOverview; day: string | null; onDay: (day: string) => void }) {
  const today = o.today.key;
  const { hours, state, error } = useHours(day, day === today ? o.at : null);
  const rows = hours?.hours ?? [];
  const sum = (f: (h: (typeof rows)[number]) => number) => rows.reduce((a, h) => a + f(h), 0);
  return (
    <Band title="Day detail" line={day !== null ? periodTitle("day", day) : undefined}>
      <div className="toolbar eday-pick">
        <button className="hsec-more" onClick={() => day !== null && onDay(addDays(day, -1))} disabled={day === null} aria-label="the day before">
          ‹
        </button>
        <input type="date" value={day ?? ""} max={today} onChange={(e) => e.target.value !== "" && onDay(e.target.value)} aria-label="day" />
        <button className="hsec-more" onClick={() => day !== null && onDay(addDays(day, 1))} disabled={day === null || day >= today} aria-label="the day after">
          ›
        </button>
        {day !== today && (
          <button className="hsec-more" onClick={() => onDay(today)}>
            today
          </button>
        )}
      </div>
      {day === null ? (
        <p className="muted small">Pick a day, or click one in the 7-day chart.</p>
      ) : hours === null ? (
        <Unavailable state={state} what="the day's hours" error={error} />
      ) : rows.length === 0 ? (
        <p className="muted small">No hours recorded for this day.</p>
      ) : (
        <>
          <HourBars hours={rows} timeZone={o.timeZone} />
          <div className="hfacts small">
            <span>
              cost <b className="tnum">{fmtEur(sum((h) => h.cost))}</b> <span className="muted">(without fixed charges)</span>
            </span>
            <span>
              in <b className="tnum">{fmtKwh(sum((h) => h.importKwh))}</b>
            </span>
            <span>
              out <b className="tnum">{fmtKwh(sum((h) => h.exportKwh))}</b>
            </span>
            <span>
              gas <b className="tnum">{fmtM3(sum((h) => h.gasM3))}</b>
            </span>
          </div>
          <details className="eday-hours">
            <summary className="small muted">every hour</summary>
            <div className="etable-wrap">
              <table className="etable tnum">
                <thead>
                  <tr>
                    <th>Hour</th>
                    <th>In</th>
                    <th>Out</th>
                    <th>Gas</th>
                    <th>Price</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((h) => (
                    <tr key={h.start} className={h.estimated ? "etable-est" : undefined}>
                      <td>{clock(h.start, o.timeZone)}</td>
                      <td>{fmtKwh(h.importKwh)}</td>
                      <td>{fmtKwh(h.exportKwh)}</td>
                      <td>{fmtM3(h.gasM3)}</td>
                      <td>{h.price !== null ? fmtPrice(h.price) : "—"}</td>
                      <td>
                        {h.estimated ? "≈ " : ""}
                        {fmtEur(h.cost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </Band>
  );
}

// ---- heat pump instead of gas ----------------------------------------------------

function HeatPumpBand({ enabled, stamp }: { enabled: boolean; stamp: number | null }) {
  const { seasons, state } = useSeasons(enabled, stamp);
  if (seasons === null) return state === "loading" ? null : <Band title="Heat pump instead of gas?"><Unavailable state={state} what="the heating seasons" error={null} /></Band>;
  const rows = seasons.seasons.map((s) => ({ s, v: seasonVerdict(s.ledger) })).filter((r) => r.v !== null);
  if (rows.length === 0) return null;
  const current = rows.at(-1)!;
  // The whole year decides: the gas connection is paid all year, and hot water heated in summer too.
  const year = seasons.year === undefined ? null : { s: { key: "Last 12 months", from: seasons.year.from, to: seasons.year.to, ledger: seasons.year.ledger }, v: seasonVerdict(seasons.year.ledger) };
  const all = year?.v != null && year.s.ledger.days >= 360 ? [...rows, year] : rows;
  const yearly = year?.v != null && year.s.ledger.days >= 360 ? year : null;
  const line = current.v!.saving >= 0 ? `saves ${fmtEur(current.v!.saving)} this season so far` : `costs ${fmtEur(-current.v!.saving)} more this season so far`;
  const a = seasons.assumptions;
  return (
    <Band title="Heat pump instead of gas?" line={<span className="tnum">{line}</span>}>
      <p className="muted small">
        The boiler's heat, for the house and for hot water, made by a heat pump instead, each hour at that hour's outdoor temperature and price,
        with the gas connection gone and its fixed charges saved.
      </p>
      <div className="etable-wrap">
        <table className="etable tnum">
          <thead>
            <tr>
              <th>Season</th>
              <th>Days</th>
              <th>Heat from gas</th>
              <th>Gas route</th>
              <th>Heat pump</th>
              <th>Difference</th>
              <th>Per degree day</th>
            </tr>
          </thead>
          <tbody>
            {all.map(({ s, v }) => (
              <tr key={s.key}>
                <td>
                  {s.key}
                  {s.ledger.heat!.split !== "measured" && <span className="muted small"> · {s.ledger.heat!.split === "assumed" ? "hot water assumed" : "partly assumed"}</span>}
                  {s.ledger.estimated && <span className="muted small"> · ≈ prices</span>}
                </td>
                <td>{s.ledger.days}</td>
                <td>{fmtKwh(v!.heatKwh)}</td>
                <td title={`gas ${fmtEur(s.ledger.heat!.gasCost)} + gas connection ${fmtEur(s.ledger.heat!.gasFixed)}`}>{fmtEur(v!.gasRoute)}</td>
                <td title={fmtKwh(s.ledger.heat!.heatPumpKwh)}>{fmtEur(v!.heatPump)}</td>
                <td>{v!.saving >= 0 ? `−${fmtEur(v!.saving)}` : `+${fmtEur(-v!.saving)}`}</td>
                <td>{v!.perDegreeDay !== null ? fmtEur(v!.perDegreeDay) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {yearly !== null && yearly.v!.saving > 0 && (
        <p className="small tnum">
          A year like the last 12 months saves {fmtEur(yearly.v!.saving)}: over 10 years {fmtEur(yearly.v!.saving * 10)}, what the heat pump, its
          installation and closing the gas connection may cost, less the subsidy, to pay back in that time.
        </p>
      )}
      <p className="muted small tnum">
        Assumed: {a.kWhPerM3} kWh of heat per m³ of gas; an air-to-water heat pump at {copLine(a.cop)}, hot water at COP {a.hotWaterCop}
        {a.hotWaterM3PerDay !== null ? `; where the boiler's states do not split the gas, ${fmtM3(a.hotWaterM3PerDay)} a day of hot water (last summer's daily gas)` : ""}.
        The heat pumps already in the house stay as they are. energy.json's heatPump changes these.
      </p>
    </Band>
  );
}

// ---- showers ---------------------------------------------------------------------

function ShowersBand({ o }: { o: EnergyOverview }) {
  const today = o.today.showers ?? null;
  const week = sumShowers(o.days);
  if (today === null && week === null) return null;
  const rows = [
    { key: "today", label: "Today", s: today },
    { key: "week", label: "Last 7 days", s: week },
  ];
  return (
    <Band title="Showers" line={today !== null ? <span className="tnum">{today.count} today</span> : undefined}>
      <div className="etable-wrap">
        <table className="etable tnum">
          <thead>
            <tr>
              <th />
              <th>Showers</th>
              <th>Water</th>
              <th>Gas</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, label, s }) => (
              <tr key={key}>
                <td>{label}</td>
                <td>{s?.count ?? 0}</td>
                <td>{fmtQty(s?.litres ?? 0, "L")}</td>
                <td>{fmtM3(s?.gasM3 ?? 0)}</td>
                <td>{fmtEur(s?.cost ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Band>
  );
}

// ---- data ------------------------------------------------------------------------

function DataBand({ o }: { o: EnergyOverview }) {
  const b = o.backfill;
  const s = o.sources;
  const read: Array<[string, string[]]> = (
    [
      ["Grid import", s.gridImport],
      ["Grid export", s.gridExport],
      ["Solar", s.solar],
      ["Gas", s.gas],
      ["Water", s.water],
      ["Devices", s.devices.map((d) => `${d.name} (${d.use.replace("_", " ")})`)],
      ["Prices", Object.entries(s.prices).map(([k, v]) => `${k}: ${v}`)],
      ["Outdoor temperature", s.outdoorTemperature !== undefined ? [s.outdoorTemperature] : []],
      ["Gas attribution", s.attribution !== undefined ? [s.attribution.gas, s.attribution.hotWater, s.attribution.heating].filter((x): x is string => x !== undefined) : []],
    ] as Array<[string, string[]]>
  ).filter(([, ids]) => ids.length > 0);
  return (
    <Band title="Data" line={o.flags.length > 0 ? `${o.flags.length} to look at` : "nothing wrong found"}>
      {o.flags.length > 0 && (
        <ul className="hlist eflags">
          {o.flags.map((f, i) => (
            <li key={`${f.kind}:${f.id ?? ""}:${f.at ?? i}`}>
              <span className="chip chip-warn">{flagLabel(f.kind)}</span> {f.text}
              {f.at !== undefined && <span className="muted small tnum"> · {fmtWhen(f.at, o.timeZone)}</span>}
              {f.id !== undefined && <code className="muted small"> {f.id}</code>}
            </li>
          ))}
        </ul>
      )}
      <div className="hfacts small">
        <span>
          <b className="tnum">{b.closedDays}</b> days closed{b.firstDay !== undefined && b.lastDay !== undefined ? ` (${b.firstDay} to ${b.lastDay})` : ""}
        </span>
        {b.pendingDays > 0 && (
          <span>
            <b className="tnum">{b.pendingDays}</b> to close
          </span>
        )}
        {b.running && <span className="chip chip-on">closing past days…</span>}
        {b.error !== undefined && <span className="chip chip-bad">✕ {b.error}</span>}
      </div>
      {read.length > 0 && (
        <details className="esources">
          <summary className="small muted">what the figures are read from</summary>
          <dl className="kv small">
            {read.map(([label, ids]) => (
              <Fragment key={label}>
                <dt>{label}</dt>
                <dd>{ids.join(", ")}</dd>
              </Fragment>
            ))}
          </dl>
        </details>
      )}
    </Band>
  );
}
