/**
 * TEST GRAPH API - Kiểm tra lấy thông tin khách hàng qua Facebook Graph API
 * 
 * Usage: node test-graph-api.js <PSID> <PAGE_ID>
 * 
 * Ví dụ: node test-graph-api.js 26534348112823801 232546149932540
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Load config
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Lấy PSID và PAGE_ID từ command line
const psid = process.argv[2];
const pageId = process.argv[3];

if (!psid || !pageId) {
    console.log('❌ Thiếu tham số!');
    console.log('');
    console.log('Cách dùng: node test-graph-api.js <PSID> <PAGE_ID>');
    console.log('');
    console.log('Danh sách Page ID có sẵn:');
    for (const [pid, pconfig] of Object.entries(config.pages)) {
        console.log(`  ${pid} - ${pconfig.name}`);
    }
    process.exit(1);
}

const pageConfig = config.pages[pageId];
if (!pageConfig) {
    console.log(`❌ Không tìm thấy Page ID: ${pageId}`);
    console.log('Danh sách Page ID hợp lệ:');
    for (const [pid, pconfig] of Object.entries(config.pages)) {
        console.log(`  ${pid} - ${pconfig.name}`);
    }
    process.exit(1);
}

const TOKEN = pageConfig.page_access_token;

console.log('='.repeat(60));
console.log(`📋 TEST FACEBOOK GRAPH API`);
console.log(`📄 Page: ${pageConfig.name} (${pageId})`);
console.log(`👤 PSID: ${psid}`);
console.log('='.repeat(60));

async function testGraphAPI() {
    // ===== TEST 1: Lấy thông tin cơ bản của User =====
    console.log('\n--- TEST 1: User Profile (Basic) ---');
    try {
        const res = await axios.get(`${GRAPH_API_BASE}/${psid}`, {
            params: {
                fields: 'name,first_name,last_name,profile_pic',
                access_token: TOKEN
            },
            timeout: 10000
        });
        console.log('✅ Kết quả:', JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.log('❌ Lỗi:', err.response?.data?.error?.message || err.message);
    }

    // ===== TEST 2: Lấy thông tin User với ASID (App-scoped ID) =====
    console.log('\n--- TEST 2: User IDs (ASID) ---');
    try {
        const res = await axios.get(`${GRAPH_API_BASE}/${psid}/ids_for_apps`, {
            params: {
                access_token: TOKEN
            },
            timeout: 10000
        });
        console.log('✅ Kết quả:', JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.log('❌ Lỗi:', err.response?.data?.error?.message || err.message);
    }

    // ===== TEST 3: Lấy thông tin User với IDs for Pages =====
    console.log('\n--- TEST 3: User IDs for Pages ---');
    try {
        const res = await axios.get(`${GRAPH_API_BASE}/${psid}/ids_for_pages`, {
            params: {
                access_token: TOKEN
            },
            timeout: 10000
        });
        console.log('✅ Kết quả:', JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.log('❌ Lỗi:', err.response?.data?.error?.message || err.message);
    }

    // ===== TEST 4: Lấy cuộc trò chuyện =====
    console.log('\n--- TEST 4: Conversations ---');
    try {
        const res = await axios.get(`${GRAPH_API_BASE}/${pageId}/conversations`, {
            params: {
                fields: 'participants,updated_time,snippet',
                user_id: psid,
                access_token: TOKEN
            },
            timeout: 10000
        });
        console.log('✅ Kết quả:', JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.log('❌ Lỗi:', err.response?.data?.error?.message || err.message);
    }

    // ===== TEST 5: Token Debug (kiểm tra token còn sống không) =====
    console.log('\n--- TEST 5: Token Debug ---');
    try {
        const res = await axios.get(`${GRAPH_API_BASE}/debug_token`, {
            params: {
                input_token: TOKEN,
                access_token: TOKEN
            },
            timeout: 10000
        });
        const data = res.data.data;
        console.log('✅ Token Info:');
        console.log(`   App ID: ${data.app_id}`);
        console.log(`   Type: ${data.type}`);
        console.log(`   Valid: ${data.is_valid}`);
        console.log(`   Expires: ${data.expires_at === 0 ? 'Never (Permanent)' : new Date(data.expires_at * 1000).toLocaleString()}`);
        console.log(`   Scopes: ${(data.scopes || []).join(', ')}`);
    } catch (err) {
        console.log('❌ Lỗi:', err.response?.data?.error?.message || err.message);
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 KẾT LUẬN:');
    console.log('  - Nếu TEST 1 trả về "name" → Graph API lấy được TÊN (không cần cookies)');
    console.log('  - Nếu TEST 2/3 trả về ASID → Có thể ghép thành profile link');
    console.log('  - Nếu TEST 4 trả về conversations → Có thể lấy thêm thông tin');
    console.log('  - Nếu TEST 5 Token expires "Never" → Token vĩnh viễn, không lo hết hạn');
    console.log('='.repeat(60));
}

testGraphAPI();
