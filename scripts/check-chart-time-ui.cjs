// Regression: at an axis tick, tooltip time must equal that tick's label.
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.PAIR_BROWSER_PATH ? {executablePath: process.env.PAIR_BROWSER_PATH} : {})});
    try {
        for (const timezoneId of ['UTC', 'Europe/Moscow', 'Asia/Kathmandu']) {
            const context = await browser.newContext({viewport: {width: 1440, height: 1080}, timezoneId});
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            for (const route of ['single', 'pair']) {
                await page.goto((process.env.CHART_DEMO_URL || 'http://127.0.0.1:8010') + '/' + route);
                await page.getByRole('button', {name: 'Итог записи', exact: true}).click();
                for (const chart of await page.locator('.replay-chart').all()) {
                    await chart.scrollIntoViewIfNeeded();
                    const label = chart.locator('.gcharts-x-axis__label').filter({hasText: /^01:00$/}).first();
                    await label.waitFor({state: 'visible', timeout: 5000});
                    // Wait for the chart's resize/axis animation to settle.
                    await page.waitForTimeout(350);
                    const tick = await label.boundingBox();
                    const box = await chart.boundingBox();
                    await page.mouse.move(tick.x + tick.width / 2, box.y + box.height * 0.45);
                    const tooltips = page.locator('.linked-chart-readout__time');
                    await tooltips.first().waitFor({state: 'visible'});
                    assert.equal(await tooltips.count(), 2, 'Both charts must show values');
                    assert.deepEqual(await tooltips.allTextContents(), ['01:00', '01:00'], `${route}, ${timezoneId}: readouts differ from axis tick`);
                    assert.equal(await page.locator('.linked-chart svg [stroke="#8e8c99"][stroke-dasharray]').count(), 2, 'Both charts must show dashed cursors');
                    await page.locator('.linked-chart-readout').nth(1).waitFor({state: 'visible'});
                    const geometry = await page.locator('.linked-chart').evaluateAll((charts) => charts.map((chart) => {
                        const line = chart.querySelector('svg [stroke="#8e8c99"]').getBoundingClientRect();
                        const card = chart.querySelector('.linked-chart-readout').getBoundingClientRect();
                        const anchor = chart.querySelector('.linked-chart-anchor').getBoundingClientRect();
                        const x = anchor.x + anchor.width / 2, y = anchor.y + anchor.height / 2;
                        const time = Number(chart.querySelector('.linked-chart-readout').dataset.time) * 1000;
                        const path = [...chart.querySelectorAll('svg path')].find((p) => p.__data__?.points?.some((point) => point.data?.x === time && point.y !== null));
                        const sample = path.__data__.points.find((point) => point.data?.x === time);
                        const projected = new DOMPoint(sample.x, sample.y).matrixTransform(path.getScreenCTM());
                        return {lineX: line.x, anchorX: x, pointDistance: Math.hypot(x - projected.x, y - projected.y), distance: Math.hypot(Math.max(card.left - x, x - card.right, 0), Math.max(card.top - y, y - card.bottom, 0))};
                    }));
                    assert.ok(Math.abs(geometry[0].lineX - geometry[1].lineX) < 1, 'Cursors must align vertically');
                    for (const item of geometry) {
                        assert.ok(Math.abs(item.lineX - item.anchorX) < 1, 'Marker must be on cursor');
                        assert.ok(item.pointDistance < 1, 'Marker must match the actual sample, including during hover color changes');
                        assert.ok(item.distance < 26, 'Readout must stay beside its point');
                    }
                    await page.mouse.move(0, 0);
                    await page.waitForFunction(() => document.querySelectorAll('.linked-chart-readout').length === 0, undefined, {timeout: 5000}).catch(async (e) => {
                        console.error(route, timezoneId, await page.evaluate(() => ({readouts: [...document.querySelectorAll('.linked-chart-readout__time')].map(e => e.textContent), hovered: document.querySelectorAll('.linked-chart:hover').length})));
                        throw e;
                    });
                }
            }
            assert.deepEqual(errors, []);
            await context.close();
        }
        console.log('Linked charts: both hover directions, point-anchored readouts, aligned dashed cursors and clearing passed in UTC, Moscow and Kathmandu.');
    } finally {await browser.close();}
})().catch((error) => {console.error(error); process.exitCode = 1;});
