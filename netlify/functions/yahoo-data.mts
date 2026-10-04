import YahooFinance from "yahoo-finance2";
import type { Config } from "@netlify/functions";

function isoDate(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    const maxExpirations = Math.max(
      1,
      Math.min(5, Number(url.searchParams.get("maxExpirations") || 3)),
    );

    if (!ticker || !/^[A-Z0-9.^=-]{1,20}$/.test(ticker)) {
      return Response.json({ ok: false, error: "Invalid ticker" }, { status: 400 });
    }

    // Options data is the required data source. Calendar/fundamental data is optional:
    // Yahoo commonly has option chains for ETFs while quoteSummary(calendarEvents)
    // returns "No fundamentals data found". That must not make the whole request fail.
    const [optionResult, calendarResult] = await Promise.allSettled([
      new YahooFinance().options(ticker),
      new YahooFinance().quoteSummary(ticker, { modules: ["calendarEvents"] }),
    ]);

    if (optionResult.status === "rejected") {
      return Response.json(
        { ok: false, error: `Options unavailable: ${errorMessage(optionResult.reason)}` },
        { status: 404 },
      );
    }

    const optionIndex: any = optionResult.value;
    const calendar: any = calendarResult.status === "fulfilled" ? calendarResult.value : null;
    const calendarError =
      calendarResult.status === "rejected" ? errorMessage(calendarResult.reason) : null;

    const now = new Date();
    const allExpirations = (optionIndex.expirationDates || [])
      .map((d: unknown) => {
        const date = d instanceof Date ? d : new Date(String(d));
        return { date, dte: daysBetween(now, date) };
      })
      .filter((x: { date: Date; dte: number }) =>
        !Number.isNaN(x.date.getTime()) && x.dte >= minDte && x.dte <= maxDte
      )
      .sort(
        (a: { dte: number }, b: { dte: number }) =>
          Math.abs(a.dte - targetDte) - Math.abs(b.dte - targetDte),
      )
      .slice(0, maxExpirations)
      .sort(
        (a: { date: Date }, b: { date: Date }) =>
          a.date.getTime() - b.date.getTime(),
      );

    const chains = await Promise.all(
      allExpirations.map(async ({ date, dte }: { date: Date; dte: number }) => {
        const result: any = await new YahooFinance().options(ticker, { date });
        const exp = result.options?.[0];

        const mapSide = (side: "call" | "put", rows: any[] = []) =>
          rows.map((o) => ({
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

    const ce: any = calendar?.calendarEvents || {};
    const calendarEarnings = Array.isArray(ce?.earnings?.earningsDate)
      ? ce.earnings.earningsDate.map(isoDate).filter(Boolean)
      : [];

    // quote data often survives for ETFs even when calendar fundamentals do not.
    // For equities, earningsTimestamp is only a fallback and is marked as such.
    const quoteFallbackEarnings = isoDate(optionIndex.quote?.earningsTimestamp);
    const earningsDates =
      calendarEarnings.length > 0
        ? calendarEarnings
        : quoteFallbackEarnings
          ? [quoteFallbackEarnings]
          : [];

    const quoteType = optionIndex.quote?.quoteType ?? null;
    const eventDataStatus = calendar
      ? "calendarEvents"
      : quoteType === "ETF" || quoteType === "MUTUALFUND"
        ? "not_applicable_for_fund"
        : quoteFallbackEarnings
          ? "quote_fallback"
          : "unavailable";

    return Response.json({
      ok: true,
      ticker,
      fetchedAt: new Date().toISOString(),
      quote: {
        price: optionIndex.quote?.regularMarketPrice ?? null,
        marketState: optionIndex.quote?.marketState ?? null,
        quoteType,
      },
      events: {
        status: eventDataStatus,
        source: calendar ? "Yahoo calendarEvents" : quoteFallbackEarnings ? "Yahoo quote fallback" : null,
        earningsDates,
        earningsDateEstimated: calendar
          ? ce?.earnings?.isEarningsDateEstimate ?? null
          : quoteFallbackEarnings
            ? true
            : null,
        exDividendDate: isoDate(ce?.exDividendDate),
        dividendDate: isoDate(ce?.dividendDate ?? optionIndex.quote?.dividendDate),
        warning: calendarError,
      },
      expirations: (optionIndex.expirationDates || []).map(isoDate).filter(Boolean),
      selectedExpirations: allExpirations.map((x: { date: Date; dte: number }) => ({
        expiration: isoDate(x.date),
        dte: x.dte,
      })),
      chains,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: errorMessage(error) },
      { status: 500 },
    );
  }
};

export const config: Config = {
  path: "/yahoo-data",
};
