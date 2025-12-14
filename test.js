import { createHash } from 'crypto';
import { decode } from 'he';

function getCharset(contentType) {
    if (!contentType) return 'utf-8';
    const match = /charset=([^;]+)/i.exec(contentType);
    return match && match[1] ? match[1].toLowerCase() : 'utf-8';
}

async function decodeResponseBody(res) {
    const buffer = await res.arrayBuffer();
    const charset = getCharset(res.headers.get('content-type'));
    const normalized = charset === 'iso-8859-1' ? 'latin1' : charset;
    try {
        return new TextDecoder(normalized).decode(buffer);
    } catch {
        return new TextDecoder('utf-8').decode(buffer);
    }
}

async function runAbebooksSearch(book, rates) {
    const listings = [];
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
            return listings;
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
            const title = titleMatch ? decode(titleMatch[1].trim()) : '';

            // Check stopwords
            if (stopwords.some((sw) => title.toLowerCase().includes(sw.toLowerCase()))) continue;

            const priceMatch = priceMetaRegex.exec(block) || priceTextRegex.exec(block);
            const priceRaw = priceMatch ? priceMatch[1] || priceMatch[2] : null;
            const priceGBP = priceRaw ? parseFloat(priceRaw.replace(',', '')) : null;
            if (priceGBP === null || !Number.isFinite(priceGBP)) continue;

            const linkMatch = linkRegex.exec(block);
            const link = linkMatch ? `https://www.abebooks.co.uk${linkMatch[1]}` : '';

            const sellerMatch = sellerRegex.exec(block);
            const seller = sellerMatch ? decode(sellerMatch[1].trim()) : '';

            const subConditionMatch = subConditionRegex.exec(block);
            const rawSubCondition = subConditionMatch ? decode(subConditionMatch[1].trim()) : '';
            const rawConditionFromSpan = (() => {
                if (rawSubCondition) return rawSubCondition.replace(/^Condition:\s*/i, '').trim();
                const conditionMatch = conditionRegex.exec(block);
                return conditionMatch ? decode(conditionMatch[1].trim()) : '';
            })();
            const condition = rawConditionFromSpan.includes('-')
                ? rawConditionFromSpan.split('-')[0].trim()
                : rawConditionFromSpan;

            const imageMatch = imageRegex.exec(block);
            const imageSrc = imageMatch ? imageMatch[1] : null;

            const locationMatch = locationRegex.exec(block);
            const location = locationMatch ? locationMatch[1].trim() : null;

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
                image_src: imageSrc,
                description: null,
                item_affiliate_web_url: null,
                item_web_url: link,
                raw_data: null,
            });
        }
    } catch (e) {
        console.warn(`[listings-sync] AbeBooks scrape error for book ${book.id}: ${e}`);
    }

    return listings;
}

(async () => {
    const book = {
        id: 1,
        title: 'ERCO Lichtfabrik',
        ebay_keywords: 'erco lichtfabrik',
        abebooks_stopwords: [],
        isbn13: '9783433021866'
    };
    const rates = {
        EUR: 1.1,
        USD: 1.2,
        GBP: 1.3,
    };
    const listings = await runAbebooksSearch(book, rates);
    console.log(listings);
})();