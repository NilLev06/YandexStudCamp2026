// Current live rules, alarm comments and shared chart hover on the sensor page.
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const base = process.env.CHART_DEMO_URL || 'http://127.0.0.1:8010';
    const browser = await chromium.launch({headless: true, ...(process.env.PAIR_BROWSER_PATH ? {executablePath: process.env.PAIR_BROWSER_PATH} : {})});
    const context = await browser.newContext({viewport: {width: 1440, height: 1080}});
    const request = context.request;
    const sensorId = 'ui-overview-' + Date.now();
    try {
        const meta = await (await request.get(base + '/api/v1/meta')).json();
        assert.equal(meta.config.window, 3);
        assert.equal(meta.config.dynamics_window, 3);
        assert.equal(meta.config.confirm, 1);
        assert.equal(meta.config.recover, 2);
        assert.equal(meta.config.level_recover, 2);
        const started = await request.post(base + '/api/v1/simulations', {data: {scenario: 'drift', seed: 42, speed: 60, sensor_id: sensorId}});
        assert.equal(started.status(), 201);
        const simulation = await started.json();
        let summary;
        for (let attempt = 0; attempt < 60; attempt++) {
            summary = await (await request.get(base + '/api/v1/sensors/' + sensorId)).json();
            if (summary.open_incidents.length) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(summary.open_incidents.some((i) => i.type === 'quality'), JSON.stringify(summary));
        await request.delete(base + '/api/v1/simulations/' + simulation.id);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base + '/');
        const alarm = page.locator('.alarm-notice').filter({hasText: sensorId}).first();
        await alarm.waitFor({state: 'visible'});
        assert.ok((await alarm.innerText()).includes('Тревога'));
        assert.ok((await alarm.innerText()).includes('CUSUM'));
        await page.goto(base + '/sensors/' + sensorId);
        await page.locator('.alarm-notice').first().waitFor({state: 'visible'});
        assert.equal(await page.locator('.linked-chart').count(), 2);
        const chart = page.locator('.linked-chart').first();
        await chart.scrollIntoViewIfNeeded();
        const tick = chart.locator('.gcharts-x-axis__label').filter({hasText: /^01:00$/}).first();
        await tick.waitFor({state: 'visible'});
        await page.waitForTimeout(350);
        const tickBox = await tick.boundingBox();
        const box = await chart.boundingBox();
        await page.mouse.move(tickBox.x + tickBox.width / 2, box.y + box.height * 0.4);
        await page.locator('.linked-chart-readout').nth(1).waitFor({state: 'visible'});
        assert.deepEqual(await page.locator('.linked-chart-readout__time').allTextContents(), ['01:00', '01:00']);
        await page.goto(base + '/incidents');
        await page.getByRole('cell', {name: sensorId, exact: true}).first().waitFor();
        assert.ok((await page.locator('body').innerText()).includes('CUSUM'));
        assert.deepEqual(errors, []);
        console.log('Overview UI: live alarm with reason, current 3 s / 6 s policy, sensor details, linked hover and alarm list passed.');
    } finally {
        await request.delete(base + '/api/v1/sensors/' + sensorId);
        await browser.close();
    }
})().catch((error) => {console.error(error); process.exitCode = 1;});
