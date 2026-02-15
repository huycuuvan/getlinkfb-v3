const axios = require('axios');
const { scrapeUserProfile } = require('./browser');
const { appendToSheet } = require('./sheets');

// CẤU HÌNH HÀNG ĐỢI (QUEUE) ĐỂ CHỐNG TREO MÁY
const queue = [];
let activeWorkers = 0;
const MAX_CONCURRENT = 1; // CHỈ CHẠY 1 trình duyệt tại một thời điểm để tránh loạn Session/Cookies Facebook
const processingPsids = new Set(); // Theo dõi các PSID đang được xử lý

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

    console.log(`[Scraper] Starting: ${psid} on Page: ${pageId}...`);
    const userData = await scrapeUserProfile(psid, pageId);

    if (userData && userData.profileLink) {
        const isMessengerUser = userData.name.includes("Người dùng Messenger") || userData.name === "Khách hàng" || userData.name === "Hộp thư";
        const isLoginLink = userData.profileLink.includes('login.php') || userData.profileLink.includes('checkpoint');

        console.log(`[Scraper] Success: ${userData.name} - ${userData.profileLink}`);

        await appendToSheet(
            [new Date().toLocaleString(), psid, userData.name, userData.profileLink, phoneNumber, pageConfig.name],
            pageConfig.spreadsheet_id,
            pageConfig.sheet_name
        );

        if (!isMessengerUser && !isLoginLink) {
            const n8nPayload = {
                "source": "Inbox",
                "page_id": pageId,
                "ps_id": psid,
                "m_id": messageId,
                "time_stamp": timestamp,
                "customer_name": userData.name,
                "customer_facebook_url": userData.profileLink,
                "text": messageText,
                "extracted_phone_number": phoneNumber
            };
            await sendToN8N(n8nPayload);
        } else {
            console.log(`[Scraper] Skipping N8N for ${psid} (Invalid data)`);
        }
    } else {
        throw new Error("No data extracted");
    }
}

module.exports = { verifyWebhook, handleWebhook };
