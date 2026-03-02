const axios = require('axios');
const path = require('path');
const { scrapeUserProfile } = require('./browser');
const { getUserFromGraphAPI } = require('./graph-api');
const { appendToSheet, checkExistingProfile } = require('./sheets');

// CẤU HÌNH HÀNG ĐỢI (QUEUE) ĐỂ CHỐNG TREO MÁY
const queue = [];
let activeWorkers = 0;
const MAX_CONCURRENT = 1;
const processingPsids = new Set();
let accountIndex = 0; // Biến xoay vòng tài khoản
const fs = require('fs');
const history = []; // Lưu lại lịch sử 20 message gần nhất
const profileCache = new Map(); // Bộ nhớ đệm PSID -> profileLink
const CACHE_FILE = path.resolve(__dirname, '../profile_cache.json');

// Hàm helper lấy thời gian Việt Nam chuẩn
function getVNTime(date = new Date()) {
    return date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// NẠP CACHE TỪ FILE KHI KHỞI ĐỘNG
try {
    if (fs.existsSync(CACHE_FILE)) {
        const savedCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        Object.entries(savedCache).forEach(([k, v]) => profileCache.set(k, v));
        console.log(`[Cache] Loaded ${profileCache.size} profiles from disk.`);
    }
} catch (e) {
    console.log(`[Cache] Initialize error: ${e.message}`);
}

function getSystemStatus() {
    return {
        queueSize: queue.length,
        activeWorkers,
        accountIndex,
        history: history.slice(-20).reverse()
    };
}

const verifyWebhook = (req, res, config) => {
    const VERIFY_TOKEN = config.verify_token;

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
};

const handleWebhook = async (req, res, config) => {
    const body = req.body;

    if (body.object === 'page') {
        for (const entry of body.entry) {
            const pageId = entry.id;
            const pageConfig = config.pages[pageId];

            if (!pageConfig) continue;

            const events = entry.messaging || entry.standby;
            if (!events || events.length === 0) continue;

            for (const webhook_event of events) {
                const sender_psid = webhook_event.sender.id;

                // 🛑 BỘ LỌC CHẶN TIN NHẮN TỪ PAGE (ECHO FILTER)
                // Chỉ nhận tin nhắn khách gửi tới (webhook_event.message có tồn tại và KHÔNG phải echo)
                const isFromCustomer = webhook_event.message && !webhook_event.message.is_echo;

                if (!isFromCustomer) {
                    // Nếu là tin nhắn Echo (Page rep khách) -> BỎ QUA NGAY
                    continue;
                }

                const messageText = webhook_event.message.text || "";
                const messageId = webhook_event.message.mid;
                const timestamp = new Date(webhook_event.timestamp).toISOString(); // Dùng ISO chuẩn cho hệ thống/webhook

                // KIỂM SOÁT HÀNG ĐỢI (QUEUE)
                const isActive = processingPsids.has(sender_psid);
                const existingTask = queue.find(t => t.psid === sender_psid);

                if (existingTask) {
                    console.log(`[Queue] Gộp tin nhắn mới từ ${sender_psid} vào hàng đợi...`);
                    existingTask.messageText += ` | ${messageText}`;
                    existingTask.timestamp = timestamp;
                } else if (isActive) {
                    console.log(`[Queue] Khách ${sender_psid} đang được xử lý. Đẩy tin nhắn mới vào cuối hàng đợi.`);
                    queue.push({
                        psid: sender_psid,
                        pageConfig,
                        pageId,
                        messageText,
                        messageId,
                        timestamp,
                        retryCount: 0
                    });
                } else {
                    console.log(`[Queue] Thêm khách ${sender_psid} vào hàng đợi xử lý lần lượt.`);
                    queue.push({
                        psid: sender_psid,
                        pageConfig,
                        pageId,
                        messageText,
                        messageId,
                        timestamp,
                        retryCount: 0
                    });
                }

                processQueue();
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
};

async function processQueue() {
    if (activeWorkers >= MAX_CONCURRENT || queue.length === 0) return;

    const task = queue.shift();
    if (processingPsids.has(task.psid)) {
        // Nếu khách này đang có 1 trình duyệt khác xử lý rồi, đẩy lại xuống cuối hàng đợi để chờ
        queue.push(task);
        return;
    }

    activeWorkers++;
    processingPsids.add(task.psid);

    try {
        await processMessage(task.psid, task.pageConfig, task.pageId, task.messageText, task.messageId, task.timestamp);
    } catch (error) {
        console.error(`[Queue] Task failed for ${task.psid}:`, error.message);

        if (task.retryCount < 2) {
            task.retryCount++;
            console.log(`[Queue] Retrying ${task.psid} (Attempt ${task.retryCount + 1})...`);
            queue.push(task);
        }
    } finally {
        activeWorkers--;
        processingPsids.delete(task.psid);

        // TIẾP TỤC XỬ LÝ HÀNG ĐỢI (Nếu còn task)
        setImmediate(() => processQueue());
    }
}

function extractPhoneNumber(text) {
    if (!text) return "";
    // Loại bỏ hoàn toàn các ký tự nhiễu nhưng giữ lại số và dấu cộng
    const cleanedText = text.replace(/[^\d+]/g, '');
    // Regex linh hoạt hơn: bắt từ 8 đến 11 số (tính cả đầu 0, 84 hoặc +84)
    const phoneRegex = /(?:\+84|84|0)\d{7,10}/g;
    const matches = cleanedText.match(phoneRegex);
    return matches ? matches[matches.length - 1] : "";
}

async function sendToN8N(payload) {
    const n8nUrl = 'https://intercardinal-overfoolishly-rachel.ngrok-free.dev/api/v1/n8n_message';
    const apiKey = 'Q9fR8ZpA6T7mXWcE2yJ5LkH4D3nS0BqVYgM1UeNiaOohCrtKsFv';

    try {
        console.log(`[N8N] Sending Payload:`, JSON.stringify(payload, null, 2));
        await axios.post(n8nUrl, payload, {
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
            timeout: 10000
        });
        console.log(`[N8N] Success: ${payload.ps_id} (${payload.customer_name})`);
    } catch (error) {
        console.error(`[N8N] Error for ${payload.ps_id}: ${error.message}`);
    }
}

async function processMessage(psid, pageConfig, pageId, messageText, messageId, timestamp) {
    const phoneNumber = extractPhoneNumber(messageText);
    const accessToken = pageConfig.page_access_token;

    console.log(`[Process] Starting for PSID: ${psid} on Page: ${pageId}`);

    // ===== BƯỚC 1: GRAPH API lấy TÊN (SIÊU AN TOÀN) =====
    let graphName = null;
    try {
        const graphData = await getUserFromGraphAPI(psid, pageId, accessToken);
        if (graphData && graphData.name) graphName = graphData.name;
    } catch (e) {
        console.log(`[Process] Graph API failed: ${e.message}`);
    }

    // ===== BƯỚC 2: KIỂM TRA CACHE & XOAY VÒNG TÀI KHOẢN =====
    let finalProfileLink = profileCache.get(psid) || "";
    let browserName = "";

    if (finalProfileLink) {
        console.log(`[Process] ⚡ Cache Hit! Using stored link for ${psid}: ${finalProfileLink}`);
    } else {
        const accounts = require('../config.json').accounts || [];
        const maxAttempts = accounts.length || 1;
        let attempt = 0;

        while (attempt < maxAttempts) {
            let selectedAccount = null;
            let cookiePath = null;

            if (accounts.length > 0) {
                selectedAccount = accounts[accountIndex % accounts.length];
                cookiePath = path.resolve(__dirname, '..', selectedAccount.cookie_file);
                accountIndex++;
                console.log(`[Process] Account Attempt ${attempt + 1}/${maxAttempts}: ${selectedAccount.name}`);
            } else {
                cookiePath = path.resolve(__dirname, '../cookies.json');
                console.log(`[Process] No accounts found, using default cookies.json`);
                attempt = maxAttempts;
            }

            try {
                const browserData = await scrapeUserProfile(psid, pageId, cookiePath, graphName, selectedAccount);
                if (browserData && (browserData.profileLink || browserData.name !== "Khách hàng")) {
                    finalProfileLink = browserData.profileLink || "";
                    browserName = browserData.name || "";

                    // CẬP NHẬT CACHE & BẢO VỆ RAM
                    if (finalProfileLink) {
                        if (profileCache.size > 1000) profileCache.clear();
                        profileCache.set(psid, finalProfileLink);

                        // LƯU XUỐNG DISK ĐỂ KHÔNG MẤT KHI RESTART
                        try {
                            const cacheObj = Object.fromEntries(profileCache);
                            fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheObj, null, 2), 'utf8');
                            console.log(`[Process] 💾 Cache Saved to Disk for ${psid}`);
                        } catch (ce) { }
                    }
                    break;
                } else {
                    console.log(`[Process] ⚠️ Account ${selectedAccount?.name} failed (Expired or No data).`);
                }
            } catch (e) {
                console.log(`[Process] Error with account ${selectedAccount?.name}: ${e.message}`);
            }

            // ĐỢI 2 GIÂY TRƯỚC KHI THỬ ACC TIẾP THEO (Để server không quá tải)
            attempt++;
            if (attempt < maxAttempts && !finalProfileLink) {
                console.log(`[Process] Waiting 2s before next account attempt...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    // ===== BƯỚC 3: KẾT HỢP KẾT QUẢ =====
    const finalName = graphName || browserName || "Khách hàng";

    console.log(`[Process] 📊 KẾT QUẢ:`);
    console.log(`  Tên: ${finalName} (${graphName ? 'Graph API' : 'Browser'})`);
    console.log(`  Link: ${finalProfileLink || 'N/A'}`);

    // Luôn lưu vào Google Sheet (Dùng giờ VN)
    await appendToSheet(
        [getVNTime(new Date(timestamp)), psid, finalName, finalProfileLink || "N/A", phoneNumber, pageConfig.name],
        pageConfig.spreadsheet_id,
        pageConfig.sheet_name
    );

    // Lưu vào history để hiện trên UI Admin (Dùng giờ VN)
    history.push({
        time: new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
        psid,
        name: finalName,
        profileLink: finalProfileLink,
        page: pageConfig.name,
        status: finalProfileLink ? 'success' : 'failed'
    });
    if (history.length > 50) history.shift();

    // Gửi N8N nếu dữ liệu hợp lệ (CÓ LINK và không phải hệ thống/lỗi)
    const hasValidLink = finalProfileLink && !finalProfileLink.includes('login.php') && !finalProfileLink.includes('checkpoint');
    const isSystemUser = finalName === "Hộp thư"; // Chỉ chặn nếu là thông báo hệ thống "Hộp thư"

    if (hasValidLink && !isSystemUser) {
        const n8nPayload = {
            "source": "Inbox",
            "page_id": pageId,
            "ps_id": psid,
            "m_id": messageId,
            "time_stamp": timestamp,
            "customer_name": finalName,
            "customer_facebook_url": finalProfileLink,
            "text": messageText,
            "extracted_phone_number": phoneNumber
        };
        await sendToN8N(n8nPayload);
    } else {
        console.log(`[Process] Skipping N8N for ${psid} (No link or System user)`);
    }
}

module.exports = { verifyWebhook, handleWebhook, getSystemStatus };
