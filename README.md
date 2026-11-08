# Chase

Lærerstyrt GPS-jaktspill for kroppsøving og ungdomsgrupper — **chase.sundaysuite.app**.
En del av Sunday Suite. Plan og faser: [docs/PLAN.md](docs/PLAN.md). Beslutninger: [docs/DECISIONS.md](docs/DECISIONS.md).

## Utvikling

```bash
npm install          # kopierer også MapLibre-workeren til public/vendor/
npm run dev          # http://localhost:3000
npm run check        # tsc + eslint + vitest (må være grønn)
npm run test:db      # migrasjoner + SQL-tester på PostGIS i Docker
```

## Supabase (delt prosjekt, skjema `chase`)

```bash
SUPABASE_ACCESS_TOKEN=sbp_… node scripts/provision-shared.mjs   # migrasjoner + .env.local
```

## Deploy (Cloudflare Workers via OpenNext)

```bash
npm run cf:build
npm run cf:deploy                                   # → chase.sundaysuite.app
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # valgfritt — se ADR-008
```

`NEXT_PUBLIC_*` bakes inn ved bygg — bygg med `.env.local` på plass.
