/**
 * ĐỔI SHORT-LIVED TOKEN → PERMANENT TOKEN
 * 
 * Bước 1: Lấy short-lived token từ Graph API Explorer
 * Bước 2: Chạy script này: node exchange-token.js <SHORT_LIVED_TOKEN>
 * Bước 3: Script sẽ tự động cập nhật config.json
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const shortLivedToken = process.argv[2];

if (!shortLivedToken) {
    console.log('❌ Thiếu token!');
    console.log('');
    console.log('Cách dùng: node exchange-token.js <SHORT_LIVED_USER_TOKEN>');
    console.log('');
    console.log('Lấy token tại: https://developers.facebook.com/tools/explorer/');
    console.log('  1. Chọn App → Get User Access Token');
    console.log('  2. Tick: pages_messaging, pages_show_list, pages_read_engagement');
    console.log('  3. Generate Access Token → Copy paste vào đây');
    process.exit(1);
}

async function exchangeToken() {
    console.log('='.repeat(60));
    console.log('🔄 ĐỔI TOKEN FACEBOOK');
    console.log('='.repeat(60));

    // Bước 1: Đổi Short-lived User Token → Long-lived User Token
    console.log('\n[1/3] Đổi sang Long-lived User Token...');
    let longLivedUserToken;
    try {
        // Lấy App ID và App Secret từ token debug
        const debugRes = await axios.get(`${GRAPH_API_BASE}/debug_token`, {
            params: { input_token: shortLivedToken, access_token: shortLivedToken }
        });
        const appId = debugRes.data.data.app_id;
        console.log(`      App ID: ${appId}`);

        // Cần App Secret - hỏi user
        console.log('');
        console.log('⚠️  Cần APP SECRET để đổi token.');
        console.log(`    Vào: https://developers.facebook.com/apps/${appId}/settings/basic/`);
        console.log('    Copy "App Secret" và chạy lại:');
        console.log(`    node exchange-token.js ${shortLivedToken} <APP_SECRET>`);

        const appSecret = process.argv[3];
        if (!appSecret) {
            // Thử trực tiếp lấy page tokens từ short-lived token (vẫn hoạt động)
            console.log('');
            console.log('💡 Hoặc: Bỏ qua bước này, thử lấy Page Token trực tiếp...');
            longLivedUserToken = shortLivedToken; // Dùng tạm short-lived
        } else {
            const res = await axios.get(`${GRAPH_API_BASE}/oauth/access_token`, {
                params: {
                    grant_type: 'fb_exchange_token',
                    client_id: appId,
                    client_secret: appSecret,
                    fb_exchange_token: shortLivedToken
                }
            });
            longLivedUserToken = res.data.access_token;
            console.log('      ✅ Long-lived User Token OK');
        }
    } catch (err) {
        console.log('      ❌ Lỗi:', err.response?.data?.error?.message || err.message);
        console.log('      → Thử dùng token gốc...');
        longLivedUserToken = shortLivedToken;
    }

    // Bước 2: Lấy danh sách Page Tokens
    console.log('\n[2/3] Lấy Page Access Tokens...');
    try {
        const res = await axios.get(`${GRAPH_API_BASE}/me/accounts`, {
            params: {
                fields: 'id,name,access_token',
                access_token: longLivedUserToken
            }
        });

        const pages = res.data.data;
        console.log(`      Tìm thấy ${pages.length} Pages:\n`);

        let updatedCount = 0;
        for (const page of pages) {
            const isInConfig = config.pages[page.id];
            const status = isInConfig ? '✅ CẬP NHẬT' : '⏭️  BỎ QUA (không có trong config)';
            console.log(`      ${status}: ${page.name} (${page.id})`);

            if (isInConfig) {
                config.pages[page.id].page_access_token = page.access_token;
                updatedCount++;
            }
        }

        // Bước 3: Lưu config
        if (updatedCount > 0) {
            console.log(`\n[3/3] Lưu config.json (${updatedCount} tokens đã cập nhật)...`);
            fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
            console.log('      ✅ config.json đã được cập nhật!');

            // Test thử token mới
            console.log('\n--- KIỂM TRA TOKEN MỚI ---');
            const firstPage = pages.find(p => config.pages[p.id]);
            if (firstPage) {
                const testRes = await axios.get(`${GRAPH_API_BASE}/debug_token`, {
                    params: { input_token: firstPage.access_token, access_token: firstPage.access_token }
                });
                const data = testRes.data.data;
                console.log(`      Page: ${firstPage.name}`);
                console.log(`      Valid: ${data.is_valid}`);
                console.log(`      Expires: ${data.expires_at === 0 ? '♾️  VĨNH VIỄN (Permanent)' : new Date(data.expires_at * 1000).toLocaleString()}`);
                console.log(`      Scopes: ${(data.scopes || []).join(', ')}`);
            }
        } else {
            console.log('\n⚠️  Không có Page nào trong danh sách khớp với config.json');
            console.log('    Các Page ID trong config:', Object.keys(config.pages).join(', '));
        }

    } catch (err) {
        console.log('      ❌ Lỗi:', err.response?.data?.error?.message || err.message);
    }

    console.log('\n' + '='.repeat(60));
    console.log('📌 SAU KHI CẬP NHẬT TOKEN:');
    console.log('   1. Chạy lại: node test-graph-api.js <PSID> <PAGE_ID>');
    console.log('   2. Restart bot: taskkill /F /IM node.exe; npm start');
    console.log('='.repeat(60));
}

exchangeToken();
