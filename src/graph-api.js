/**
 * GRAPH API MODULE - Lấy thông tin khách hàng qua Facebook Graph API
 * Nhanh (<1 giây), chính xác, token vĩnh viễn
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Lấy tên khách hàng qua Graph API (Conversations endpoint)
 * @param {string} psid - Page-scoped ID của khách
 * @param {string} pageId - ID của Page
 * @param {string} accessToken - Page Access Token
 * @returns {object} { name, psid } hoặc null nếu thất bại
 */
async function getUserFromGraphAPI(psid, pageId, accessToken) {
    try {
        console.log(`[GraphAPI] Fetching name for PSID: ${psid}...`);

        const res = await axios.get(`${GRAPH_API_BASE}/${pageId}/conversations`, {
            params: {
                fields: 'participants',
                user_id: psid,
                access_token: accessToken
            },
            timeout: 10000
        });

        const conversations = res.data.data;
        if (!conversations || conversations.length === 0) {
            console.log(`[GraphAPI] No conversation found for PSID: ${psid}`);
            return null;
        }

        // Tìm participant KHÔNG phải Page (đó chính là khách hàng)
        const participants = conversations[0].participants.data;
        const customer = participants.find(p => p.id === psid);

        if (customer) {
            console.log(`[GraphAPI] ✅ Found: ${customer.name} (${customer.id})`);
            return {
                name: customer.name,
                psid: customer.id
            };
        }

        console.log(`[GraphAPI] Customer not found in participants`);
        return null;

    } catch (error) {
        const errMsg = error.response?.data?.error?.message || error.message;
        console.error(`[GraphAPI] ❌ Error: ${errMsg}`);

        // Phát hiện token hết hạn
        if (errMsg.includes('session is invalid') || errMsg.includes('access token')) {
            console.error(`[GraphAPI] ⚠️ TOKEN HẾT HẠN! Cần tạo token mới.`);
        }

        return null;
    }
}

module.exports = { getUserFromGraphAPI };
