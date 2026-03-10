# NugLabs Telegram Bot (`@nuglabsbot`)

`@nuglabsbot` is a Telegram bot that lets you quickly look up cannabis strains from the NugLabs catalogue, powered by the Strain Data API at **`https://strains.nuglabs.co`**.

## What you can do with it

- **Search by name or AKA**  
  - Send a strain name (e.g. `Mimosa`) and the bot replies with:
    - Name, type, also‑known‑as
    - Top / positive / negative effects
    - THC %, flavors, terpenes, “helps with”
    - Rating and a concise description
    - A deep link back to the bot for that specific strain
  - AKAs (aliases) are supported, e.g. `Purple Mimosa` resolves to Mimosa.

- **Deep-link directly into a strain**  
  - Links like `https://t.me/nuglabsbot?start=mimosa` open the bot and immediately show that strain.
  - The bot normalizes payloads (e.g. `blue-dream` → `Blue Dream`) before matching.

## How it stays fast

- Every 12 hours the bot fetches the full strain list from `https://strains.nuglabs.co/api/v1/strains` and keeps it **in memory**.
- All lookups (by name or AKA) are done against that in‑memory cache, so:
  - No per‑message API calls,
  - Exact, case‑insensitive matching with normalized spaces/dashes.
