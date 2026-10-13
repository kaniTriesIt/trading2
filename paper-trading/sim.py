"""Paper-trading Monte Carlo: how long to double $9.97 on Phantom (Solana) coins?
Prices are SIMULATED (live APIs blocked in sandbox). Vol/drift are rough assumptions."""
import numpy as np, sys
rng = np.random.default_rng(7)
START, TARGET = 9.97, 9.97 * 2
FEE = 0.005            # 0.5% per swap (Jupiter fee + slippage on small size)
HOURS = 24 * 90        # 90-day horizon
# daily vol, daily drift (assumed; drift ~0 = no edge)
COINS = {"SOL": (0.045, 0.0), "JUP": (0.06, 0.0), "BONK": (0.07, 0.0),
         "WIF": (0.08, 0.0), "POPCAT": (0.09, 0.0), "PYTH": (0.06, 0.0)}

def paths(vol, drift, n):
    h = vol / np.sqrt(24)
    r = rng.standard_t(3, size=(n, HOURS)) / np.sqrt(3) * h + drift / 24
    return np.exp(np.cumsum(r, axis=1))

def run(strategy, n=2000):
    t_double, finals = [], []
    P = {c: paths(v, d, n) for c, (v, d) in COINS.items()}
    for i in range(n):
        cash, pos, coin, entry, peak = START, 0.0, None, 0, 0
        done = None
        for t in range(48, HOURS):
            if pos == 0:
                if strategy == "hold":
                    coin = "WIF"; pos = cash * (1 - FEE) / P[coin][i, 0]; cash = 0; entry = 0
                else:  # momentum: buy coin with best 24h gain if >5%
                    best = max(COINS, key=lambda c: P[c][i, t] / P[c][i, t-24])
                    if P[best][i, t] / P[best][i, t-24] > 1.05:
                        coin = best; pos = cash * (1 - FEE) / P[coin][i, t]; cash = 0; peak = P[coin][i, t]
            elif strategy == "mom":
                px = P[coin][i, t]; peak = max(peak, px)
                if px < peak * 0.92:  # 8% trailing stop
                    cash = pos * px * (1 - FEE); pos = 0
            val = cash + (pos * P[coin][i, t] if pos else 0)
            if val >= TARGET: done = t; break
            if val < 1: break
        else:
            val = cash + (pos * P[coin][i, HOURS-1] if pos else 0)
        if done is not None: t_double.append(done / 24)
        finals.append(min(val, TARGET) if done is not None else val)
    td = np.array(t_double)
    print(f"{strategy:5s} doubled in 90d: {len(td)/n:5.1%} | median days to double: "
          f"{np.median(td) if len(td) else float('nan'):5.1f} | busted(<50% of start): {(np.array(finals)<START/2).mean():5.1%} "
          f"| median final: ${np.median(finals):.2f}")

for s in ("hold", "mom"): run(s)
