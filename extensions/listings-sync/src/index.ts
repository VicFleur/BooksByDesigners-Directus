import { defineHook } from '@directus/extensions-sdk';
import Bottleneck from 'bottleneck';
import { createHash } from 'crypto';
// @ts-ignore
import { decode } from 'he';
import express from 'express';

// Types
interface Book {
    id: number;
    url: string;
    title: string;
    isbn13: string | null;
    ebay_keywords: string | null;
    ebay_optional_words: string[] | null;
    ebay_stopwords: string[] | null;
    abebooks_stopwords: string[] | null;
}

interface Listing {
    book: number;
    source: 'ebay' | 'abebooks';
    listing_key: string;
    status: 'active' | 'inactive';
    title: string | null;
    link: string | null;
    seller: string | null;
    location: string | null;
    item_currency: string | null;
    item_price: number | null;
    item_price_eur: number | null;
    item_price_usd: number | null;
    item_price_gbp: number | null;
    listing_type: string | null;
    condition: string | null;
    condition_id: string | null;
    image_src: string | null;
    description: string | null;
    item_affiliate_web_url: string | null;
    item_web_url: string | null;
    raw_data: Record<string, unknown> | null;
    date_first_seen?: string;
    date_last_seen?: string;
}

interface FxRates {
    EUR: number;
    USD: number;
    GBP: number;
    [key: string]: number;
}

interface SearchResult {
    listings: Listing[];
    success: boolean;
    source: 'ebay' | 'abebooks';
}

// Config
const REQUEST_CHUNK = 50;
const EBAY_OAUTH_SCOPE = 'https://api.ebay.com/oauth/api_scope';

// Globals for eBay OAuth
let ebayAccessToken: string | null = null;
let ebayAccessTokenExpiry = 0;

// Heavy fields to clear when marking inactive
const HEAVY_FIELDS_TO_CLEAR = [
    'image_src',
    'description',
    'item_affiliate_web_url',
    'item_web_url',
    'raw_data',
] as const;

