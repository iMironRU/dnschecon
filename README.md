# DNSChecon

**DNS propagation monitor** — watch your records converge across the globe in real time.

[![Deploy](https://github.com/iMironRU/dnschecon/actions/workflows/deploy.yml/badge.svg)](https://github.com/iMironRU/dnschecon/actions/workflows/deploy.yml)
[![Telegram Bot](https://img.shields.io/badge/Telegram-@dnschecon__bot-blue?logo=telegram)](https://t.me/dnschecon_bot)

**[→ Открыть бота в Telegram](https://t.me/dnschecon_bot) · [→ Landing page](https://imironru.github.io/dnschecon/)**

When you change a DNS record, resolvers across the world don't update at the same time — propagation can take anywhere from seconds to 48 hours. DNSChecon polls resolvers on every continent and notifies you via Telegram the moment all of them agree.

---

## How it works

```
┌──────────────────────────────────────────────┐
│           Telegram Mini App (UI)             │
│     Cloudflare Workers Assets · single HTML  │
└───────────────────┬──────────────────────────┘
                    │ /api/*
┌───────────────────▼──────────────────────────┐
│             Cloudflare Worker                │
│  /webhook/telegram  /webhook/github  /api/*  │
└──────────┬──────────────────────┬────────────┘
           │                      │
┌──────────▼──────────┐  ┌────────▼────────────┐
│   Durable Object    │  │    GitHub Repo       │
│   WatchDO (alarm()) │  │  watches/*.yaml      │
│   · polling loop    │  │  declarative config  │
│   · per-resolver    │  └─────────────────────┘
│     state + backoff │
└──────────┬──────────┘
           │ parallel DoH queries
┌──────────▼──────────────────────────────────┐
│           Public DNS Resolvers               │
│  🇩🇪 EU/DE  🇺🇸 US  🇯🇵 JP  🇧🇷 BR  🇷🇺 RU  🇦🇺 AU  ☁️ Cloudflare │
└─────────────────────────────────────────────┘
```

1. Create a watch via the Mini App or commit a YAML file to `watches/`
2. A Durable Object boots the polling loop using `alarm()` — no cron, no Lambda
3. Each round queries all resolvers in parallel via DoH JSON
4. Google DoH is called with `edns_client_subnet` for genuine geo-views; Cloudflare adds an independent global snapshot
5. Once all resolvers (or a configured quorum) return the expected value for N consecutive rounds — convergence is declared and Telegram sends a notification

---

## Features

- **Real geo-coverage** via EDNS Client Subnet — one provider, six regional views
- **Sub-minute polling** powered by Durable Object `alarm()`, not a cron job
- **Flap prevention** — configurable consecutive-rounds confirmation before declaring convergence
- **Smart backoff** — 30s → 60s → 2m → 5m → 10m → 30m → 1h, with jitter
- **Telegram Mini App** — live progress ring, resolver grid, pause/resume/cancel
- **Two-contour design** — git for declarations, DO storage for runtime state
- **Free plan compatible** — runs on Cloudflare's free tier (`new_sqlite_classes` migration)

---

## Watch file format

```yaml
# watches/my-domain-a.yaml
id: my-domain-a
domain: app.example.com
type: A                        # A · AAAA · CNAME · MX · TXT · NS
expected:
  values:
    - 203.0.113.10
    - 203.0.113.11
  match: exact-set             # exact-set | contains
resolvers: preset:global-8
convergence:
  mode: all                    # all | quorum
  confirmations: 2             # consecutive full rounds required
backoff:
  schedule_sec: [30, 30, 60, 60, 120, 300, 600, 1800, 3600]
  hold_last: true
  jitter_pct: 10
  timeout_sec: 172800          # 48h max
precheck_authoritative: false
notify:
  telegram_chat_ids: [123456789]
  progress: edit-in-place      # off | edit-in-place | every-round
status: active
```

Files committed to `watches/` are picked up automatically via GitHub webhook — no manual trigger needed.

---

## Resolver presets

| Preset | Resolvers | Use case |
|--------|-----------|----------|
| `global-8` | Google DE · US · JP · BR · RU · AU + Cloudflare | Full global coverage |
| `quick-check` | Google US + Cloudflare | Fast 2-point sanity check |

Regional views are achieved by passing different `edns_client_subnet` values to Google's DoH endpoint — each subnet routes the query through a different Google PoP, giving a genuine regional answer rather than the same anycast result.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (TypeScript) |
| Polling loop | Durable Objects · `alarm()` API |
| State storage | Durable Object SQLite + KV |
| DNS queries | DoH JSON — `dns.google` + `cloudflare-dns.com` |
| Geo coverage | EDNS Client Subnet (ECS) |
| UI | Telegram Mini App (vanilla JS, single-file HTML) |
| Watch config | GitHub Git Data API (YAML files in repo) |
| CI/CD | GitHub Actions → `wrangler deploy` |

---

## Deployment

**Prerequisites:** Cloudflare account (free plan works), Telegram bot token, GitHub PAT with repo write access.

```bash
# 1. Clone and install dependencies
git clone https://github.com/iMironRU/dnschecon
cd dnschecon/worker && npm install

# 2. Set secrets
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put GITHUB_TOKEN
wrangler secret put GITHUB_WEBHOOK_SECRET

# 3. Deploy
npx wrangler deploy
```

Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets — every push to `main` will redeploy automatically.

After deploying, register the Telegram webhook:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://dnschecon.<subdomain>.workers.dev/webhook/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```
