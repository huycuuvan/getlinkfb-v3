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
const history = []; // Lưu lại lịch sử 20 message gần nhất

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

                // BỎ QUA nếu người gửi chính là Page (Page tự nhắn hoặc bot rep)
                if (sender_psid === pageId) {
                    console.log(`[Webhook] Ignoring message from Page itself (${pageId})`);
                    continue;
                }

                if (webhook_event.message && !webhook_event.message.is_echo) {
                    const messageText = webhook_event.message.text || "";
                    const messageId = webhook_event.message.mid;
                    const timestamp = new Date(webhook_event.timestamp).toISOString();

                    // 1. Kiểm tra xem khách này có đang được xử lý (Active) không
                    const isActive = processingPsids.has(sender_psid);
                    // 2. Kiểm tra xem khách này có đang nằm chờ trong hàng đợi không
                    const existingTask = queue.find(t => t.psid === sender_psid);

                    if (existingTask) {
                        console.log(`[Queue] Merging message for ${sender_psid} in queue...`);
                        existingTask.messageText += ` | ${messageText}`;
                        existingTask.timestamp = timestamp;
                    } else if (isActive) {
                        console.log(`[Queue] User ${sender_psid} is already active. Adding new task to queue.`);
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
                        console.log(`[Queue] Adding message from ${sender_psid} to queue...`);
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
        processQueue();
    }
}

function extractPhoneNumber(text) {
    if (!text) return "";
    const cleanedText = text.replace(/[\s.-]/g, '');
    const phoneRegex = /(?:\+84|84|0)\d{8,10}/g;
    const matches = cleanedText.match(phoneRegex);
    return matches ? matches[matches.length - 1] : ""; // Lấy số cuối cùng nếu khách nhắn nhiều số
}

async function sendToN8N(payload) {
    const n8nUrl = 'https://intercardinal-overfoolishly-rachel.ngrok-free.dev/api/v1/n8n_message';
    const apiKey = 'Q9fR8ZpA6T7mXWcE2yJ5LkH4D3nS0BqVYgM1UeNiaOohCrtKsFv';

    try {
        await axios.post(n8nUrl, payload, {
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
            timeout: 10000
        });
        console.log(`[N8N] Sent: ${payload.ps_id} (${payload.customer_name})`);
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

    // ===== BƯỚC 2: XOAY VÒNG TÀI KHOẢN & LẤY PROFILE LINK =====
    let finalProfileLink = "";
    let browserName = "";

    // XOAY VÒNG TÀI KHOẢN
    const accounts = require('../config.json').accounts || [];
    let selectedAccount = null;
    let cookiePath = null;

    if (accounts.length > 0) {
        selectedAccount = accounts[accountIndex % accounts.length];
        cookiePath = path.resolve(__dirname, '..', selectedAccount.cookie_file);
        accountIndex++;
        console.log(`[Process] Using Account: ${selectedAccount.name} (${selectedAccount.cookie_file})`);
    } else {
        cookiePath = path.resolve(__dirname, '../cookies.json');
        console.log(`[Process] No accounts found, using default cookies.json`);
    }

    try {
        // TRUYỀN graphName vào làm "mỏ neo" để trình duyệt kiểm tra đúng người
        const browserData = await scrapeUserProfile(psid, pageId, cookiePath, graphName);
        if (browserData) {
            finalProfileLink = browserData.profileLink || "";
            browserName = browserData.name || "";
        }
    } catch (e) {
        console.log(`[Process] Browser scrape failed with account ${selectedAccount?.name || 'default'}: ${e.message}`);
    }

    // ===== BƯỚC 3: KẾT HỢP KẾT QUẢ =====
    const finalName = graphName || browserName || "Khách hàng";

    console.log(`[Process] 📊 KẾT QUẢ:`);
    console.log(`  Tên: ${finalName} (${graphName ? 'Graph API' : 'Browser'})`);
    console.log(`  Link: ${finalProfileLink || 'N/A'}`);

    // Luôn lưu vào Google Sheet
    await appendToSheet(
        [new Date().toLocaleString(), psid, finalName, finalProfileLink || "N/A", phoneNumber, pageConfig.name],
        pageConfig.spreadsheet_id,
        pageConfig.sheet_name
    );

    // Lưu vào history để hiện trên UI Admin
    history.push({
        time: new Date().toLocaleTimeString(),
        psid,
        name: finalName,
        profileLink: finalProfileLink,
        page: pageConfig.name,
        status: finalProfileLink ? 'success' : 'failed'
    });
    if (history.length > 50) history.shift();

    // Gửi N8N nếu dữ liệu hợp lệ (có tên thật + có profile link)
    const isMessengerUser = finalName.includes("Người dùng Messenger") || finalName === "Khách hàng" || finalName === "Hộp thư";
    const isLoginLink = finalProfileLink.includes('login.php') || finalProfileLink.includes('checkpoint');

    if (!isMessengerUser && !isLoginLink && finalProfileLink) {
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
        console.log(`[Process] Saved to Sheet but skipping N8N for ${psid} (Invalid data or No Profile Link)`);
    }
}

module.exports = { verifyWebhook, handleWebhook, getSystemStatus };
