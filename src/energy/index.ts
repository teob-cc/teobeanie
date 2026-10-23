// index.ts — the energy ledger's doors: the read API (api/energy, api/energy/periods,
// api/energy/hours) and the `energy` MCP tool.

import type { Hono } from "hono";
import type { MCPTool } from "@lambda-house/teob-ts/ai";
import { addDays, dayKey, isDayKey, type Period } from "./calendar.js";
import type { EnergyService } from "./service.js";
import { str, tool } from "../mcp/tools.js";
import type { Ledger } from "./types.js";

const PERIODS: Period[] = ["day", "week", "month", "year"];
const isPeriod = (p: unknown): p is Period => PERIODS.includes(p as Period);

export function mountEnergy(app: Hono, energy: EnergyService): void {
  const fail = (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) });
  app.get("/api/energy", async (c) => {
    try {
      return c.json(await energy.overview());
    } catch (err) {
      return c.json(fail(err), 502);
    }
  });
  app.get("/api/energy/periods", async (c) => {
    const period = c.req.query("period") ?? "day";
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!isPeriod(period) || !isDayKey(from) || !isDayKey(to)) return c.json({ error: "period=day|week|month|year, from and to as YYYY-MM-DD" }, 400);
    try {
      return c.json(await energy.periods(period, from, to));
    } catch (err) {
      return c.json(fail(err), 502);
    }
  });
  app.get("/api/energy/hours", async (c) => {
    const date = c.req.query("date");
    if (!isDayKey(date)) return c.json({ error: "date as YYYY-MM-DD" }, 400);
    try {
      return c.json(await energy.hours(date));
    } catch (err) {
      return c.json(fail(err), 502);
    }
  });
}

/** A ledger as the agent reads it: the money first, devices only where they used something. */
const brief = (l: Ledger) => ({
  key: l.key,
  complete: l.complete,
  total_eur: l.total,
  electricity: { import_kwh: l.electricity.importKwh, export_kwh: l.electricity.exportKwh, import_eur: l.electricity.importCost, export_credit_eur: l.electricity.exportCredit },
  solar_kwh: l.solar.kWh,
  gas: { m3: l.gas.m3, eur: l.gas.cost, ...(l.gas.hotWaterM3 !== undefined ? { hot_water_m3: l.gas.hotWaterM3, heating_m3: l.gas.heatingM3 } : {}) },
  water: { m3: l.water.m3, eur: l.water.cost },
  fixed_eur: l.fixed,
  ...(l.degreeDays !== undefined ? { degree_days: l.degreeDays, eur_per_degree_day: l.degreeDays > 0 ? Math.round((l.total / l.degreeDays) * 100) / 100 : null } : {}),
  devices: l.devices.filter((d) => d.kWh > 0).map((d) => ({ name: d.name, use: d.use, kwh: d.kWh, eur: d.cost })),
  ...(l.showers !== undefined ? { showers: l.showers } : {}),
  ...(l.estimated ? { estimated: true } : {}),
});

export function createEnergyTools(deps: { energy: EnergyService; timeZone: () => string; now?: () => number }): MCPTool[] {
  const now = deps.now ?? Date.now;
  return [
    tool(
      "energy",
      "The house's energy ledger: euros and quantities (grid import and export, solar, gas, water, each device), from Home Assistant's statistics priced per hour. view \"today\" (default): today so far, projected by its end, the last 7 days, the price curve and the data problems. view \"periods\": one row per day, week, month or year from..to (dates YYYY-MM-DD, house time), with degree days for comparing heating. view \"hours\": one day's hours with their prices. Read-only.",
      {
        view: { type: "string", enum: ["today", "periods", "hours"] },
        period: { type: "string", enum: PERIODS, description: "for periods; default month" },
        from: { type: "string", description: "YYYY-MM-DD; for periods, default a year ago" },
        to: { type: "string", description: "YYYY-MM-DD; default today" },
        date: { type: "string", description: "for hours: YYYY-MM-DD, default today" },
      },
      async (args) => {
        const view = str(args, "view") ?? "today";
        const today = dayKey(now(), deps.timeZone());
        if (view === "periods") {
          const period = str(args, "period") ?? "month";
          if (!isPeriod(period)) throw new Error("period must be day, week, month or year");
          const from = str(args, "from") ?? addDays(today, -365);
          const to = str(args, "to") ?? today;
          if (!isDayKey(from) || !isDayKey(to)) throw new Error("from and to must be YYYY-MM-DD");
          const res = await deps.energy.periods(period, from, to);
          return { period, rows: res.rows.map(brief) };
        }
        if (view === "hours") {
          const date = str(args, "date") ?? today;
          if (!isDayKey(date)) throw new Error("date must be YYYY-MM-DD");
          return deps.energy.hours(date);
        }
        const o = await deps.energy.overview();
        return {
          available: o.available,
          time_zone: o.timeZone,
          today: brief(o.today),
          ...(o.projected !== undefined ? { projected_eur: o.projected } : {}),
          last_days: o.days.map(brief),
          price_now: o.prices.now ?? null,
          price_band: o.prices.band ?? null,
          prices: o.prices.electricity.map((p) => ({ start: new Date(p.start).toISOString(), price: p.price })),
          flags: o.flags.slice(0, 20).map((f) => f.text),
          backfill: o.backfill,
          sources: o.sources,
        };
      },
    ),
  ];
}
