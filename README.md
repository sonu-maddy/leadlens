# LeadLens – ICP-scored lead enrichment (Caprae AI-Readiness Challenge)

**Problem:** SaaSquatch-style tools return long lists; reps still waste time deciding *who to call first* and whether the data is real.
**Approach (quality-first):** one focused pipeline – **Import → Dedupe → Verify → Enrich → Explainable ICP score → Export** – so outreach starts with the best, verified leads.

## Features
- **ICP scoring (0-100)** with hover-to-explain reasons (industry, size, location, decision-maker title, email quality, contact data).
- **Deduplication** on website domain (fallback: company name), enforced by a UNIQUE key in SQLite.
- **Email validation:** syntax + live DNS MX lookup + role-account (`info@`) flagging.
- **Website enrichment:** emails, phones, socials, tech-stack hints, description (cheerio).
- **Ethical scraping:** honours `robots.txt`, identifies itself via User-Agent, 8s timeout, 500KB cap, SSRF guard on private IPs.
- **Hot/Warm/Cold tiers + rule-based personalised outreach opener** (one-click copy) built from enrichment signals.
- **HubSpot-ready CSV export** plus generic CSV.
- **Min-score filter, search, CSV import/export** (CRM-ready).

## Run
```bash
npm install
npm start          # http://localhost:3000   (Node >= 18)
```
A sample dataset is in `data/sample_leads.csv` (upload it with the CSV button). Click **Load demo data**, then **Enrich & verify all**. Change ICP fields and **Apply** to watch ranking change.

## Architecture
| Layer | Choice |
|---|---|
| Frontend | Vanilla HTML/CSS/JS single page (no build step), light/dark theme |
| Backend | Node.js + Express REST (`/api/leads, /import, /enrich/:id, /rescore, /export.csv`) |
| Database | **SQLite** (better-sqlite3, WAL mode), index on score |
| Caching | Enrichment results cached 7 days in SQLite (`enriched_at`) – re-enrich skipped unless forced |
| Performance | Imports verified in parallel chunks of 25; transactional rescoring |
| Hosting | Single container (Dockerfile) – *not* static, needs server for DNS/scraping |
| Cloud/Deploy | Build image → push to registry → **AWS App Runner** (or EC2/Fly/Render) with a persistent volume mounted at `/data` |

## Limits / next steps
Scaling beyond one node: swap SQLite for Postgres + a queue (SQS/BullMQ) for enrichment workers, add rotating proxies and headless browser (Playwright) for JS-heavy sites, SMTP-level verification, and HubSpot/Salesforce push. Redirect-based SSRF is only partly mitigated.
