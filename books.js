import "dotenv/config";
import { AssetCache } from "@11ty/eleventy-fetch";
import { GraphQLClient, gql } from "graphql-request";
import { Scraper, Root, CollectContent } from "nodejs-web-scraper";
import Bottleneck from "bottleneck";

const requestChunk = 50;

// eBay OAuth and rate limiting (Browse API)
const EBAY_CLIENT_ID =
    process.env.EBAY_CLIENT_ID || process.env.EBAY_CLIENTID || "";
const EBAY_CLIENT_SECRET =
    process.env.EBAY_CLIENT_SECRET || process.env.EBAY_CLIENTSECRET || "";
const EBAY_OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";

const MAX_EBAY_PAGES = parseInt(process.env.EBAY_MAX_PAGES || "3", 10);
const EBAY_MAX_CONCURRENT = parseInt(
    process.env.EBAY_MAX_CONCURRENT || "2",
    10
);
const EBAY_MIN_TIME_MS = parseInt(process.env.EBAY_MIN_TIME_MS || "200", 10);

const ebayLimiter = new Bottleneck({
    maxConcurrent: EBAY_MAX_CONCURRENT,
    minTime: EBAY_MIN_TIME_MS,
});

let ebayAccessToken = null;
let ebayAccessTokenExpiry = 0; // epoch ms
let ebayRequestCount = 0;

async function getEbayAccessToken() {
    const now = Date.now();

    if (ebayAccessToken && now < ebayAccessTokenExpiry - 60_000) {
        return ebayAccessToken;
    }

    if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
        throw new Error(
            "Missing eBay credentials: set EBAY_CLIENT_ID/EBAY_CLIENT_SECRET or EBAY_CLIENTID/EBAY_CLIENTSECRET"
        );
    }

    const basicAuth = Buffer.from(
        `${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`,
        "utf8"
    ).toString("base64");

    const params = new URLSearchParams();
    params.set("grant_type", "client_credentials");
    params.set("scope", EBAY_OAUTH_SCOPE);

    const response = await fetch(
        "https://api.ebay.com/identity/v1/oauth2/token",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Basic ${basicAuth}`,
            },
            body: params.toString(),
        }
    );

    if (!response.ok) {
        const text = await response.text();
        console.error("[books] Failed to obtain eBay OAuth token", {
            status: response.status,
            statusText: response.statusText,
            body: text,
        });
        throw new Error(
            `Failed to obtain eBay OAuth token (status ${response.status})`
        );
    }

    const data = await response.json();
    ebayAccessToken = data.access_token;
    const expiresInSeconds =
        typeof data.expires_in === "number" ? data.expires_in : 7200;
    ebayAccessTokenExpiry = now + expiresInSeconds * 1000;

    return ebayAccessToken;
}

function buildEbayQuery(book) {
    const keywords = book.ebayKeywords || "";
    const optionalWords = Array.isArray(book.ebayOptionalWords)
        ? book.ebayOptionalWords
        : [];
    const stopwords = Array.isArray(book.ebayStopwords)
        ? book.ebayStopwords
        : [];

    const optional =
        optionalWords.length > 0
            ? `+(${optionalWords.join(",")})`
            : "";
    const stops =
        stopwords.length > 0 ? `-(${stopwords.join(",")})` : "";

    return `${keywords} ${optional} ${stops}`.trim();
}

function getMarketplaceId(countryCode) {
    return `EBAY_${countryCode}`;
}

async function fetchEbayBrowsePage(pageNumber, book, countryCode) {
    const accessToken = await getEbayAccessToken();

    const searchParams = new URLSearchParams();
    const q = buildEbayQuery(book);
    if (q) {
        searchParams.set("q", q);
    }

    searchParams.set("sort", "price");
    searchParams.set("category_ids", "267");

    const offset = (pageNumber - 1) * requestChunk;
    searchParams.set("limit", String(requestChunk));
    searchParams.set("offset", String(offset));

    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${searchParams.toString()}`;

    ebayRequestCount += 1;
    console.log("[books] eBay Browse request", {
        book: book.url,
        countryCode,
        pageNumber,
        q,
    });

    const headers = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(countryCode),
    };

    const tracking = process.env.EBAY_TRACKING;
    if (tracking) {
        headers["X-EBAY-C-ENDUSERCTX"] = `affiliateCampaignId=${tracking},affiliateReferenceId=${tracking}`;
    }

    const data = await ebayLimiter.schedule(async () => {
        const res = await fetch(url, {
            method: "GET",
            headers,
        });

        if (!res.ok) {
            const text = await res.text();
            console.error("[books] eBay Browse API error", {
                status: res.status,
                statusText: res.statusText,
                body: text,
                url,
            });
            throw new Error(`eBay Browse API error (status ${res.status})`);
        }

        return res.json();
    });

    return data;
}

