const Apify = require('apify');
const urlParse = require('url-parse');

const { makeUrlFull, getIdFromUrl, checkMaxItemsInput, buildStartUrl } = require('./utils');

const { log } = Apify.utils;

Apify.main(async () => {
    const input = await Apify.getInput() || {};
    const {
        country,
        maxConcurrency,
        position,
        location,
        startUrls,
        extendOutputFunction,
        proxyConfiguration = {
            useApifyProxy: true
        },
        saveOnlyUniqueItems = true,
    } = input;

    let { maxItems } = input;
    maxItems = checkMaxItemsInput(maxItems);
    
    // COUNTER OF ITEMS TO SAVE
    let itemsCounter = 0;
    let currentPageNumber = 1;

    // EXTENDED FUNCTION FROM INPUT
    let extendOutputFunctionValid;
    if (extendOutputFunction) {
        try {
            extendOutputFunctionValid = eval(extendOutputFunction);
        } catch (e) {
            throw new Error(`extendOutputFunction is not a valid JavaScript! Error: ${e}`);
        }
        if (typeof extendOutputFunctionValid !== 'function') {
            throw new Error('extendOutputFunction is not a function! Please fix it or use just default output!');
        }
    }

    const requestQueue = await Apify.openRequestQueue();
    await buildStartUrl({ requestQueue, position, location, country, startUrls, currentPageNumber });

    const sdkProxyConfiguration = await Apify.createProxyConfiguration(proxyConfiguration);
    if (Apify.getEnv().isAtHome && !sdkProxyConfiguration) {
        throw 'You must use Apify Proxy or custom proxies to run this scraper on the platform!';
    }

    log.info('Starting crawler...');
    const crawler = new Apify.CheerioCrawler({
        requestQueue,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 50,
            sessionOptions: {
                maxUsageCount: 50,
            },
        },
        maxConcurrency,
        maxRequestRetries: 10,
        proxyConfiguration: sdkProxyConfiguration,
        handlePageFunction: async ({ $, request, session, response }) => {
            log.info(`Label(Page type): ${request.userData.label} || URL: ${request.url}`);

            if (![200, 404].includes(response.statusCode)) {
                session.retire();
                request.retryCount--;
                throw new Error(`We got blocked by target on ${request.url}`);
            }

            switch (request.userData.label) {
                case 'START':
                case 'LIST':
                    const noResultsFlag = $('.no_results').length > 0;

                    if (noResultsFlag) {
                        log.info('URL doesn\'t have result');
                        return;
                    }

                    let currentPageNumber = request.userData.currentPageNumber;

                    const urlDomainBase = (new URL(request.url)).hostname;

                    const details = [];
                    $('.tapItem a[data-jk]').each((index, element) => {
                        const itemId = $(element).attr('data-jk');
                        const itemUrl = `https://${urlDomainBase}${$(element).attr('href')}`;
                        details.push({
                            url: itemUrl,
                            uniqueKey: saveOnlyUniqueItems ? itemId : `${itemUrl}-${currentPageNumber}`,
                            userData: {
                                label: 'DETAIL'
                            }
                        });
                    });

                    for (const req of details) {
                        // Check the item count before adding to the request queue
                        if (!(maxItems && itemsCounter >= maxItems) && itemsCounter < 990 && !req.url.includes('undefined')) {
                            await requestQueue.addRequest(req, { forefront: true });
                        }
                    }

                    // Getting total number of items shown on the site.
                    let maxItemsOnSite;
                    try {
                        maxItemsOnSite = $('#searchCountPages')
                            .html()
                            .trim()
                            .split(' ')[3]
                            ? Number($('#searchCountPages')
                                    .html()
                                    .trim()
                                    .split(' ')[3]
                                    .replace(/[^0-9]/g, ''))
                            : Number($('#searchCountPages')
                                    .html()
                                    .trim()
                                    .split(' ')[0]
                                    .replace(/[^0-9]/g, ''));
                    } catch (error) {
                        throw ('Page didn\'t load properly. Retrying...');
                    }

                    currentPageNumber++;
                    const hasNextPage = $(`a[aria-label="${currentPageNumber}"]`).length > 0;

                    // Avoid enqueueing next page if max items reached
                    if (!(maxItems && itemsCounter >= maxItems) && itemsCounter < 990 && itemsCounter < maxItemsOnSite && hasNextPage) {
                        const nextPage = $(`a[aria-label="${currentPageNumber}"]`).attr('href');
                        const urlParsed = urlParse(request.url);

                        for (let i = 0; i < 5; i++) {
                            const nextPageUrl = {
                                url: makeUrlFull(nextPage, urlParsed),
                                uniqueKey: `${i}--${makeUrlFull(nextPage, urlParsed)}`,
                                userData: {
                                    label: 'LIST',
                                    currentPageNumber
                                }
                            };
                            await requestQueue.addRequest(nextPageUrl);
                        }
                    }
                    break;
                case 'DETAIL':
                    if (response.statusCode === 404) {
                        log.warning(`Got 404 status code. Job offer no longer available. Skipping. | URL: ${request.url}`);
                        return;
                    } else if ($('meta[id="indeed-share-url"]').length === 0) {
                        log.warning(`Invalid job offer page. Skipping. | URL: ${request.url}`);
                        return;
                    }

                    if (!(maxItems && itemsCounter >= maxItems)) {
                        let result = {
                            positionName: $('.jobsearch-JobInfoHeader-title').text().trim(),
                            salary: $('#salaryInfoAndJobType .attribute_snippet').text().trim(),
                            jobType: $('#salaryInfoAndJobType .jobsearch-JobType').text().trim() || null,
                            company: $('meta[property="og:description"]').attr('content'),
                            location: $('.jobsearch-JobInfoHeader-subtitle > div').eq(1).text().trim(),
                            rating: $('meta[itemprop="ratingValue"]').attr('content') ? Number($('meta[itemprop="ratingValue"]').attr('content')) : null,
                            reviewsCount: $('meta[itemprop="ratingCount"]').attr('content') ? Number($('meta[itemprop="ratingCount"]').attr('content')) : null,
                            url: request.url,
                            id: getIdFromUrl($('meta[id="indeed-share-url"]').attr('content')),
                            postedAt: $('.jobsearch-JobMetadataFooter>div').not('[class]').text().trim(),
                            scrapedAt: new Date().toISOString(),
                            description: $('div[id="jobDescriptionText"]').text(),
                            externalApplyLink: $('#applyButtonLinkContainer a')[0] ? $($('#applyButtonLinkContainer a')[0]).attr('href') : null,
                        };

                        // Logging the output data for debugging
                        log.info(`Salary: ${result.salary}`);
                        log.info(`Job Type: ${result.jobType}`);
                        log.info(`Location: ${result.location}`);
                        log.info(`Rating: ${result.rating}`);
                        log.info(`Reviews Count: ${result.reviewsCount}`);

                        if (extendOutputFunction) {
                            try {
                                const userResult = await extendOutputFunctionValid($);
                                result = Object.assign(result, userResult);
                            } catch (e) {
                                log.info('Error in the extendedOutputFunction run', e);
                            }
                        }

                        await Apify.pushData(result);
                        itemsCounter += 1;

                        // Check to stop processing after reaching max items
                        if (itemsCounter >= maxItems) {
                            log.info(`Reached maximum items limit of ${maxItems}. Stopping the crawler.`);
                            await crawler.autostop(); // This will stop the crawler if it has reached the maximum item limit.
                        }
                    }
                    break;
                default:
                    throw new Error(`Unknown label: ${request.userData.label}`);
            }
        }
    });

    await crawler.run();
    log.info('Done.');
});
