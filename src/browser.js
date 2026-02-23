const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function scrapeUserProfile(psid, pageId) {
    const cookiesPath = process.env.FB_COOKIES_PATH || './cookies.json';
    const isHeadless = process.env.HEADLESS !== 'false'; // Mặc định là true trên VPS

    const browser = await chromium.launch({
        headless: isHeadless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Quan trọng cho VPS ít RAM
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process' // Giúp ổn định hơn trên Linux
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

        // Tăng timeout và dùng 'load' thay vì 'networkidle' vì Meta load rất nhiều background tasks
        await page.goto(inboxUrl, { waitUntil: 'load', timeout: 90000 });

        async function waitForInboxUI(isRetry = false) {
            console.log(isRetry ? 'Retrying: Waiting for inbox UI...' : 'Waiting for inbox UI...');

            const start = Date.now();
            while (Date.now() - start < 45000) {
                const state = await page.evaluate(() => {
                    const url = window.location.href;
                    // Các dấu hiệu nhận biết Hộp thư (Dùng nhiều selector dự phòng)
                    const hasInboxDetails = !!document.querySelector('div[role="complementary"], div[data-testid="inbox-details-pane"], div[data-testid="contact-details-card"]');
                    const hasThread = !!document.querySelector('div[role="main"] [role="presentation"], div[aria-label*="Tin nhắn"], div[aria-label*="Messages"]');
                    const hasList = !!document.querySelector('div[aria-label*="Conversations"], div[aria-label*="Cuộc trò chuyện"], [role="grid"]');

                    const isUrlInbox = url.includes('/inbox/') || url.includes('selected_item_id=');
                    const inbox = (isUrlInbox && (hasInboxDetails || hasThread || hasList)) || !!document.querySelector('.fb-inbox-details');

                    const home = !!document.querySelector('a[href*="/latest/home/"], .fb-home-details');
                    const hasSidebar = !!document.querySelector('a[href*="/latest/inbox/"], [role="navigation"]');
                    return { inbox, home, hasSidebar, url };
                });

                console.log(`[Scraper] URL: ${state.url} | Inbox: ${state.inbox} | Home: ${state.home} | Sidebar: ${state.hasSidebar}`);

                if (state.inbox) {
                    console.log('Inbox UI detected.');
                    return true;
                }

                // Nếu thấy Sidebar mà chưa vào được Inbox, thử bấm nút Hộp thư
                if (state.hasSidebar) {
                    console.log('Attempting to click Inbox button on sidebar...');
                    await page.evaluate(() => {
                        const sidebar = document.querySelector('div[role="navigation"]');
                        if (!sidebar) return;

                        // Tìm chính xác nút trong sidebar
                        const selectors = [
                            'a[href*="/latest/inbox/"]',
                            '[aria-label="Hộp thư"]',
                            '[aria-label="Inbox"]'
                        ];

                        for (let sel of selectors) {
                            const btn = sidebar.querySelector(sel);
                            if (btn) {
                                btn.click();
                                return;
                            }
                        }

                        // Fallback: Tìm text bên trong sidebar
                        const allLinks = Array.from(sidebar.querySelectorAll('a, div[role="button"]'));
                        const target = allLinks.find(el => el.innerText && (el.innerText.includes('Hộp thư') || el.innerText.includes('Inbox')));
                        if (target) target.click();
                    });
                    await page.waitForTimeout(3000);
                }

                await closePopups(); // Luôn dọn dẹp popup trong lúc đợi
                await page.waitForTimeout(2000);
            }

            if (!isRetry) {
                console.log('Timeout. Reloading page...');
                await page.reload({ waitUntil: 'load' });
                return await waitForInboxUI(true);
            }

            console.log('Warning: Inbox UI still not detected after reload.');
            return false;
        }

        await waitForInboxUI();

        // BƯỚC QUAN TRỌNG: Xác minh nhanh UI (Quick Verify)
        async function quickVerify(targetPsid) {
            console.log(`Quick verifying PSID: ${targetPsid}...`);
            const startStr = Date.now();
            while (Date.now() - startStr < 5000) { // Chỉ đợi tối đa 5s
                const isCorrect = await page.evaluate((tPsid) => {
                    const activeItem = document.querySelector('[aria-selected="true"]');
                    return activeItem && activeItem.innerHTML.includes(tPsid);
                }, targetPsid);

                if (isCorrect) {
                    console.log(`Verification: OK.`);
                    return true;
                }
                await page.waitForTimeout(1000);
            }
            console.log(`Verification note: UI not confirmed, proceeding with URL logic.`);
            return false;
        }

        await quickVerify(psid);
        await closePopups();

        async function closePopups() {
            try {
                await page.evaluate(() => {
                    // Đóng dialog che màn hình bằng cách nhấn các nút Đóng/X
                    const closeSelectors = [
                        'div[role="dialog"] div[role="button"][aria-label="Đóng"]',
                        'div[role="dialog"] div[role="button"][aria-label="Close"]',
                        'div[role="dialog"] i[aria-label="Đóng"]',
                        '[aria-label="Đóng"]',
                        '[aria-label="Close"]'
                    ];

                    closeSelectors.forEach(sel => {
                        const btns = document.querySelectorAll(sel);
                        btns.forEach(b => b.click());
                    });

                    // Tìm các nút văn bản có nghĩa là "Đóng" hoặc không đồng ý
                    const negativeTexts = ["Lúc khác", "Từ chối", "Đóng", "Not Now", "Lần sau", "Hủy", "Để sau"];
                    const allInteractive = Array.from(document.querySelectorAll('div[role="button"], span, button'));
                    allInteractive.forEach(el => {
                        const text = el.innerText ? el.innerText.trim() : "";
                        if (negativeTexts.includes(text)) {
                            // Chỉ click nếu nó nằm bên trong một dialog hoặc popup
                            if (el.closest('div[role="dialog"], [role="alertdialog"], .k4ur4nXm')) {
                                el.click();
                            }
                        }
                    });
                });
                await page.waitForTimeout(1000);
            } catch (e) { }
        }

        await closePopups();

        // Ghi lại ảnh để debug
        // await page.screenshot({ path: `debug_before_extract_${psid}.png` });

        // Logic trích xuất link profile và tên
        const userData = await page.evaluate(() => {
            const isProfileLink = (href, text) => {
                if (!href) return false;
                const h = href.toLowerCase();
                const t = text ? text.trim() : "";

                if (h.includes('business.facebook.com') || h.includes('/messages/')) return false;
                if (!h.includes('facebook.com/')) return false;
                if (h.includes('l.facebook.com') || h.includes('/help/') || h.includes('sharer.php')) return false;

                const exclusions = ['/reel/', '/posts/', '/videos/', '/ads/', 'comment_id=', '/groups/', '/events/', '/shop/'];
                if (exclusions.some(exc => h.includes(exc))) return false;

                const textExclusions = [
                    'Facebook', 'Xem bình luận', 'View comment', 'Phản hồi', 'Reply', 'Like', 'Thích',
                    'Hãy kết nối', 'Messenger', 'Tìm hiểu thêm', 'Lúc khác', 'Kết nối', 'Chấp nhận',
                    'Từ chối', 'Đóng', 'Close', 'View'
                ];
                if (textExclusions.some(exc => t.includes(exc))) return false;
                if (t.length < 2 || t.length > 50) return false;

                return true;
            };

            let extractedName = "";
            let profileLink = "";

            // CHIẾN THUẬT: Ưu tiên tuyệt đối vào Right Panel (Complementary)
            const rightPanel = document.querySelector('div[role="complementary"], div[data-testid="contact-details-card"], div[data-testid="inbox-details-pane"]');
            if (rightPanel) {
                const links = Array.from(rightPanel.querySelectorAll('a'));
                const bestLink = links.find(a => isProfileLink(a.href, a.innerText));
                if (bestLink) {
                    profileLink = bestLink.href;
                    bestLink.style.border = '5px solid red';
                    bestLink.style.backgroundColor = 'yellow';

                    // Lấy nút này làm "mỏ neo" để tìm tên ngay sau đó
                    const anchorLink = bestLink;
                    // (Tên sẽ được xử lý ở bước sau của hàm evaluate này)
                }
            }

            if (!profileLink) {
                // Chỉ tìm toàn trang nếu panel bên phải chưa load (rất hiếm)
                const allLinks = Array.from(document.querySelectorAll('a'));
                const bestLink = allLinks.find(a => isProfileLink(a.href, a.innerText) && a.innerText.includes('trang cá nhân'));
                if (bestLink) {
                    profileLink = bestLink.href;
                }
            }

            if (!profileLink) return null;

            // Tìm nút gốc để walk-up (nếu tìm thấy link)
            const bestLink = Array.from(document.querySelectorAll('a')).find(a => a.href === profileLink);
            if (!bestLink) return null;

            // 2. Tìm Tên - Sử dụng profile link làm mỏ neo
            let current = bestLink;
            const invalidNameParts = ['Xem trang cá nhân', 'Facebook', 'Messenger', 'Instagram', 'Hãy kết nối', 'Dạ em', 'Kết nối ngay', 'Inbox', 'Hộp thư'];

            for (let i = 0; i < 5; i++) {
                if (!current) break;
                const parent = current.parentElement;
                if (!parent) break;

                const texts = parent.innerText.split('\n')
                    .map(t => t.trim())
                    .filter(t => t.length > 2 && !invalidNameParts.some(inv => t.includes(inv)) && !t.includes(':') && t.length < 50);

                if (texts.length > 0) {
                    extractedName = texts[0];
                    console.log(`Found name by walking up from link (Level ${i + 1}): ${extractedName}`);
                    break;
                }
                current = parent;
            }

            // Fallback: Tìm trong Right Panel (với nhiều selector hơn)
            if (!extractedName || extractedName === "Khách hàng" || extractedName === "Hộp thư") {
                const rightPanel = document.querySelector('div[role="complementary"], div[data-testid="contact-details-card"]');
                if (rightPanel) {
                    const header = rightPanel.querySelector('h2, h1, span[role="heading"]');
                    if (header && !invalidNameParts.some(inv => header.innerText.includes(inv)) && header.innerText.length < 50) {
                        extractedName = header.innerText.trim();
                    }
                }
            }

            // Chiến thuật 2: Middle Header
            if (!extractedName || extractedName === "Khách hàng" || extractedName.includes('Xem trang cá nhân')) {
                const midHeader = document.querySelector('div[role="main"] header');
                if (midHeader) {
                    const headerText = midHeader.innerText.split('\n')[0].trim();
                    if (headerText && headerText.length > 2 && headerText.length < 50 && !invalidNameParts.some(inv => headerText.includes(inv))) {
                        extractedName = headerText;
                    }
                }
            }

            // Chiến thuật 3: Active Conversation Item
            if (!extractedName || extractedName === "Khách hàng") {
                const activeItem = document.querySelector('div[aria-selected="true"]');
                if (activeItem) {
                    const itemText = activeItem.innerText.split('\n')[0].trim();
                    if (itemText && itemText.length < 50 && !invalidNameParts.some(inv => itemText.includes(inv))) {
                        extractedName = itemText;
                    }
                }
            }

            return {
                name: extractedName || "Khách hàng",
                profileLink: profileLink
            };
        });

        if (userData && userData.profileLink) {
            console.log(`Successfully extracted: ${userData.name} - ${userData.profileLink}`);

            await page.waitForTimeout(3000);
            return userData;
        }

        console.log(`Could not find profile link for PSID: ${psid}. Checking alternative selectors...`);
        // await page.screenshot({ path: `debug_failed_${psid}.png` });
        return null;

    } catch (error) {
        console.error('Scraping error:', error);
        // await page.screenshot({ path: `error_${psid}.png` });
        return null;
    } finally {
        await browser.close();
    }
}

module.exports = {
    scrapeUserProfile
};