function mapEbayResultsToItems(data, countryCode, rates) {
    const totalEntries = typeof data?.total === "number" ? data.total : 0;
    const totalPages =
        totalEntries > 0 && requestChunk > 0
            ? Math.ceil(totalEntries / requestChunk)
            : 0;

    if (
        !data ||
        !Array.isArray(data.itemSummaries) ||
        data.itemSummaries.length === 0
    ) {
        return {
            items: [],
            totalEntries,
            totalPages,
        };
    }

    const items = data.itemSummaries.reduce((acc, summary) => {
        const itemLocation = summary.itemLocation || {};
        const itemCountry = itemLocation.country;

        if (itemCountry !== countryCode) {
            return acc;
        }

        if (
            !summary.price ||
            typeof summary.price.value === "undefined" ||
            !summary.price.currency
        ) {
            return acc;
        }

        const price = parseFloat(summary.price.value);
        const currency = summary.price.currency;

        if (!Number.isFinite(price) || !rates[currency]) {
            return acc;
        }

        const city = itemLocation.city || "";
        const stateOrProvince = itemLocation.stateOrProvince || "";
        const locationParts = [city, stateOrProvince].filter(Boolean);
        const locationLabel = locationParts.join(", ") || itemCountry || "";

        // Extract title
        const title = summary.title || "";

        // Extract seller info
        const sellerUserName =
            summary.seller && summary.seller.username
                ? String(summary.seller.username)
                : "";

        // Extract image URL
        const imageUrl =
            (summary.image && summary.image.imageUrl) ||
            (Array.isArray(summary.thumbnailImages) &&
                summary.thumbnailImages.length > 0 &&
                summary.thumbnailImages[0].imageUrl) ||
            null;

        // Extract item URL (prefer affiliate)
        const itemUrl =
            summary.itemAffiliateWebUrl || summary.itemWebUrl || summary.itemHref || "";

        // Derive listing type from buyingOptions
        const buyingOptions = Array.isArray(summary.buyingOptions)
            ? summary.buyingOptions
            : [];
        let listingType = "Auction";
        if (
            buyingOptions.includes("FIXED_PRICE") &&
            buyingOptions.includes("AUCTION")
        ) {
            listingType = "AuctionWithBIN";
        } else if (buyingOptions.includes("FIXED_PRICE")) {
            listingType = "FixedPrice";
        } else if (buyingOptions.includes("AUCTION")) {
            listingType = "Auction";
        }

        // Extract condition
        const condition = summary.condition || "";
        const conditionId = summary.conditionId || "";

        // Extract description
        const description = summary.shortDescription || "";

        acc.push({
            source: "ebay",
            // Flat fields for parity with AbeBooks entries
            title,
            link: itemUrl,
            condition,
            conditionId,
            seller: sellerUserName,
            location: locationLabel,
            imageSrc: imageUrl,
            description,
            // Preserve itemAffiliateWebUrl for template compatibility
            itemAffiliateWebUrl: summary.itemAffiliateWebUrl || "",
            itemWebUrl: summary.itemWebUrl || "",
            // Price fields
            itemPrice: price,
            itemCurrency: currency,
            itemPriceEUR: (price * rates["EUR"]) / rates[currency],
            itemPriceUSD: (price * rates["USD"]) / rates[currency],
            itemPriceGBP: (price * rates["GBP"]) / rates[currency],
            // Legacy Finding API structure for downstream compatibility
            sellingStatus: [
                {
                    currentPrice: [
                        {
                            __value__: String(summary.price.value),
                        },
                    ],
                },
            ],
            sellerInfo: [
                {
                    sellerUserName: sellerUserName ? [sellerUserName] : [],
                },
            ],
            country: itemCountry ? [itemCountry] : [],
            listingInfo: [
                {
                    listingType: [listingType],
                    buyItNowPrice: [
                        {
                            __value__: String(summary.price.value),
                        },
                    ],
                },
            ],
            viewItemURL: itemUrl ? [itemUrl] : [],
            pictureURLLarge: imageUrl ? [imageUrl] : [],
            pictureURLSuperSize: [],
            galleryURL: imageUrl ? [imageUrl] : [],
            // Keep raw Browse API response for debugging
            _raw: summary,
        });

        return acc;
    }, []);

    return {
        items,
        totalEntries,
        totalPages,
    };
}

