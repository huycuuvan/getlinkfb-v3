const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function scrapeUserProfile(psid, pageId, specificCookiePath, targetName) {
    const cookiesPath = specificCookiePath || process.env.FB_COOKIES_PATH || path.resolve(__dirname, '../cookies.json');
    // Mặc định chạy ẩn (headless) trên server, có thể chỉnh qua biến môi trường
    const isHeadless = process.env.HEADLESS !== 'false';

    const browser = await chromium.launch({
        headless: isHeadless,
        slowMo: isHeadless ? 0 : 1000, // Chạy chậm lại 1s mỗi thao tác nếu đang debug để dễ xem
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--font-render-hinting=none'
        ]
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 } // Đảm bảo đủ rộng để hiện Right Panel
    });

    // Load cookies if exist
    if (fs.existsSync(cookiesPath)) {
        const cookiesData = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
        // The file format provided is { url: "...", cookies: [...] }
        const cookies = cookiesData.cookies || cookiesData;

        // Ensure cookies match Playwright format (sometimes expirationDate needs to be converted or handled)
        const formattedCookies = cookies.map(c => {
            // Cân bằng giữa format của Playwright và format của Extension J2Team/Chrome
            let sameSite = 'Lax';
            const ss = (c.sameSite || '').toLowerCase();
            if (ss === 'no_restriction' || ss === 'none') sameSite = 'None';
            else if (ss === 'strict') sameSite = 'Strict';
            else if (ss === 'lax') sameSite = 'Lax';

            return {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                expires: c.expires || c.expirationDate || -1,
                httpOnly: c.httpOnly || false,
                secure: c.secure || true,
                sameSite: sameSite
            };
        });

        await context.addCookies(formattedCookies);
        console.log('Cookies loaded from cookies.json');
    }

    const page = await context.newPage();

    // Chuyển log từ trình duyệt về terminal để dễ debug
    page.on('console', msg => {
        if (msg.type() === 'log') console.log(`[Browser Log] ${msg.text()}`);
    });

    try {
        // Option 1: Meta Business Suite Inbox
        // Link format: https://business.facebook.com/latest/inbox/all/?asset_id=[PAGE_ID]&selected_item_id=[PSID]
        const inboxUrl = `https://business.facebook.com/latest/inbox/all/?asset_id=${pageId}&selected_item_id=${psid}`;
        console.log(`Navigating to Meta Business Suite: ${inboxUrl}`);

        // ===== BƯỚC 1: WARM-UP COOKIES (vô facebook.com trước) =====
        console.log(`[Scraper] Warming up cookies at facebook.com...`);
        await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        // ===== BƯỚC 2: VÀO INBOX =====
        console.log(`[Scraper] Navigating to Inbox: ${inboxUrl}`);
        await page.goto(inboxUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // ===== PHÁT HIỆN COOKIES HẾT HẠN =====
        await page.waitForTimeout(4000);
        let currentUrl = page.url();
        if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
            console.log(`[Scraper] ❌ COOKIES HẾT HẠN! Redirect to: ${currentUrl}`);
            return null;
        }

        // ===== KIỂM TRA UI & RELOAD (Phòng chống trang trắng/lag) =====
        const profileBtn = page.locator('a:has-text("Xem trang cá nhân"), a:has-text("View profile")').first();

        try {
            // Đợi 10 giây xem UI có hiện nút trích xuất không
            await profileBtn.waitFor({ state: 'visible', timeout: 10000 });
            console.log(`[Scraper] ✅ UI confirmed (View Profile button detected).`);
        } catch (e) {
            console.log(`[Scraper] ⚠️ UI not detected (White page or Lag). Forcing F5 Reload...`);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(8000); // Đợi Meta load lại
        }

        // Kiểm tra login sau reload
        currentUrl = page.url();
        if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
            console.log(`[Scraper] ❌ COOKIES HẾT HẠN (Phát hiện sau Reload)`);
            return null;
        }

        console.log(`[Scraper] ✅ UI ready. Performing direct extraction...`);

        // 1. DỌN DẸP NHANH (Bấm Esc và đóng bảng thông báo/cuộc gọi nếu có)
        try {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);

            // Tìm các nút Đóng, Từ chối (thường dùng cho cuộc gọi/thông báo đè)
            const obstructiveButtons = page.locator('button:has-text("Xong"), div[role="button"]:has-text("Xong"), button:has-text("Từ chối"), button:has-text("Đóng"), div[aria-label="Đóng"], div[aria-label="Close"]').first();
            if (await obstructiveButtons.isVisible()) {
                console.log(`[Scraper] 🚨 Clearing obstruction...`);
                await obstructiveButtons.click({ force: true });
                await page.waitForTimeout(1000);
            }
        } catch (e) { }

        // 2. TÌM VÀ CLICK "XEM TRANG CÁ NHÂN"
        let profileLink = "";
        try {
            const btnLink = page.locator('a:has-text("Xem trang cá nhân"), a:has-text("View profile")').first();

            // Đợi nút xuất hiện (Max 12s)
            await btnLink.waitFor({ state: 'visible', timeout: 12000 });

            // Khoanh đỏ rực rỡ
            await btnLink.evaluate(el => {
                el.style.outline = '10px solid red';
                el.style.boxShadow = '0 0 50px red';
                el.style.zIndex = '9999999';
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            await page.waitForTimeout(1000);

            // Lấy link - Dùng force: true để click bất chấp bị che khuất
            profileLink = await btnLink.getAttribute('href');
            await btnLink.click({ force: true }).catch(() => { });
            console.log(`[Scraper] 🎯 Captured: ${profileLink}`);

        } catch (e) {
            console.log(`[Scraper] ❌ Could not find View Profile link: ${e.message}`);
        }

        const userData = {
            name: targetName || "Khách hàng",
            profileLink: profileLink
        };

        if (userData.profileLink) {
            console.log(`[Scraper] DONE: ${userData.name} - ${userData.profileLink}`);

            // ===== DUY TRÌ PHIÊN AN TOÀN (Safe Session Persistence) =====
            // Tự động làm mới cookies với tần suất thấp để tránh bị FB quét
            try {
                const stats = fs.statSync(cookiesPath);
                const lastModified = stats.mtimeMs;
                const now = Date.now();
                const oneHour = 60 * 60 * 1000;

                if (now - lastModified > oneHour) {
                    const latestCookies = await context.cookies();
                    fs.writeFileSync(cookiesPath, JSON.stringify({ cookies: latestCookies }, null, 4), 'utf8');
                    console.log(`[Scraper] 🔄 Safe Session Refresh: Cookies updated for ${path.basename(cookiesPath)}`);
                }
            } catch (ce) {
                console.log(`[Scraper] Skip periodic cookie update: ${ce.message}`);
            }
        }

        await browser.close();
        return userData;

    } catch (error) {
        console.error('[Scraper] Error:', error.message);
        if (browser) await browser.close();
        return null;
    }
}

module.exports = { scrapeUserProfile };
