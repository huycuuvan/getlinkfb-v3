const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');


async function scrapeUserProfile(psid, pageId, specificCookiePath, targetName, accData = null, threadId = null) {
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
        // TRANG CÁ NHÂN SỬ DỤNG ThreadId (nếu có) hoặc PSID
        const targetId = threadId || psid;
        const inboxUrl = `https://business.facebook.com/latest/inbox/all/?asset_id=${pageId}&selected_item_id=${targetId}`;
        console.log(`Navigating to Meta Business Suite: ${inboxUrl} (Using ${threadId ? 'ThreadId' : 'PSID'})`);

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
            console.log(`[Scraper] ❌ COOKIES EXPIRED for ${accData?.name || 'Account'}`);
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

        // Hàm lấy tên hiện tại trên UI và chuẩn hóa
        const getCurrentUIName = async () => {
            // Quét rộng hơn: Tiêu đề, các thẻ bôi đậm và cả vùng header của khung chat
            const names = await page.locator('h1, h2, h3, [role="heading"], [role="main"] header span, div[role="complementary"] div[role="button"] span').allTextContents();
            return names.join(' ').normalize('NFC').toLowerCase().trim();
        };

        const removeVNDiacritics = (str) => {
            return str.normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
        };

        const checkMatchFuzzy = (uiText, target) => {
            if (!target || target === "" || target === "Khách hàng") return true;

            const cleanUI = removeVNDiacritics(uiText.toLowerCase());
            const cleanTarget = removeVNDiacritics(target.toLowerCase());

            // 1. Khớp thẳng
            if (cleanUI.includes(cleanTarget)) return true;

            // 2. Khớp từng từ (cho phép đảo thứ tự Họ Tên)
            const targetWords = cleanTarget.split(/\s+/).filter(w => w.length > 2); // Chỉ tính từ > 2 ký tự
            if (targetWords.length === 0) return true;

            const allWordsMatch = targetWords.every(word => cleanUI.includes(word));
            return allWordsMatch;
        };

        try {
            const rawTarget = targetName || "";
            console.log(`[Scraper] 🔍 Syncing UI for: "${rawTarget}"...`);

            let isMatch = false;
            for (let i = 0; i < 10; i++) {
                const uiNameRaw = await getCurrentUIName();

                if (checkMatchFuzzy(uiNameRaw, rawTarget)) {
                    isMatch = true;
                    console.log(`[Scraper] 🎯 UI Match confirmed for: ${uiNameRaw.substring(0, 30)}`);
                    break;
                } else if (i === 0) {
                    console.log(`[Scraper] ⚠️ UI Mismatch (Found: "${uiNameRaw.substring(0, 50)}")`);
                }

                // NẾU CỐ GẮNG BẰNG URL VẪN SAI ID -> DÙNG SEARCH BOX (CỰC KỲ QUAN TRỌNG)
                if (i === 1) {
                    console.log(`[Scraper] 🔍 Navigation mismatch. Attempting Search Fallback for "${rawTarget}"...`);
                    try {
                        const searchInput = page.locator('input[placeholder*="Tìm kiếm"], input[placeholder*="Search"]').first();
                        if (await searchInput.isVisible()) {
                            await searchInput.click();
                            // Xóa sạch ô search cũ (nếu có)
                            await page.keyboard.press('Control+A');
                            await page.keyboard.press('Backspace');
                            await page.waitForTimeout(500);

                            await page.keyboard.type(rawTarget, { delay: 100 });
                            await page.waitForTimeout(3000); // Đợi kết quả hiện lên

                            // Click vào kết quả đầu tiên (thường là list item chứa tên)
                            // Sử dụng selector linh hoạt hơn để bắt được kết quả search
                            const firstResult = page.locator('[role="listbox"] [role="option"], [role="grid"] [role="row"], div[role="button"]:has-text("' + rawTarget.split(' ').pop() + '")').first();

                            if (await firstResult.isVisible()) {
                                console.log(`[Scraper] 🎯 Search result found. Clicking...`);
                                await firstResult.click();
                                await page.waitForTimeout(4000);
                            } else {
                                console.log(`[Scraper] ⚠️ Search result for "${rawTarget}" not visible.`);
                                // Thử click đại vào cái gì đó trong vùng search kết quả nếu không thấy ID cụ thể
                                const anyResult = page.locator('div[role="main"] div[role="button"]').filter({ hasText: rawTarget.split(' ').pop() }).first();
                                if (await anyResult.isVisible()) {
                                    await anyResult.click();
                                    await page.waitForTimeout(4000);
                                }
                            }
                        }
                    } catch (se) {
                        console.log(`[Scraper] Search Fallback error: ${se.message}`);
                    }
                }

                // Nếu không khớp, thử click vào dòng khách hàng ở Sidebar
                if (i === 3 || i === 6) {
                    console.log(`[Scraper] 🔄 UI still Stale (Attempt ${i}). Re-clicking sidebar...`);
                    // Tìm theo từ cuối cùng của tên (thử vận may với Tên chính)
                    const nameParts = rawTarget.split(' ');
                    const searchName = nameParts[nameParts.length - 1];
                    const sidebarItem = page.locator(`div[role="grid"] [role="row"]:has-text("${searchName}")`).first();

                    if (await sidebarItem.count() > 0) {
                        await sidebarItem.click({ force: true });
                    }
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
