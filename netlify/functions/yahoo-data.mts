import YahooFinance from "yahoo-finance2";
import type { Config } from "@netlify/functions";

const yahooFinance = new YahooFinance();

function isoDate(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export default async (req: Request) => {
  try {
    const expected = Netlify.env.get("YAHOO_PROXY_SECRET");
    const supplied = req.headers.get("x-api-key");

    if (!expected || supplied !== expected) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const ticker = (url.searchParams.get("ticker") || "").trim().toUpperCase();
    const minDte = Number(url.searchParams.get("minDte") || 21);
    const maxDte = Number(url.searchParams.get("maxDte") || 60);
    const targetDte = Number(url.searchParams.get("targetDte") || 35);
    const maxExpirations = Math.max(1, Math.min(5, Number(url.searchParams.get("maxExpirations") || 3)));

    if (!ticker || !/^[A-Z0-9.^=-]{1,20}$/.test(ticker)) {
      return Response.json({ ok: false, error: "Invalid ticker" }, { status: 400 });
    }

    const [calendar, optionIndex] = await Promise.all([
      yahooFinance.quoteSummary(ticker, { modules: ["calendarEvents"] }),
      yahooFinance.options(ticker),
    ]);

    const now = new Date();
    const allExpirations = (optionIndex.expirationDates || [])
      .map((d) => ({ date: d instanceof Date ? d : new Date(d), dte: daysBetween(now, d instanceof Date ? d : new Date(d)) }))
      .filter((x) => x.dte >= minDte && x.dte <= maxDte)
      .sort((a, b) => Math.abs(a.dte - targetDte) - Math.abs(b.dte - targetDte))
      .slice(0, maxExpirations)
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    const chains = await Promise.all(
      allExpirations.map(async ({ date, dte }) => {
        const result = await yahooFinance.options(ticker, { date });
        const exp = result.options?.[0];
        const mapSide = (side: "call" | "put", rows: any[] = []) => rows.map((o) => ({
          side,
          contractSymbol: o.contractSymbol,
          expiration: isoDate(o.expiration),
          strike: o.strike ?? null,
          bid: o.bid ?? null,
          ask: o.ask ?? null,
          lastPrice: o.lastPrice ?? null,
          volume: o.volume ?? null,
          openInterest: o.openInterest ?? null,
          iv: o.impliedVolatility ?? null,
          inTheMoney: o.inTheMoney ?? null,
          contractSize: o.contractSize ?? null,
          lastTradeDate: isoDate(o.lastTradeDate),
        }));

        return {
          expiration: isoDate(date),
          dte,
          calls: mapSide("call", exp?.calls),
          puts: mapSide("put", exp?.puts),
        };
      }),
    );

    const ce: any = (calendar as any)?.calendarEvents || {};
    const earningsDates = Array.isArray(ce?.earnings?.earningsDate)
      ? ce.earnings.earningsDate.map(isoDate).filter(Boolean)
      : [];

    return Response.json({
      ok: true,
      ticker,
      fetchedAt: new Date().toISOString(),
      quote: {
        price: optionIndex.quote?.regularMarketPrice ?? null,
        marketState: optionIndex.quote?.marketState ?? null,
      },
      events: {
        earningsDates,
        earningsDateEstimated: ce?.earnings?.isEarningsDateEstimate ?? null,
        exDividendDate: isoDate(ce?.exDividendDate),
        dividendDate: isoDate(ce?.dividendDate),
      },
      expirations: (optionIndex.expirationDates || []).map(isoDate).filter(Boolean),
      selectedExpirations: allExpirations.map((x) => ({ expiration: isoDate(x.date), dte: x.dte })),
      chains,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
};

export const config: Config = {
  path: "/yahoo-data",
};
