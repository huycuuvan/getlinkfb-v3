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

        // ===== PHÁT HIỆN TRANG TRẮNG & RELOAD =====
        // Kiểm tra xem có bất kỳ thẻ div/span nào có nội dung không
        let hasUI = await page.evaluate(() => {
            // Tìm các dấu hiệu của UI Meta (có icon, có menu, hoặc có nhiều hơn 50 link)
            const links = document.querySelectorAll('a').length;
            const svgs = document.querySelectorAll('svg').length;
            return links > 10 && svgs > 5;
        });

        if (!hasUI) {
            console.log(`[Scraper] ⚠️ Trang trắng hoặc chưa load UI. Đang F5 Reload lần 1...`);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(7000);
        }

        // Kiểm tra lại lần nữa sau reload
        hasUI = await page.evaluate(() => {
            return document.querySelectorAll('a').length > 10;
        });

        if (!hasUI) {
            console.log(`[Scraper] ⚠️ Vẫn chưa có UI. Thử điều hướng lại URL trực tiếp...`);
            await page.goto(inboxUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(10000);
        }

        // Kiểm tra login lần cuối
        currentUrl = page.url();
        if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
            console.log(`[Scraper] ❌ COOKIES HẾT HẠN (thất bại sau reload)`);
            return null;
        }

        console.log(`[Scraper] ✅ UI seems ready. Starting name verification...`);

        // ===== DỌN DẸP POP-UP (Để không che Link) =====
        try {
            const btns = page.locator('button:has-text("Xong"), button:has-text("OK"), button:has-text("Đã hiểu"), div[aria-label="Đóng"]');
            const count = await btns.count();
            for (let i = 0; i < count; i++) {
                if (await btns.nth(i).isVisible()) await btns.nth(i).click();
            }
        } catch (e) { }

        // ===== XÁC MINH & ĐỒNG BỘ (Sync UI with URL) =====
        if (targetName && targetName !== "Khách hàng") {
            try {
                console.log(`[Scraper] 🔍 Checking UI sync for: "${targetName}"...`);

                const check = async () => {
                    return await page.evaluate((expected) => {
                        const clean = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
                        return clean(document.body.innerText).includes(clean(expected));
                    }, targetName);
                };

                let isOk = await check();
                if (!isOk) {
                    console.log(`[Scraper] ⚠️ UI lag detected. Forcing F5 to sync with URL ID...`);
                    await page.reload({ waitUntil: 'domcontentloaded' });
                    await page.waitForTimeout(10000); // Đợi Meta load lại đúng người
                }
            } catch (e) {
                console.log(`[Scraper] Sync check skipped: ${e.message}`);
            }
        }

        // ===== TRÍCH XUẤT TÊN & LINK (Final Extraction) =====
        let profileLink = "";
        let extractedName = targetName || "";

        try {
            console.log(`[Scraper] Extracting profile link...`);
            const profileLocator = page.locator('a:has-text("Xem trang cá nhân"), a:has-text("View profile")').first();
            await profileLocator.waitFor({ state: 'visible', timeout: 15000 });
            profileLink = await profileLocator.getAttribute('href') || "";

            if (profileLink && !profileLink.startsWith('http')) {
                profileLink = 'https://www.facebook.com' + profileLink;
            }
        } catch (e) {
            console.log(`[Scraper] Link not found. Trying one last fallback...`);
            const fallbackLink = page.locator('a[href*="facebook.com/"]:not([href*="business.facebook.com"]):not([href*="/help/"])').first();
            profileLink = await fallbackLink.getAttribute('href').catch(() => "") || "";
        }

        // Nếu chưa có tên, cố gắng lấy từ UI
        if (!extractedName || extractedName === "Khách hàng") {
            try {
                const chatHeader = page.locator('div[role="main"] header span, div[role="main"] h2').first();
                const headerText = await chatHeader.innerText({ timeout: 5000 }).catch(() => "");
                if (headerText) {
                    extractedName = headerText.replace(/color:red;.*|Nếu ai đó bảo bạn.*|-webkit-text-stroke.*/gi, '').split('\n')[0].trim();
                }
            } catch (e) { }
        }

        // Cách 2: Tìm tên bên cạnh "Xem trang cá nhân" 
        if (!extractedName) {
            try {
                extractedName = await page.evaluate(() => {
                    const nameBlacklist = [
                        'Tìm hiểu thêm', 'Facebook', 'Xem trang cá nhân', 'Xem bình luận',
                        'Hộp thư', 'Kết nối', 'Messenger', 'Instagram', 'WhatsApp',
                        'Chi tiết liên hệ', 'Trang cá nhân', 'Hoạt động', 'Chia sẻ dữ liệu',
                        'Bổ sung', 'Thêm chi tiết', 'Khuyến dùng', 'Quản lý', 'Giai đoạn',
                        'Trạng thái', 'Tiếp nhận', 'Tạo đơn', 'Đánh dấu'
                    ];

                    // Tìm link "Xem trang cá nhân" rồi bò lên
                    const allLinks = Array.from(document.querySelectorAll('a'));
                    const vpLink = allLinks.find(a => (a.innerText || "").includes('Xem trang cá nhân') || (a.innerText || "").includes('View profile'));

                    if (vpLink) {
                        let curr = vpLink;
                        for (let i = 0; i < 8; i++) {
                            if (!curr) break;
                            const text = curr.innerText.trim().split('\n')[0].trim();
                            if (text.length > 2 && text.length < 50 && !nameBlacklist.some(bl => text.includes(bl))) {
                                return text;
                            }
                            curr = curr.parentElement;
                        }
                    }

                    // Fallback: Active item trong sidebar
                    const activeItem = document.querySelector('[aria-selected="true"]');
                    if (activeItem) {
                        const t = activeItem.innerText.trim().split('\n')[0].trim();
                        if (t.length > 2 && t.length < 50 && !nameBlacklist.some(bl => t.includes(bl))) return t;
                    }

                    return "";
                }) || "";
            } catch (e) { }
        }

        const userData = {
            name: extractedName || "Khách hàng",
            profileLink: profileLink
        };

        if (userData.profileLink) {
            console.log(`[Scraper] DONE: ${userData.name} - ${userData.profileLink}`);

            // ===== DUY TRÌ PHIÊN AN TOÀN (Safe Session Persistence) =====
            // Tự động làm mới cookies với tần suất thấp (tối thiểu 1 tiếng/lần)
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

            return userData;
        }

        console.log(`[Scraper] FAILED: Could not find data even after reload.`);
        return null;

    } catch (error) {
        console.error('[Scraper] Error:', error.message);
        return null;
    } finally {
        await browser.close();
    }
}

module.exports = {
    scrapeUserProfile
};
