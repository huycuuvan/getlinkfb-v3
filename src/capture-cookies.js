require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');

async function captureCookies() {
    console.log('Opening browser for manual login...');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('https://www.facebook.com/login');

    console.log('Please login manually in the browser window.');
    console.log('Once logged in and you are at the homepage, the script will save cookies and close.');

    // Chờ cho đến khi đăng nhập thành công
    // Dùng selector của thanh tìm kiếm hoặc icon Menu vì nó xuất hiện ở mọi ngôn ngữ
    console.log('Waiting for homepage to load...');
    await page.waitForSelector('input[placeholder*="Tìm kiếm"], input[placeholder*="Search"], div[role="navigation"], div[aria-label*="Facebook"]', { timeout: 0 });

    const cookies = await context.cookies();
    fs.writeFileSync(process.env.FB_COOKIES_PATH || './cookies.json', JSON.stringify({
        url: 'https://www.facebook.com',
        cookies: cookies
    }, null, 2));

    console.log('Cookies saved successfully to cookies.json');
    await browser.close();
}

captureCookies().catch(err => console.error(err));
