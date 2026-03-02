const path = require('path');
const { refreshAccount } = require('./browser');

/**
 * Tự động bảo trì dàn tài khoản VIA
 * @param {Object} config - Cấu hình từ config.json
 */
async function runMaintenance(config) {
    console.log(`[Maintenance] 🛠️ Starting periodic account refresh...`);

    const accounts = config.accounts || [];
    if (accounts.length === 0) {
        console.log(`[Maintenance] No accounts to refresh.`);
        return;
    }

    for (const acc of accounts) {
        const fullPath = path.resolve(__dirname, '..', acc.cookie_file);
        try {
            await refreshAccount(fullPath, acc);
            // Đợi 10 giây giữa mỗi acc để tránh dồn dập
            await new Promise(resolve => setTimeout(resolve, 10000));
        } catch (e) {
            console.error(`[Maintenance] Failed for ${acc.name}:`, e.message);
        }
    }

    console.log(`[Maintenance] ✨ All accounts processed. Next run in 45-60 minutes.`);
}

function startMaintenance(config) {
    // Chạy lần đầu sau 1 phút khởi động
    setTimeout(() => runMaintenance(config), 60000);

    // Lặp lại sau mỗi 45 phút (2700000 ms)
    setInterval(() => {
        runMaintenance(config);
    }, 45 * 60 * 1000);
}

module.exports = { startMaintenance };
