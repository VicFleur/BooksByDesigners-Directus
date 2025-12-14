import { createHash } from 'crypto';

async function runAbebooksSearch(book, rates) {
    const listings = [];
    const stopwords = Array.isArray(book.abebooks_stopwords) ? book.abebooks_stopwords : [];

    // Build search URL
    const keywords = `${book.ebay_keywords || ''} ${(book.ebay_optional_words || []).join(' ')}`.trim();
    const searchUrl = `https://www.abebooks.co.uk/servlet/SearchResults?sortby=3&tn=${encodeURIComponent(book.title)}&kn=${encodeURIComponent(keywords)}`;

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

        const html = await res.text();

        // Simple regex-based extraction (minimal scraping)
        // AbeBooks wraps each result in an <li class="result-item"> (not a div)
        const itemRegex = /<li[^>]*class="[^"]*\bresult-item\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
        const titleRegex = /<span[^>]*data-(?:cy|test-id)="listing-title"[^>]*>([^<]+)<\/span>/i;
        const priceMetaRegex = /<meta[^>]*itemprop="price"[^>]*content="([\d.,]+)"/i;
        const priceTextRegex = /<p[^>]*class="[^"]*item-price[^"]*"[^>]*>[^0-9]*([\d.,]+)/i;
        const linkRegex = /<a[^>]*(?:itemprop="url"|data-(?:cy|test-id)="listing-title")[^>]*href="([^"]+)"/i;
        const sellerRegex = /<span[^>]*data-(?:cy|test-id)="listing-seller-name"[^>]*>([^<]+)<\/span>/i;
        const conditionRegex = /<span[^>]*data-(?:cy|test-id)="listing-book-condition"[^>]*>([^<]+)<\/span>/i;

        let match;
        while ((match = itemRegex.exec(html)) !== null) {
            const block = match[1] || '';

            const titleMatch = titleRegex.exec(block);
            const title = titleMatch ? titleMatch[1].trim() : '';

            // Check stopwords
            if (stopwords.some((sw) => title.toLowerCase().includes(sw.toLowerCase()))) continue;

            const priceMatch = priceMetaRegex.exec(block) || priceTextRegex.exec(block);
            const priceRaw = priceMatch ? priceMatch[1] || priceMatch[2] : null;
            const priceGBP = priceRaw ? parseFloat(priceRaw.replace(',', '')) : null;
            if (priceGBP === null || !Number.isFinite(priceGBP)) continue;

            const linkMatch = linkRegex.exec(block);
            const link = linkMatch ? `https://www.abebooks.co.uk${linkMatch[1]}` : '';

            const sellerMatch = sellerRegex.exec(block);
            const seller = sellerMatch ? sellerMatch[1].trim() : '';

            const conditionMatch = conditionRegex.exec(block);
            const condition = conditionMatch ? conditionMatch[1].trim() : '';

            const listingKey = createHash('sha256').update(`${link}|${seller}`).digest('hex').slice(0, 32);

            listings.push({
                book: book.id,
                source: 'abebooks',
                listing_key: listingKey,
                status: 'active',
                title,
                link,
                seller,
                location: null,
                item_currency: 'GBP',
                item_price: priceGBP,
                item_price_eur: (priceGBP * rates['EUR']) / rates['GBP'],
                item_price_usd: (priceGBP * rates['USD']) / rates['GBP'],
                item_price_gbp: priceGBP,
                listing_type: 'FixedPrice',
                condition,
                condition_id: null,
                image_src: null,
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
        title: 'perennials',
        ebay_keywords: 'taylor guide to perennials',
        abebooks_stopwords: ['proven', 'for sun', '600', '1989', 'for shade']
    };
    const rates = {
        EUR: 1.1,
        USD: 1.2,
        GBP: 1.3,
    };
    const listings = await runAbebooksSearch(book, rates);
    console.log(listings);
})();