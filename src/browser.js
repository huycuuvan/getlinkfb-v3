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

    // ===== GIẢ LẬP THIẾT BỊ CỐ ĐỊNH (Persistent Fingerprinting) =====
    // Chọn User-Agent cố định dựa trên tên file cookie để FB không nghi ngờ đổi thiết bị
    const userAgents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ];
    // Dùng mã băm đơn giản từ path để chọn UA cố định cho mỗi file
    const pathHash = cookiesPath.split('').reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a }, 0);
    const selectedUA = userAgents[Math.abs(pathHash) % userAgents.length];

    const viewports = [
        { width: 1920, height: 1080 },
        { width: 1536, height: 864 }
    ];
    const selectedVP = viewports[Math.abs(pathHash) % viewports.length];

    const context = await browser.newContext({
        userAgent: selectedUA,
        viewport: selectedVP,
        locale: 'vi-VN',
        timezoneId: 'Asia/Ho_Chi_Minh'
    });

    console.log(`[Browser] Using Persistent UA for ${path.basename(cookiesPath)}: ${selectedUA.substring(0, 50)}...`);

    // Tắt timeout mặc định để chạy ổn định hơn
    context.setDefaultTimeout(60000);
    const page = await context.newPage();

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
            return null; // Sẽ nhảy vào finally để đóng browser
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
            return null; // Sẽ nhảy vào finally để đóng browser
        }

        console.log(`[Scraper] ✅ UI ready. Performing direct extraction...`);

        // 1. DỌN DẸP NHANH (Bấm Esc và chỉ đóng các Hộp thoại thực sự che mắt)
        try {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);

            // Chỉ tìm nút trong khung Dialog/Modal để tránh click nhầm nút hệ thống bên ngoài
            const dialogClose = page.locator('div[role="dialog"] button:has-text("Xong"), div[role="dialog"] [role="button"]:has-text("Xong"), div[role="dialog"] button:has-text("Đóng"), div[role="dialog"] [aria-label="Đóng"]').first();

            if (await dialogClose.isVisible()) {
                console.log(`[Scraper] 🚨 Closing pop-up dialog...`);
                await dialogClose.click({ force: true });
                await page.waitForTimeout(1000);
            }
        } catch (e) { }

        // 2. XÁC MINH UI (Đảm bảo Meta đã chuyển sang đúng khách hàng)
        let profileLink = "";
        const btnSelector = 'a:has-text("Xem trang cá nhân"), a:has-text("View profile")';

        // Hàm lấy tên hiện tại trên UI
        const getCurrentUIName = async () => {
            const headings = await page.locator('h1, h2, h3, [role="heading"], div[role="main"] span[style*="font-weight: bold"]').allTextContents();
            return headings.join(' ').toLowerCase().trim();
        };

        try {
            const normalizedTarget = (targetName || "").toLowerCase().trim();
            console.log(`[Scraper] 🔍 Waiting for UI to sync with: "${targetName}"...`);

            // Đợi đến khi tên khớp (Active Waiting - tối đa 20s)
            let isMatch = false;
            for (let i = 0; i < 10; i++) {
                const uiName = await getCurrentUIName();
                if (normalizedTarget === "" || uiName.includes(normalizedTarget)) {
                    isMatch = true;
                    break;
                }

                // Nếu không khớp, thử click vào dòng khách hàng ở Sidebar để nhắc Meta
                if (i === 2 || i === 5) {
                    console.log(`[Scraper] 🔄 UI still Stale (Attempt ${i}). Re-clicking sidebar...`);
                    const sidebarItem = page.locator(`div[role="grid"] [role="row"]:has-text("${targetName}")`).first();
                    if (await sidebarItem.count() > 0) await sidebarItem.click({ force: true });
                }
                await page.waitForTimeout(2000);
            }

            if (!isMatch) {
                console.error(`[Scraper] ❌ UI Name mismatch timed out. Target: "${targetName}"`);
                return null;
            }

            // Đảm bảo khung thông tin bên phải ĐÃ MỞ (Nút 'i' chi tiết)
            const detailToggle = page.locator('div[aria-label="Thông tin chi tiết"], div[aria-label="Conversation details"]').first();
            if (await detailToggle.isVisible()) {
                const isExpanded = await page.locator('div[role="complementary"]').isVisible();
                if (!isExpanded) {
                    console.log(`[Scraper] 🔓 Opening Detail Pane...`);
                    await detailToggle.click();
                    await page.waitForTimeout(2000);
                }
            }

            // TÌM VÀ TRÍCH XUẤT LINK
            const btnLink = page.locator(btnSelector).first();

            if (await btnLink.isVisible({ timeout: 15000 })) {
                // Highlight màu XANH để bạn thấy bot đã tin tưởng UI này
                await btnLink.evaluate(el => {
                    el.style.outline = '10px solid #00FF00';
                    el.style.boxShadow = '0 0 50px #00FF00';
                    el.style.zIndex = '9999999';
                });
                await page.waitForTimeout(1000);

                const extractedLink = await btnLink.getAttribute('href');

                // KIỂM TRA LINK HỢP LỆ (Phải là link facebook.com và không chứa path Inbox)
                if (extractedLink && extractedLink.includes('facebook.com') && !extractedLink.includes('/latest/inbox/')) {
                    profileLink = extractedLink;
                    console.log(`[Scraper] 🎯 Captured valid link for "${targetName}": ${profileLink}`);
                } else {
                    console.error(`[Scraper] ❌ Extracted link is invalid or still Meta-internal: ${extractedLink}`);
                }
            } else {
                console.log(`[Scraper] ⚠️ "View profile" button not found even after UI sync.`);
            }

        } catch (e) {
            console.log(`[Scraper] ❌ Error during extraction: ${e.message}`);
        }

        const userData = {
            name: targetName || "Khách hàng",
            profileLink: profileLink
        };

        if (userData.profileLink) {
            console.log(`[Scraper] DONE: ${userData.name} - ${userData.profileLink}`);

            // ===== DUY TRÌ PHIÊN AN TOÀN (Safe Session Persistence) =====
            try {
                const stats = fs.statSync(cookiesPath);
                const lastModified = stats.mtimeMs;
                const now = Date.now();
                const oneHour = 60 * 60 * 1000;

                if (now - lastModified > oneHour) {
                    const latestCookies = await context.cookies();
                    // PHÒNG VỆ: Chỉ lưu nếu có data thực sự (Tránh xóa trắng file khi logout)
                    if (latestCookies && latestCookies.length > 10) {
                        fs.writeFileSync(cookiesPath, JSON.stringify({ cookies: latestCookies }, null, 4), 'utf8');
                        console.log(`[Scraper] 🔄 Safe Session Refresh: Cookies updated for ${path.basename(cookiesPath)}`);
                    } else {
                        console.log(`[Scraper] ⚠️ Skip periodic update: Fresh cookies data is suspicious (too few).`);
                    }
                }
            } catch (ce) {
                console.log(`[Scraper] Skip periodic cookie update: ${ce.message}`);
            }
        }

        return userData;

    } catch (error) {
        console.error('[Scraper] Error:', error.message);
        return null;
    } finally {
        if (browser) {
            await browser.close();
            console.log(`[Scraper] Browser closed properly.`);
        }
    }
}

module.exports = { scrapeUserProfile };
