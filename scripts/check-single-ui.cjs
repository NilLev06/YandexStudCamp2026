// Optional browser QA: build frontend and run gateway on 8010 first.
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.PAIR_BROWSER_PATH ? {executablePath: process.env.PAIR_BROWSER_PATH} : {})});
    try {
        const page = await browser.newPage({viewport: {width: 1440, height: 1080}});
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(process.env.SINGLE_DEMO_URL || 'http://127.0.0.1:8010/single');
        await page.getByRole('button', {name: 'Рост случайного шума', exact: true}).waitFor();
        const choose = async (label) => {
            const button = page.getByRole('button', {name: label, exact: true});
            await Promise.all([page.waitForResponse((r) => r.url().endsWith('/single-replays') && r.status() === 200), button.click()]);
            await page.waitForFunction((label) => [...document.querySelectorAll('button')].some((b) => b.textContent === label && b.getAttribute('aria-pressed') === 'true' && !b.disabled), label);
        };
        const during = () => page.getByRole('button', {name: '01:36 · Во время нарушения', exact: true}).click();
        const after = () => page.getByRole('button', {name: '03:00 · После восстановления', exact: true}).click();
        for (const [scenario, alarm] of [
            ['Рост случайного шума', 'Повышенный разброс'],
            ['Периодическая помеха', 'Повышенный разброс'],
            ['Плавное снижение и восстановление', 'Отклонение уровня'],
            ['Плавный рост и восстановление', 'Отклонение уровня'],
            ['Ступенчатое смещение', 'Отклонение уровня'],
            ['Залипание', 'Подозрение на залипание'],
            ['Насыщение диапазона', 'Насыщение диапазона'],
            ['Повторные невозможные скачки', 'Высокая доля непригодных измерений'],
            ['Непригодные измерения', 'Высокая доля непригодных измерений'],
            ['Снижение частоты', 'Снижена частота измерений'],
            ['Задержка доставки', 'Высокая доля опоздавших измерений'],
            ['Потеря данных и старая пачка', 'Нет свежих пригодных данных'],
        ]) {
            await choose(scenario);
            await during();
            if (scenario === 'Рост случайного шума') {
                // With one 3-second window, random noise may recover at 96 s.
                await page.getByRole('slider', {name: 'Время сценария одного датчика'}).fill('63');
            }
            await page.locator('.alarm-notice').filter({hasText: alarm}).waitFor();
            await after();
            await page.getByText('Подтверждённых тревог нет', {exact: true}).waitFor();
            assert.ok((await page.getByText('Восстановление · ' + alarm, {exact: true}).count()) >= 1);
        }
        for (const scenario of ['Нормальная работа', 'Одиночный невозможный скачок', 'Штатная смена режима']) {
            await choose(scenario);
            await page.getByRole('button', {name: 'Итог записи', exact: true}).click();
            await page.getByText('Подтверждённых тревог нет', {exact: true}).waitFor();
            assert.equal(await page.locator('.alarm-notice').count(), 0);
        }
        await choose('Потеря данных и старая пачка');
        await page.getByRole('button', {name: '01:50 · Проверка доставки', exact: true}).click();
        await page.locator('.alarm-notice').filter({hasText: 'Возраст последнего пригодного измерения'}).waitFor();
        // The received old batch must not close the freshness incident.
        assert.ok((await page.locator('.stat').nth(1).innerText()).includes('После получения сообщения: 0,0 с'));
        await page.getByRole('button', {name: 'Сначала', exact: true}).click();
        await page.getByRole('button', {name: 'Запустить показ', exact: true}).click();
        await page.waitForFunction(() => Number(document.querySelector('input[type="range"]').value) >= 2);
        await page.getByRole('button', {name: 'Пауза', exact: true}).click();
        const paused = await page.locator('input[type="range"]').inputValue();
        await page.waitForTimeout(250);
        assert.equal(await page.locator('input[type="range"]').inputValue(), paused);
        await choose('Рост случайного шума');
        await during();
        if (process.env.SINGLE_SCREENSHOT) await page.screenshot({path: process.env.SINGLE_SCREENSHOT});
        await page.setViewportSize({width: 390, height: 844});
        await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth, undefined, {timeout: 5000});
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow at 390px');
        if (process.env.SINGLE_MOBILE_SCREENSHOT) await page.screenshot({path: process.env.SINGLE_MOBILE_SCREENSHOT, fullPage: true});
        assert.deepEqual(errors, []);
        console.log('Single UI: 15 scenarios, alarm explanations, recovery, old batch, playback/pause, mobile and no browser errors passed.');
    } finally {await browser.close();}
})().catch((error) => {console.error(error); process.exitCode = 1;});