async function fetchEbayPage(pageNumber, book, countryCode, rates) {
    const cacheKey = `book_${book.url}_ebay-${countryCode}_page-${pageNumber}`;
    const asset = new AssetCache(cacheKey);
    let data = null;

    if (asset.isCacheValid("1d")) {
        data = await asset.getCachedValue();
    } else {
        console.log("[books] No valid eBay cache, fetching page", {
            book: book.url,
            countryCode,
            pageNumber,
        });
        data = await fetchEbayBrowsePage(pageNumber, book, countryCode);
        if (data && data.href) {
            await asset.save(data, "json");
        }
    }

    return mapEbayResultsToItems(data || {}, countryCode, rates);
}

export default async function books() {

    //const rates = await exchangeRates().setApiBaseUrl('https://api.exchangerate.host').latest().symbols(['EUR', 'USD', 'GBP']).fetch();
    //const rates = await exchangeRates().setApiBaseUrl('https://api.exchangeratesapi.io/v1').latest().symbols(['EUR', 'USD', 'GBP']).fetch();

    console.log("[books] Starting books data fetch");

    const ratesResponse = await fetch('http://api.exchangeratesapi.io/v1/latest?access_key=53af9fd44c212751829b71979e140b25&format=1&symbols=EUR,USD,GBP');
    const ratesJson = await ratesResponse.json();
    const rates = ratesJson.rates;

    console.log("[books] Loaded FX rates", rates);

    const endPoint = process.env.GRAPHCMS_URL;
    const graphcms = new GraphQLClient(endPoint);

    let makeNewQuery = true;
    let cursor = null;
    let books = [];

    while (makeNewQuery) {
        //try {

        console.log("[books] Fetching GraphCMS books page", { cursor });

        const query = gql`
                query Books($after: String) {
                    booksConnection(after:$after, orderBy: createdAt_DESC) {
                        pageInfo {
                            hasNextPage
                            endCursor
                        }
                        edges {
                            cursor
                            node {
                                createdAt
                                updatedAt

                                id
                                url
                                title
                                subtitle
                                year
                                publisher
                                designer {
                                    name
                                    url
                                }
                                cover {
                                    handle
                                    height
                                    width
                                    mimeType
                                    size
                                }
                                authors

                                serie {
                                    id
                                    name
                                    url
                                    books(first: 100) {
                                        id
                                    }
                                }
                                showInHomepage
                                
                                coverType
                                dustJacket
                                slipCase

                                isbn10
                                isbn13
                                pages
                                languages
                                size

                                ebayKeywords
                                ebayOptionalWords
                                ebayStopwords
                                abebooksStopwords
                            }
                        }
                    }
                }
            `;

        const response = await graphcms.request(query, { after: cursor });
        cursor = response.booksConnection.pageInfo.endCursor;

        const page_books = response.booksConnection.edges.map((item) => item.node);
        books.push(...page_books);

        console.log("[books] Received books from page", {
            pageCount: page_books.length,
            totalBooks: books.length,
        });

        await Promise.all(page_books.map(async (book) => {

            // Only process the freshly fetched books for this page.
            // Reprocessing the whole list on every page was triggering
            // additional eBay calls later in the loop which could fail and
            // overwrite previously collected listings.

            let item_ads = []

            await Promise.all([
                runEbaySearch(book, 'DE', rates, item_ads),
                runEbaySearch(book, 'AT', rates, item_ads),
                runEbaySearch(book, 'CH', rates, item_ads),
                runEbaySearch(book, 'IT', rates, item_ads),
                runEbaySearch(book, 'FR', rates, item_ads),
                runEbaySearch(book, 'GB', rates, item_ads),
                runEbaySearch(book, 'US', rates, item_ads),
                runAbebooksSearch(book, rates, item_ads)
            ]);

            const ads_by_price = [...item_ads].sort(ascendingPrice);

            book.ads_by_price = ads_by_price;

        }));

        if (!response.booksConnection.pageInfo.hasNextPage) makeNewQuery = false;

        //} catch (error) {
        //    throw new Error(error);
        //}
    }

    console.log("[books] Finished books data fetch", {
        totalBooks: books.length,
        ebayRequests: ebayRequestCount,
    });

    return books;
}

