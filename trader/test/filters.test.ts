import { expect, test } from "bun:test";
import cfg from "../config.json";
import { checkMarket, checkSecurity, toPercent } from "../src/filters.ts";

const f = cfg.filters;
const NOW = 1_700_000_000_000;
const good = { liquidityUsd: 100_000, volume24hUsd: 200_000, pairCreatedAtMs: NOW - 48 * 3_600_000 };

test("market filter passes a healthy pool and rejects each failure", () => {
  expect(checkMarket(good, f, NOW)).toBeNull();
  expect(checkMarket({ ...good, liquidityUsd: 1000 }, f, NOW)).toBe("low liquidity");
  expect(checkMarket({ ...good, pairCreatedAtMs: NOW - 3_600_000 }, f, NOW)).toBe("pool too new");
  expect(checkMarket({ ...good, pairCreatedAtMs: null }, f, NOW)).toBe("pool age unknown");
  expect(checkMarket({ ...good, volume24hUsd: 100 }, f, NOW)).toBe("volume too low vs liquidity");
  expect(checkMarket({ ...good, volume24hUsd: 9_000_000 }, f, NOW)).toBe("volume suspiciously high vs liquidity");
});

test("security filter fails closed on unknown data", () => {
  const ok = { mintAuthority: null, freezeAuthority: null, top10HolderPercent: 20 };
  expect(checkSecurity(ok, f)).toBeNull();
  expect(checkSecurity({ ...ok, mintAuthority: "abc" }, f)).toBe("mint authority not revoked");
  expect(checkSecurity({ ...ok, freezeAuthority: undefined }, f)).toBe("freeze authority unverified");
  expect(checkSecurity({ ...ok, top10HolderPercent: undefined }, f)).toBe("holder concentration unverified");
  expect(checkSecurity({ ...ok, top10HolderPercent: 80 }, f)).toBe("top-10 holders too concentrated");
});

test("toPercent normalises fractions", () => {
  expect(toPercent(0.35)).toBeCloseTo(35);
  expect(toPercent(35)).toBe(35);
  expect(toPercent(undefined)).toBeUndefined();
});
