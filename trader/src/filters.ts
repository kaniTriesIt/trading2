// Pure rug-filter logic. No I/O, so it is unit-testable and cheap to reason about.
export interface Filters {
  minLiquidityUsd: number;
  minPoolAgeHours: number;
  requireMintAuthorityRevoked: boolean;
  requireFreezeAuthorityRevoked: boolean;
  maxTop10HolderPercent: number;
  minVolumeToLiquidity: number;
  maxVolumeToLiquidity: number;
}

export interface Market {
  liquidityUsd: number;
  volume24hUsd: number;
  pairCreatedAtMs: number | null;
}

export interface Security {
  mintAuthority: string | null | undefined; // null = revoked, undefined = unknown
  freezeAuthority: string | null | undefined;
  top10HolderPercent: number | undefined;
}

/** Cheap checks that need only DexScreener data. Returns a reject reason or null. */
export function checkMarket(m: Market, f: Filters, nowMs: number): string | null {
  if (m.liquidityUsd < f.minLiquidityUsd) return "low liquidity";
  if (m.pairCreatedAtMs === null) return "pool age unknown";
  const ageH = (nowMs - m.pairCreatedAtMs) / 3_600_000;
  if (ageH < f.minPoolAgeHours) return "pool too new";
  const ratio = m.volume24hUsd / m.liquidityUsd;
  if (ratio < f.minVolumeToLiquidity) return "volume too low vs liquidity";
  if (ratio > f.maxVolumeToLiquidity) return "volume suspiciously high vs liquidity";
  return null;
}

/** On-chain checks. Fails closed: unknown data is a rejection, never a pass. */
export function checkSecurity(s: Security, f: Filters): string | null {
  if (f.requireMintAuthorityRevoked) {
    if (s.mintAuthority === undefined) return "mint authority unverified";
    if (s.mintAuthority !== null) return "mint authority not revoked";
  }
  if (f.requireFreezeAuthorityRevoked) {
    if (s.freezeAuthority === undefined) return "freeze authority unverified";
    if (s.freezeAuthority !== null) return "freeze authority not revoked";
  }
  if (s.top10HolderPercent === undefined) return "holder concentration unverified";
  if (s.top10HolderPercent > f.maxTop10HolderPercent) return "top-10 holders too concentrated";
  return null;
}

/** Birdeye reports top10HolderPercent as a fraction (0-1) or a percent; normalise to percent. */
export function toPercent(v: number | undefined): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v <= 1 ? v * 100 : v;
}