async function runEbaySearch(book, countryCode, rates, item_ads) {
    let ebayPage = 1;
    let makeNewEbayQuery = true;

    console.log("[books] runEbaySearch start", {
        book: book.url,
        countryCode,
    });

    while (makeNewEbayQuery && ebayPage <= MAX_EBAY_PAGES) {
        try {
            console.log("[books] runEbaySearch page", {
                book: book.url,
                countryCode,
                ebayPage,
            });

            const { items, totalEntries, totalPages } = await fetchEbayPage(
                ebayPage,
                book,
                countryCode,
                rates
            );

            if (items && items.length > 0) {
                item_ads.push(...items);
            }

            console.log("[books] runEbaySearch page result", {
                book: book.url,
                countryCode,
                ebayPage,
                items: items ? items.length : 0,
                totalEntries,
                totalPages,
            });

            if (
                !totalEntries ||
                !totalPages ||
                ebayPage >= totalPages ||
                ebayPage >= MAX_EBAY_PAGES
            ) {
                makeNewEbayQuery = false;
            } else {
                ebayPage += 1;
            }
        } catch (e) {
            makeNewEbayQuery = false;
            // Swallow eBay errors so a single failure doesn't break the build
        }
    }
}
async function runAbebooksSearch(book, rates, item_ads) {

    let asset = new AssetCache(`book_${book.url}_abebooks`);
    let data = null

    if (asset.isCacheValid("1d")) {
        //if (false) {
        data = await asset.getCachedValue()
    } else {

        const config = {
            baseSiteUrl: 'https://www.abebooks.co.uk/',
            startUrl: `https://www.abebooks.co.uk/servlet/SearchResults?sortby=3&tn=${encodeURIComponent(book.title)}&kn=${encodeURIComponent((`${book.ebayKeywords} ${book.ebayOptionalWord ? book.ebayOptionalWord : ''}`).trim())}`,
            concurrency: 10,
            maxRetries: 2,
            showConsoleLogs: false,
            encoding: 'latin1'
        }

        const scraper = new Scraper(config);

        const root = new Root({ pagination: { queryString: 'bsi', begin: 0, end: 150, offset: 30 } });

        const title = new CollectContent('.result-detail h2 a span', { name: 'title' });
        const condition = new CollectContent('span[data-cy=listing-book-condition]', { name: 'condition' })
        const seller = new CollectContent('.bookseller-info a[data-cy=listing-seller-link]', { name: 'seller' })
        const location = new CollectContent('.bookseller-info p.text-secondary', {
            name: 'location', getElementContent: (elementContentString) => {
                const splitLines = elementContentString.split('\n')
                const splitCommas = splitLines[1].trim().split(',')
                splitCommas.shift()
                return splitCommas.join(',').trim()
            }
        });
        const link = new CollectContent('.result-detail h2.title a', {
            name: 'link', getElementContent: (elementContentString, pageAddress, element) => {
                return element.attr('href')
            }
        })
        const imageSrc = new CollectContent('.srp-image-holder img', {
            name: 'imageSrc', getElementContent: (elementContentString, pageAddress, element) => {
                return element.attr('src')
            }
        })
        const price = new CollectContent('.item-price', {
            name: 'price', getElementContent: (elementContentString) => {
                return elementContentString.split(' ')[1].replace(',', '')
            }
        });
        const subCondition = new CollectContent('.buy-box-data', {
            name: 'subCondition', getElementContent: (elementContentString, pageAddress, element) => {
                const subCondition = element.find('.opt-subcondition').text()
                if (subCondition) return subCondition.replace('Condition: ', '')
                else return ''
            }
        })
        const isbn = new CollectContent('.result-detail', {
            name: 'isbn', getElementContent: (elementContentString, pageAddress, element) => {
                const isbn = element.find('p.isbn span.pl-md').text()
                if (isbn) return isbn.split(':')[1].trim()
                else return ''
            }
        })
        const pubData = new CollectContent('.result-detail', {
            name: 'pubData', getElementContent: (elementContentString, pageAddress, element) => {
                const pubData = element.find('p.pub-data.text-secondary').text()
                if (pubData) return pubData
                else return ''
            }
        })
        const description = new CollectContent('.desc-container p', { name: 'description' });

        root.addOperation(title);
        root.addOperation(condition);
        root.addOperation(subCondition);
        root.addOperation(seller);
        root.addOperation(location);
        root.addOperation(link)
        root.addOperation(imageSrc);
        root.addOperation(price);
        root.addOperation(description);
        root.addOperation(pubData)
        root.addOperation(isbn)

        await scraper.scrape(root);

        const scrapedPages = root.getData()
        data = scrapedPages.data

        //console.log(data)

        await asset.save(scrapedPages.data, "json");
    }

    data.filter(p => !p.error).forEach(page => {

        const titles = page.data.find(content => content.name === 'title').data;
        const links = page.data.find(content => content.name === 'link').data;
        const conditions = page.data.find(content => content.name === 'condition').data;
        const subConditions = page.data.find(content => content.name === 'subCondition').data;
        const sellers = page.data.find(content => content.name === 'seller').data;
        const locations = page.data.find(content => content.name === 'location').data;
        const imageSrcs = page.data.find(content => content.name === 'imageSrc').data;
        const prices = page.data.find(content => content.name === 'price').data;
        const descriptions = page.data.find(content => content.name === 'description').data
        const pubDatas = page.data.find(content => content.name === 'pubData').data
        const isbns = page.data.find(content => content.name === 'isbn').data

        for (let i = 0; i < titles.length; i++) {

            if (!book.abebooksStopwords.some(stopword => titles[i].toLowerCase().includes(stopword))
                && !book.abebooksStopwords.some(stopword => descriptions[i].toLowerCase().includes(stopword))
                && (pubDatas[i] ? !book.abebooksStopwords.some(stopword => pubDatas[i].toLowerCase().includes(stopword)) : true)) {

                if (!isbns[i] || isbns[i] == book.isbn13) {
                    item_ads.push({
                        source: 'abebooks',
                        title: titles[i],
                        link: links[i],
                        condition: conditions[i],
                        subCondition: subConditions[i],
                        seller: sellers[i],
                        location: locations[i],
                        imageSrc: imageSrcs[i],
                        itemPriceEUR: parseFloat(prices[i]) * rates['EUR'] / rates['GBP'],
                        itemPriceUSD: parseFloat(prices[i]) * rates['USD'] / rates['GBP'],
                        itemPriceGBP: parseFloat(prices[i]),
                        description: descriptions[i]
                    })
                }
            }

        }
    });

}

function ascendingPrice(a, b) {
    if (a.itemPriceEUR < b.itemPriceEUR) {
        return -1;
    }
    if (a.itemPriceEUR > b.itemPriceEUR) {
        return 1;
    }
    return 0;
}