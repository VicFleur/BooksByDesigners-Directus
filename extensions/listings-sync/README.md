# Listings Sync Extension

Daily cron hook to sync eBay and AbeBooks listings into the `listings` collection.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LISTINGS_CRON` | `0 3 * * *` | Cron expression for sync schedule (default: daily at 3 AM) |
| `LISTINGS_SYNC_DRY_RUN` | `false` | Set to `true` to log actions without making DB changes |
| `EBAY_CLIENT_ID` | — | eBay OAuth client ID |
| `EBAY_CLIENT_SECRET` | — | eBay OAuth client secret |
| `EBAY_MAX_PAGES` | `3` | Max pages to fetch per country/book |
| `EBAY_MAX_CONCURRENT` | `2` | Max concurrent eBay requests |
| `EBAY_MIN_TIME_MS` | `200` | Min ms between eBay requests |
| `EBAY_TRACKING` | — | eBay affiliate tracking ID |
| `EXCHANGE_RATES_URL` | exchangeratesapi.io | URL to fetch FX rates |

## Build

```bash
cd extensions/listings-sync
bun install
bun run build
```

## Manual Run

To trigger a sync immediately without waiting for the cron:

1. Set `LISTINGS_CRON` to a near-future time (e.g., `*/1 * * * *` for every minute)
2. Restart Directus and watch logs
3. Reset to normal schedule after testing

Or use the dry-run mode:

```bash
LISTINGS_SYNC_DRY_RUN=true
```

## Behavior

- Fetches all books from `books` collection
- For each book, queries eBay (DE, AT, CH, IT, FR, GB, US) and AbeBooks
- Upserts listings: creates new ones, updates existing active ones
- Retires listings no longer found: sets `status=inactive` and clears heavy fields (`image_src`, `description`, `raw_data`, `item_affiliate_web_url`, `item_web_url`)
- Preserves price fields and dates for historical statistics

## Listings Schema

| Field | Type | Notes |
|-------|------|-------|
| `id` | UUID | Primary key |
| `book` | integer | FK to `books.id` |
| `source` | string | `ebay` or `abebooks` |
| `listing_key` | string | Unique ID per source (itemId or hash) |
| `status` | string | `active` or `inactive` |
| `title`, `link`, `seller`, `location` | string | Listing details |
| `item_currency`, `item_price` | string/decimal | Original price |
| `item_price_eur/usd/gbp` | decimal | Converted prices |
| `listing_type`, `condition`, `condition_id` | string | Listing metadata |
| `image_src`, `description`, `item_affiliate_web_url`, `item_web_url`, `raw_data` | text/json | **Cleared when inactive** |
| `date_first_seen`, `date_last_seen` | timestamp | Tracking dates |

