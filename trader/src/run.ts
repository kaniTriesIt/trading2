// One-shot read-only watcher. No signing, no wallet. Writes watchlist.md + status.md.
// API trouble (rate limit, 5xx, network) aborts the run cleanly with nothing but status.md written.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiAbort, getJson, redact, rpc } from "./api.ts";
import { checkMarket, checkSecurity, toPercent, type Filters } from "./filters.ts";
import { atomicWrite } from "./fsutil.ts";

const start = Date.now();
const KEY = process.env.BIRDEYE_API_KEY;
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const OUT = process.env.TRADER_DATA_DIR || "./trading";
const cfg = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")) as {
  filters: Filters;
  sources: { birdeyeTrendingLimit: number; dexscreenerBoostedLimit: number; maxSecurityChecks: number; birdeyeDelayMs: number };
  watchlist: { maxEntries: number };
};
const SKIP = new Set([
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`);

interface Pair {
  chainId: string;
  baseToken: { address: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  pairCreatedAt?: number;
}

function status(lines: string[]): void {
  atomicWrite(join(OUT, "status.md"), `# Watcher status\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
}

async function main(): Promise<void> {
  if (!KEY) {
    console.error("BIRDEYE_API_KEY is not set. Add it as a repository secret.");
    process.exit(1);
  }
  const bird = { "X-API-KEY": KEY, "x-chain": "solana" };
  const now = Date.now();

  // 1. Candidate addresses from Birdeye trending + DexScreener boosted.
  const candidates = new Set<string>();
  const trending = await getJson<{ data?: { tokens?: { address: string }[] } }>(
    `https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=${cfg.sources.birdeyeTrendingLimit}`,
    bird,
  );
  for (const t of trending?.data?.tokens ?? []) candidates.add(t.address);
  const boosted = await getJson<{ chainId: string; tokenAddress: string }[]>("https://api.dexscreener.com/token-boosts/top/v1");
  for (const b of (boosted ?? []).filter((x) => x.chainId === "solana").slice(0, cfg.sources.dexscreenerBoostedLimit)) {
    candidates.add(b.tokenAddress);
  }
  for (const s of SKIP) candidates.delete(s);
  const addrs = [...candidates];
  if (addrs.length === 0) throw new ApiAbort("no candidate tokens returned by any source");

  // 2. Best (highest-liquidity) Solana pair per token, 30 addresses per DexScreener call.
  const best = new Map<string, Pair>();
  for (let i = 0; i < addrs.length; i += 30) {
    const r = await getJson<{ pairs?: Pair[] }>(`https://api.dexscreener.com/latest/dex/tokens/${addrs.slice(i, i + 30).join(",")}`);
    for (const p of r?.pairs ?? []) {
      if (p.chainId !== "solana") continue;
      const cur = best.get(p.baseToken.address);
      if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(p.baseToken.address, p);
    }
  }

  // 3. Cheap market filters first, so we spend few rate-limited Birdeye calls.
  const rejects = new Map<string, number>();
  const bump = (r: string) => rejects.set(r, (rejects.get(r) ?? 0) + 1);
  const survivors: Pair[] = [];
  for (const addr of addrs) {
    const p = best.get(addr);
    if (!p) { bump("no Solana pair on DexScreener"); continue; }
    const why = checkMarket(
      { liquidityUsd: p.liquidity?.usd ?? 0, volume24hUsd: p.volume?.h24 ?? 0, pairCreatedAtMs: p.pairCreatedAt ?? null },
      cfg.filters,
      now,
    );
    if (why) bump(why); else survivors.push(p);
  }
  survivors.sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0));
  const toCheck = survivors.slice(0, cfg.sources.maxSecurityChecks);
  const skippedForBudget = survivors.length - toCheck.length;

  // 4. On-chain checks: authorities from the mint account, concentration from Birdeye.
  const passed: { p: Pair; top10: number }[] = [];
  for (const p of toCheck) {
    const mint = p.baseToken.address;
    const acct = await rpc<{ value?: { data?: { parsed?: { info?: { mintAuthority: string | null; freezeAuthority: string | null } } } } }>(
      RPC_URL, "getAccountInfo", [mint, { encoding: "jsonParsed" }],
    );
    const info = acct?.value?.data?.parsed?.info;
    await sleep(cfg.sources.birdeyeDelayMs);
    const sec = await getJson<{ data?: { top10HolderPercent?: number } }>(
      `https://public-api.birdeye.so/defi/token_security?address=${mint}`, bird,
    );
    const top10 = toPercent(sec?.data?.top10HolderPercent);
    const why = checkSecurity(
      { mintAuthority: info?.mintAuthority, freezeAuthority: info?.freezeAuthority, top10HolderPercent: top10 },
      cfg.filters,
    );
    if (why) bump(why); else passed.push({ p, top10: top10 as number });
  }

  // 5. Everything fetched successfully: now write, atomically.
  const final = passed.slice(0, cfg.watchlist.maxEntries);
  const stamp = new Date(now).toISOString();
  const rows = final.map(({ p, top10 }) => {
    const liq = p.liquidity?.usd ?? 0, vol = p.volume?.h24 ?? 0;
    const ageH = Math.round((now - (p.pairCreatedAt ?? now)) / 3_600_000);
    return `| ${p.baseToken.symbol} | \`${p.baseToken.address}\` | $${p.priceUsd} | ${usd(liq)} | ${usd(vol)} | ${ageH}h | ${top10.toFixed(1)}% | liq ≥ min, vol/liq ${(vol / liq).toFixed(2)}, mint+freeze revoked, top-10 ≤ ${cfg.filters.maxTop10HolderPercent}% |`;
  });
  atomicWrite(
    join(OUT, "watchlist.md"),
    `# Watchlist\n\nUpdated ${stamp}. Read-only watcher; nothing is bought.\n\n` +
      (rows.length
        ? `| Token | Mint | Price | Liquidity | 24h vol | Pool age | Top-10 | Why it passed |\n|---|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`
        : "_No token passed every filter this run._\n") +
      `\n## Rejected this run\n\n${[...rejects].map(([r, n]) => `- ${r}: ${n}`).join("\n") || "- none"}\n`,
  );
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  status([
    `Last run: ${stamp} — OK in ${secs}s`,
    `Candidates ${addrs.length}, market-filter survivors ${survivors.length}, security-checked ${toCheck.length}, passed ${passed.length}`,
    ...(skippedForBudget > 0 ? [`${skippedForBudget} survivors not security-checked (maxSecurityChecks=${cfg.sources.maxSecurityChecks})`] : []),
  ]);
  console.log(`OK in ${secs}s: ${addrs.length} candidates, ${passed.length} passed`);
}

main().catch((e) => {
  const msg = redact(e instanceof Error ? e.message : String(e));
  if (e instanceof ApiAbort) {
    console.log(`::warning::run aborted cleanly, nothing updated: ${msg}`);
    try { status([`Last run: ${new Date().toISOString()} — ABORTED, watchlist unchanged`, `Reason: ${msg}`]); } catch {}
    process.exit(0);
  }
  console.error(`::error::${msg}`);
  process.exit(1);
});
