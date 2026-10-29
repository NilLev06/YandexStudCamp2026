// Optional browser QA. Run after building frontend and starting gateway.
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.PAIR_BROWSER_PATH ? {executablePath: process.env.PAIR_BROWSER_PATH} : {})});
    try {
        const page = await browser.newPage({viewport: {width: 1440, height: 1080}});
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const choose = async (label) => {
            await Promise.all([page.waitForResponse((r) => r.url().endsWith('/pair-replays') && r.status() === 200),
                page.getByRole('button', {name: label, exact: true}).click()]);
            await page.waitForFunction((label) => [...document.querySelectorAll('button')].some((b) => b.textContent === label && b.getAttribute('aria-pressed') === 'true' && !b.disabled), label);
        };
        await page.goto(process.env.PAIR_DEMO_URL || 'http://127.0.0.1:8010/pair');
        await page.getByRole('button', {name: '01:30 · Расхождение'}).click();
        assert.equal(await page.locator('.alarm-notice').filter({hasText: 'Показания A и B расходятся'}).count(), 1);
        await page.getByRole('button', {name: '02:25 · Восстановление'}).click();
        assert.equal(await page.getByText('Показания согласованы', {exact: true}).count(), 1);
        await choose('Нормальная работа');
        await page.getByRole('button', {name: 'Итог записи'}).click();
        assert.equal(await page.getByText('Показания согласованы', {exact: true}).count(), 1);
        assert.equal(await page.locator('.alarm-notice').filter({hasText: 'Показания A и B расходятся'}).count(), 0);
        await choose('Одиночный выброс');
        await page.getByRole('button', {name: '01:20 · Выброс'}).click();
        assert.equal(await page.getByText('Подозрение на расхождение', {exact: true}).count(), 1);
        await page.getByRole('button', {name: '01:30 · После выброса'}).click();
        assert.equal(await page.getByText('Показания согласованы', {exact: true}).count(), 1);
        await choose('Пропуск и старая пачка');
        await page.getByRole('button', {name: '01:40 · Старая пачка'}).click();
        assert.equal(await page.locator('.alarm-notice').filter({hasText: 'Сравнение недоступно'}).count(), 1);
        await page.getByRole('button', {name: '02:00 · Свежие пары'}).click();
        assert.equal(await page.getByText('Показания согласованы', {exact: true}).count(), 1);
        await page.getByRole('button', {name: 'Сначала', exact: true}).click();
        await page.getByRole('button', {name: 'Запустить показ', exact: true}).click();
        await page.waitForFunction(() => Number(document.querySelector('input[type="range"]').value) >= 2);
        await page.getByRole('button', {name: 'Пауза', exact: true}).click();
        const paused = await page.locator('input[type="range"]').inputValue();
        await page.waitForTimeout(250);
        assert.equal(await page.locator('input[type="range"]').inputValue(), paused);
        await page.setViewportSize({width: 390, height: 844});
        await choose('Дрейф одного датчика');
        await page.getByRole('button', {name: '01:30 · Расхождение'}).click();
        await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth, undefined, {timeout: 5000});
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Horizontal overflow at 390px');
        if (process.env.PAIR_SCREENSHOT) await page.screenshot({path: process.env.PAIR_SCREENSHOT, fullPage: true});
        assert.deepEqual(errors, []);
        console.log('Pair UI: four scenarios, recovery, old messages, playback/pause and mobile layout passed.');
    } finally {
        await browser.close();
    }
})().catch((error) => {console.error(error); process.exitCode = 1;});