export default defineHook(({ schedule, init }, { services, database, getSchema, env, logger }) => {
    const ItemsService = services.ItemsService;

    const cronExpression = env['LISTINGS_CRON'] || '0 3 * * *';
    const dryRun = env['LISTINGS_SYNC_DRY_RUN'] === 'true';

    // eBay config from env
    const EBAY_CLIENT_ID = env['EBAY_CLIENT_ID'] || env['EBAY_CLIENTID'] || '';
    const EBAY_CLIENT_SECRET = env['EBAY_CLIENT_SECRET'] || env['EBAY_CLIENTSECRET'] || '';
    const MAX_EBAY_PAGES = parseInt(env['EBAY_MAX_PAGES'] || '3', 10);
    const EBAY_MAX_CONCURRENT = parseInt(env['EBAY_MAX_CONCURRENT'] || '2', 10);
    const EBAY_MIN_TIME_MS = parseInt(env['EBAY_MIN_TIME_MS'] || '200', 10);
    const EBAY_TRACKING = env['EBAY_TRACKING'] || '';
    const EXCHANGE_RATES_URL = env['EXCHANGE_RATES_URL'] || 'http://api.exchangeratesapi.io/v1/latest?access_key=53af9fd44c212751829b71979e140b25&format=1&symbols=EUR,USD,GBP';
    const SYNC_SECRET = env['LISTINGS_SYNC_SECRET'];

    const ebayLimiter = new Bottleneck({
        maxConcurrent: EBAY_MAX_CONCURRENT,
        minTime: EBAY_MIN_TIME_MS,
    });

    function getCharset(contentType: string | null): string {
        if (!contentType) return 'utf-8';
        const match = /charset=([^;]+)/i.exec(contentType);
        return match && match[1] ? match[1].toLowerCase() : 'utf-8';
    }

    async function decodeResponseBody(res: Response): Promise<string> {
        const buffer = await res.arrayBuffer();
        const charset = getCharset(res.headers.get('content-type'));
        const normalized = charset === 'iso-8859-1' ? 'latin1' : charset;
        try {
            return new TextDecoder(normalized).decode(buffer);
        } catch {
            return new TextDecoder('utf-8').decode(buffer);
        }
    }

    // Helper: get eBay OAuth token
    async function getEbayAccessToken(): Promise<string> {
        const now = Date.now();
        if (ebayAccessToken && now < ebayAccessTokenExpiry - 60_000) {
            return ebayAccessToken;
        }

        if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
            throw new Error('Missing eBay credentials: set EBAY_CLIENT_ID/EBAY_CLIENT_SECRET');
        }

        const basicAuth = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`, 'utf8').toString('base64');
        const params = new URLSearchParams();
        params.set('grant_type', 'client_credentials');
        params.set('scope', EBAY_OAUTH_SCOPE);

        const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: `Basic ${basicAuth}`,
            },
            body: params.toString(),
        });

        if (!response.ok) {
            const text = await response.text();
            logger.error(`[listings-sync] Failed to obtain eBay OAuth token: ${response.status} ${text}`);
            throw new Error(`Failed to obtain eBay OAuth token (status ${response.status})`);
        }

        const data = await response.json() as { access_token: string; expires_in?: number };
        ebayAccessToken = data.access_token;
        const expiresInSeconds = typeof data.expires_in === 'number' ? data.expires_in : 7200;
        ebayAccessTokenExpiry = now + expiresInSeconds * 1000;

        return ebayAccessToken;
    }

    // Helper: build eBay query string
    function buildEbayQuery(book: Book): string {
        const keywords = book.ebay_keywords || '';
        const optionalWords = Array.isArray(book.ebay_optional_words) ? book.ebay_optional_words : [];
        const stopwords = Array.isArray(book.ebay_stopwords) ? book.ebay_stopwords : [];

        const optional = optionalWords.length > 0 ? `+(${optionalWords.join(',')})` : '';
        const stops = stopwords.length > 0 ? `-(${stopwords.join(',')})` : '';

        return `${keywords} ${optional} ${stops}`.trim();
    }

    // Helper: fetch a single eBay Browse page
    async function fetchEbayBrowsePage(pageNumber: number, book: Book, countryCode: string): Promise<Record<string, unknown>> {
        const accessToken = await getEbayAccessToken();

        const searchParams = new URLSearchParams();
        const q = buildEbayQuery(book);
        if (q) searchParams.set('q', q);

        searchParams.set('sort', 'price');
        searchParams.set('category_ids', '267');

        const offset = (pageNumber - 1) * REQUEST_CHUNK;
        searchParams.set('limit', String(REQUEST_CHUNK));
        searchParams.set('offset', String(offset));

        const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${searchParams.toString()}`;

        const headers: Record<string, string> = {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-EBAY-C-MARKETPLACE-ID': `EBAY_${countryCode}`,
        };

        if (EBAY_TRACKING) {
            headers['X-EBAY-C-ENDUSERCTX'] = `affiliateCampaignId=${EBAY_TRACKING},affiliateReferenceId=${EBAY_TRACKING}`;
        }

        const data = await ebayLimiter.schedule(async () => {
            const res = await fetch(url, { method: 'GET', headers });
            if (!res.ok) {
                const text = await res.text();
                logger.error(`[listings-sync] eBay Browse API error: ${res.status} ${text}`);
                throw new Error(`eBay Browse API error (status ${res.status})`);
            }
            return res.json() as Promise<Record<string, unknown>>;
        });

        return data;
    }

    // Helper: map eBay results to listings
    function mapEbayResultsToListings(
        data: Record<string, unknown>,
        countryCode: string,
        rates: FxRates,
        bookId: number
    ): Listing[] {
        const summaries = data?.['itemSummaries'] as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(summaries) || summaries.length === 0) return [];

        const listings: Listing[] = [];

        for (const summary of summaries) {
            const itemLocation = summary['itemLocation'] as Record<string, string> | undefined;
            const itemCountry = itemLocation?.['country'];
            if (itemCountry !== countryCode) continue;

            const priceObj = summary['price'] as { value?: string; currency?: string } | undefined;
            if (!priceObj?.value || !priceObj?.currency) continue;

            const price = parseFloat(priceObj.value);
            const currency = priceObj.currency;
            if (!Number.isFinite(price) || !rates[currency]) continue;

            const city = itemLocation?.['city'] || '';
            const stateOrProvince = itemLocation?.['stateOrProvince'] || '';
            const locationParts = [city, stateOrProvince].filter(Boolean);
            const locationLabel = locationParts.join(', ') || itemCountry || '';

            const title = (summary['title'] as string) || '';
            const seller = summary['seller'] as { username?: string } | undefined;
            const sellerUserName = seller?.username || '';
            const imageUrl =
                (summary['image'] as { imageUrl?: string })?.imageUrl ||
                ((summary['thumbnailImages'] as Array<{ imageUrl?: string }>) || [])[0]?.imageUrl ||
                null;

            const itemUrl = (summary['itemAffiliateWebUrl'] as string) || (summary['itemWebUrl'] as string) || '';
            const buyingOptions = (summary['buyingOptions'] as string[]) || [];
            let listingType = 'Auction';
            if (buyingOptions.includes('FIXED_PRICE') && buyingOptions.includes('AUCTION')) {
                listingType = 'AuctionWithBIN';
            } else if (buyingOptions.includes('FIXED_PRICE')) {
                listingType = 'FixedPrice';
            }

            const conditionStr = (summary['condition'] as string) || '';
            const conditionIdStr = (summary['conditionId'] as string) || '';
            const description = (summary['shortDescription'] as string) || '';

            // Generate unique key from itemId
            const itemId = (summary['itemId'] as string) || '';
            const listingKey = itemId || createHash('sha256').update(`${itemUrl}|${sellerUserName}`).digest('hex').slice(0, 32);

            listings.push({
                book: bookId,
                source: 'ebay',
                listing_key: listingKey,
                status: 'active',
                title,
                link: itemUrl,
                seller: sellerUserName,
                location: locationLabel,
                item_currency: currency,
                item_price: price,
                item_price_eur: (price * rates['EUR']) / rates[currency],
                item_price_usd: (price * rates['USD']) / rates[currency],
                item_price_gbp: (price * rates['GBP']) / rates[currency],
                listing_type: listingType,
                condition: conditionStr,
                condition_id: conditionIdStr,
                image_src: imageUrl,
                description,
                item_affiliate_web_url: (summary['itemAffiliateWebUrl'] as string) || null,
                item_web_url: (summary['itemWebUrl'] as string) || null,
                raw_data: summary as Record<string, unknown>,
            });
        }

        return listings;
    }

    // Helper: run eBay search for a book/country
    async function runEbaySearch(book: Book, countryCode: string, rates: FxRates): Promise<SearchResult> {
        const allListings: Listing[] = [];
        let ebayPage = 1;
        let makeNewQuery = true;
        let hadError = false;

        while (makeNewQuery && ebayPage <= MAX_EBAY_PAGES) {
            try {
                const data = await fetchEbayBrowsePage(ebayPage, book, countryCode);
                const totalEntries = typeof data['total'] === 'number' ? data['total'] : 0;
                const totalPages = totalEntries > 0 ? Math.ceil(totalEntries / REQUEST_CHUNK) : 0;

                const listings = mapEbayResultsToListings(data, countryCode, rates, book.id);
                allListings.push(...listings);

                if (!totalEntries || !totalPages || ebayPage >= totalPages || ebayPage >= MAX_EBAY_PAGES) {
                    makeNewQuery = false;
                } else {
                    ebayPage += 1;
                }
            } catch (e) {
                logger.warn(`[listings-sync] eBay error for book ${book.id} ${countryCode}: ${e}`);
                makeNewQuery = false;
                hadError = true;
            }
        }

        return { listings: allListings, success: !hadError, source: 'ebay' };
    }

    // Helper: fetch and parse AbeBooks listings (simplified scraping via fetch)
    async function runAbebooksSearch(book: Book, rates: FxRates): Promise<SearchResult> {
        const listings: Listing[] = [];
        const stopwords = Array.isArray(book.abebooks_stopwords) ? book.abebooks_stopwords : [];

        // Build search URL
        const keywords = `${book.ebay_keywords || ''} ${(book.ebay_optional_words || []).join(' ')}`.trim();
        const isbnParam = book.isbn13 ? `&isbn=${encodeURIComponent(book.isbn13)}` : '';
        const searchUrl = `https://www.abebooks.co.uk/servlet/SearchResults?ds=50&sortby=3&tn=${encodeURIComponent(book.title)}&kn=${encodeURIComponent(keywords)}${isbnParam}`;

        try {
            const res = await fetch(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; DirectusBot/1.0)',
                    Accept: 'text/html',
                },
            });

            if (!res.ok) {
                logger.warn(`[listings-sync] AbeBooks fetch failed for book ${book.id}: ${res.status}`);
                return { listings: [], success: false, source: 'abebooks' };
            }

            const html = await decodeResponseBody(res);

            // Simple regex-based extraction (minimal scraping)
            // AbeBooks wraps each result in an <li class="result-item"> (not a div)
            const itemRegex = /<li[^>]*class="[^"]*\bresult-item\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
            const titleRegex = /<span[^>]*data-(?:cy|test-id)="listing-title"[^>]*>([^<]+)<\/span>/i;
            const priceMetaRegex = /<meta[^>]*itemprop="price"[^>]*content="([\d.,]+)"/i;
            const priceTextRegex = /<p[^>]*class="[^"]*item-price[^"]*"[^>]*>[^0-9]*([\d.,]+)/i;
            const linkRegex = /<a[^>]*(?:itemprop="url"|data-(?:cy|test-id)="listing-title")[^>]*href="([^"]+)"/i;
            const sellerRegex = /<span[^>]*data-(?:cy|test-id)="listing-seller-name"[^>]*>([^<]+)<\/span>/i;
            const subConditionRegex = /<span[^>]*(?:class="[^"]*\bopt-subcondition\b[^"]*"|data-(?:cy|test-id)="listing-optional-condition")[^>]*>([^<]+)<\/span>/i;
            const conditionRegex = /<span[^>]*data-(?:cy|test-id)="listing-book-condition"[^>]*>([^<]+)<\/span>/i;
            const imageRegex = /<img[^>]*class="[^"]*\bsrp-item-image\b[^"]*"[^>]*src="([^"]+)"/i;
            const locationRegex = /from\s+([^<]+?)\s+to/i;

            let match;
            while ((match = itemRegex.exec(html)) !== null) {
                const block = match[1] || '';

                const titleMatch = titleRegex.exec(block);
                const title = titleMatch && titleMatch[1] ? decode(titleMatch[1].trim()) : '';

                // Check stopwords
                if (stopwords.some((sw) => title.toLowerCase().includes(sw.toLowerCase()))) continue;

                const priceMatch = priceMetaRegex.exec(block) || priceTextRegex.exec(block);
                const priceRaw = priceMatch ? priceMatch[1] || priceMatch[2] : null;
                const priceGBP = priceRaw ? parseFloat(priceRaw.replace(',', '')) : null;
                if (priceGBP === null || !Number.isFinite(priceGBP)) continue;

                const linkMatch = linkRegex.exec(block);
                const link = linkMatch ? `https://www.abebooks.co.uk${linkMatch[1]}` : '';

                const sellerMatch = sellerRegex.exec(block);
                const seller = sellerMatch && sellerMatch[1] ? decode(sellerMatch[1].trim()) : '';

                const subConditionMatch = subConditionRegex.exec(block);
                const rawSubCondition = subConditionMatch && subConditionMatch[1] ? decode(subConditionMatch[1].trim()) : '';
                const rawConditionFromSpan = (() => {
                    if (rawSubCondition) return rawSubCondition.replace(/^Condition:\s*/i, '').trim();
                    const conditionMatch = conditionRegex.exec(block);
                    return conditionMatch && conditionMatch[1] ? decode(conditionMatch[1].trim()) : '';
                })();
                const condition = rawConditionFromSpan.includes('-')
                    ? rawConditionFromSpan.split('-')[0].trim()
                    : rawConditionFromSpan;

                const imageMatch = imageRegex.exec(block);
                const imageSrc = imageMatch ? imageMatch[1] : null;

                const locationMatch = locationRegex.exec(block);
                const location = locationMatch && locationMatch[1] ? locationMatch[1].trim() : null;

                const listingKey = createHash('sha256').update(`${link}|${seller}`).digest('hex').slice(0, 32);

                listings.push({
                    book: book.id,
                    source: 'abebooks',
                    listing_key: listingKey,
                    status: 'active',
                    title,
                    link,
                    seller,
                    location,
                    item_currency: 'GBP',
                    item_price: priceGBP,
                    item_price_eur: (priceGBP * rates['EUR']) / rates['GBP'],
                    item_price_usd: (priceGBP * rates['USD']) / rates['GBP'],
                    item_price_gbp: priceGBP,
                    listing_type: 'FixedPrice',
                    condition,
                    condition_id: null,
                    image_src: imageSrc || null,
                    description: null,
                    item_affiliate_web_url: null,
                    item_web_url: link,
                    raw_data: null,
                });
            }

            return { listings, success: true, source: 'abebooks' };
        } catch (e) {
            logger.warn(`[listings-sync] AbeBooks scrape error for book ${book.id}: ${e}`);
            return { listings: [], success: false, source: 'abebooks' };
        }
    }

    // Main sync logic
    async function syncListings(bookIds?: (number | string)[], sources?: string[]) {
        const startTime = Date.now();
        logger.info(`[listings-sync] Starting sync (dryRun=${dryRun}, ids=${bookIds?.join(',') || 'all'}, sources=${sources?.join(',') || 'all'})`);

        const schema = await getSchema();

        // Fetch FX rates
        let rates: FxRates;
        try {
            const ratesRes = await fetch(EXCHANGE_RATES_URL);
            const ratesJson = (await ratesRes.json()) as { rates: FxRates };
            rates = ratesJson.rates;
            logger.info(`[listings-sync] FX rates loaded: EUR=${rates.EUR}, USD=${rates.USD}, GBP=${rates.GBP}`);
        } catch (e) {
            logger.error(`[listings-sync] Failed to fetch FX rates: ${e}`);
            return;
        }

        // Fetch all books
        const booksService = new ItemsService('books', { schema, knex: database });
        
        const query: Record<string, any> = {
            fields: ['id', 'url', 'title', 'isbn13', 'ebay_keywords', 'ebay_optional_words', 'ebay_stopwords', 'abebooks_stopwords'],
            limit: -1,
        };

        if (bookIds && bookIds.length > 0) {
            query['filter'] = { id: { _in: bookIds } };
        }

        const books: Book[] = await booksService.readByQuery(query) as Array<Book>;

        logger.info(`[listings-sync] Loaded ${books.length} books`);

        const listingsService = new ItemsService('listings', { schema, knex: database });
        const now = new Date().toISOString();

        let totalCreated = 0;
        let totalUpdated = 0;
        let totalRetired = 0;

        for (const book of books) {
            // Skip books without search config
            if (!book.ebay_keywords && !book.title) continue;

            // Fetch listings from both sources
            const ebayCountries = ['DE', 'AT', 'CH', 'IT', 'FR', 'GB', 'US'];
            const searchPromises: Promise<SearchResult>[] = [];
            const runEbay = !sources || sources.includes('ebay');
            const runAbebooks = !sources || sources.includes('abebooks');

            if (runEbay) {
                searchPromises.push(...ebayCountries.map((cc) => runEbaySearch(book, cc, rates)));
            }
            if (runAbebooks) {
                searchPromises.push(runAbebooksSearch(book, rates));
            }

            const results = await Promise.all(searchPromises);

            // Track which sources succeeded (all searches for that source must succeed)
            const ebaySuccess = runEbay && results.filter(r => r.source === 'ebay').every(r => r.success);
            const abebooksSuccess = runAbebooks && results.filter(r => r.source === 'abebooks').every(r => r.success);

            // Only include listings from successful searches
            const newListings = results.filter(r => r.success).flatMap(r => r.listings);

            // Dedupe by listing_key (same source + key)
            const listingsByKey = new Map<string, Listing>();
            for (const listing of newListings) {
                const key = `${listing.source}:${listing.listing_key}`;
                if (!listingsByKey.has(key)) {
                    listingsByKey.set(key, listing);
                }
            }

            const deduped = Array.from(listingsByKey.values());

            // Fetch existing active listings for this book
            const existingListings = await listingsService.readByQuery({
                fields: ['id', 'listing_key', 'source', 'status'],
                filter: { book: { _eq: book.id }, status: { _eq: 'active' } },
                limit: -1,
            }) as Array<{ id: string; listing_key: string; source: string; status: string }>;

            const existingKeySet = new Set(existingListings.map((l) => `${l.source}:${l.listing_key}`));
            const newKeySet = new Set(deduped.map((l) => `${l.source}:${l.listing_key}`));

            // Upsert new/updated listings
            for (const listing of deduped) {
                const key = `${listing.source}:${listing.listing_key}`;
                const existing = existingListings.find((e) => `${e.source}:${e.listing_key}` === key);

                if (dryRun) {
                    if (existing) {
                        logger.info(`[listings-sync] [DRY-RUN] Would update listing ${existing.id}`);
                    } else {
                        logger.info(`[listings-sync] [DRY-RUN] Would create listing for book ${book.id} key=${listing.listing_key}`);
                    }
                    continue;
                }

                if (existing) {
                    await listingsService.updateOne(existing.id, {
                        ...listing,
                        date_last_seen: now,
                    }, { emitEvents: false });
                    totalUpdated += 1;
                } else {
                    await listingsService.createOne({
                        ...listing,
                        date_first_seen: now,
                        date_last_seen: now,
                    }, { emitEvents: false });
                    totalCreated += 1;
                }
            }

            // Retire listings no longer active
            for (const existing of existingListings) {
                // If source was not run or failed, skip retirement
                if (existing.source === 'ebay' && (!runEbay || !ebaySuccess)) continue;
                if (existing.source === 'abebooks' && (!runAbebooks || !abebooksSuccess)) continue;

                const key = `${existing.source}:${existing.listing_key}`;
                if (!newKeySet.has(key)) {
                    if (dryRun) {
                        logger.info(`[listings-sync] [DRY-RUN] Would retire listing ${existing.id}`);
                        continue;
                    }

                    const clearFields: Record<string, null> = {};
                    for (const field of HEAVY_FIELDS_TO_CLEAR) {
                        clearFields[field] = null;
                    }

                    await listingsService.updateOne(existing.id, {
                        status: 'inactive',
                        date_last_seen: now,
                        ...clearFields,
                    }, { emitEvents: false });
                    totalRetired += 1;
                }
            }

            logger.info(`[listings-sync] Processed book ${book.id} (${book.url}): ${deduped.length} listings`);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.info(`[listings-sync] Sync complete in ${elapsed}s: created=${totalCreated}, updated=${totalUpdated}, retired=${totalRetired}`);
    }

    // Register cron
    schedule(cronExpression, async () => {
        try {
            await syncListings();
        } catch (e) {
            logger.error(`[listings-sync] Sync failed: ${e}`);
        }
    });

    logger.info(`[listings-sync] Registered cron: ${cronExpression}`);

    // Register custom route for manual trigger via Flow
    init('routes.before', async ({ app }) => {
        // Ensure bodies are parsed even if Flow omits Content-Type
        app.use('/listings-sync', express.json({ limit: '1mb', strict: false }));
        app.use('/listings-sync', express.text({ type: '*/*', limit: '1mb' }));

        app.post('/listings-sync', async (req: any, res: any) => {
            try {
                // Ensure request is authenticated
                let authorized = false;
                if (req.accountability && req.accountability.user) authorized = true;
                if (SYNC_SECRET && req.headers['x-sync-secret'] === SYNC_SECRET) authorized = true;

                if (!authorized) {
                    return res.status(401).send('Unauthorized');
                }

                // Parse body safely (Flow may send it as a raw string)
                let parsedBody = req.body ?? {};
                if (typeof parsedBody === 'string') {
                    try {
                        parsedBody = JSON.parse(parsedBody);
                    } catch {
                        return res.status(400).send('Invalid JSON payload.');
                    }
                }

                let { keys, sources } = parsedBody as { keys?: unknown; sources?: unknown };

                if (typeof keys === 'string') {
                    try {
                        const parsedKeys = JSON.parse(keys);
                        if (Array.isArray(parsedKeys)) keys = parsedKeys;
                    } catch {
                        // fall through and let validation handle
                    }
                }
                
                const keyList: Array<number | string> | undefined = Array.isArray(keys) ? keys : undefined;
                const sourceList: string[] | undefined = Array.isArray(sources) ? sources.map((s) => String(s)) : undefined;

                // Require both keys and sources to be provided
                if (keyList === undefined || sourceList === undefined) {
                    return res.status(400).send('Invalid payload. "keys" and "sources" are required.');
                }

                if (keys !== undefined) {
                    if (!Array.isArray(keyList) || keyList.length === 0) {
                        return res.status(400).send('Invalid payload. Expected "keys" array.');
                    }
                }
                
                if (sources !== undefined) {
                    if (!Array.isArray(sourceList) || sourceList.length === 0) {
                        return res.status(400).send('Invalid payload. Expected "sources" array.');
                    }
                }

                await syncListings(keyList, sourceList);
                
                res.json({ success: true, message: `Synced ${keyList ? keyList.length : 'all'} books` });
            } catch (e) {
                logger.error(e);
                res.status(500).json({ error: e instanceof Error ? e.message : 'Unknown error' });
            }
        });
    });
});

