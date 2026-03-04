require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { handleWebhook, verifyWebhook, getSystemStatus } = require('./webhook');
const fs = require('fs');
const path = require('path');

// Load config
const configPath = path.join(__dirname, '../config.json');
const cookiesPath = process.env.FB_COOKIES_PATH || path.join(__dirname, '../cookies.json');
const secretsPath = path.join(__dirname, '../service_account.json');

const loadConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
let config = loadConfig();

const app = express();
const port = config.port || 4000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// FB Webhook verification
app.get('/webhook', (req, res) => verifyWebhook(req, res, config));
app.post('/webhook', (req, res) => handleWebhook(req, res, config));

// --- ADMIN API ---

// Giao diện Admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// Đọc file config/cookies
app.get('/api/admin/read', (req, res) => {
    try {
        const { file } = req.query;
        let targetPath = '';
        if (file === 'cookies') targetPath = cookiesPath;
        else if (file === 'config') targetPath = configPath;
        else if (file === 'secrets') targetPath = secretsPath;
        else return res.status(400).json({ error: 'Invalid file type' });

        if (!fs.existsSync(targetPath)) {
            return res.json({ content: '{}' });
        }
        const content = fs.readFileSync(targetPath, 'utf8');
        res.json({ content });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Ghi file config/cookies
app.post('/api/admin/write', (req, res) => {
    try {
        const { file, content } = req.body;
        let targetPath = '';
        if (file === 'cookies') targetPath = cookiesPath;
        else if (file === 'config') targetPath = configPath;
        else if (file === 'secrets') targetPath = secretsPath;
        else return res.status(400).json({ error: 'Invalid file type' });

        // Validate JSON before saving
        JSON.parse(content);

        fs.writeFileSync(targetPath, content, 'utf8');

        // Cập nhật lại config trong bộ nhớ nếu là file config
        if (file === 'config') {
            config = JSON.parse(content);
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Invalid JSON or write error' });
    }
});

// Trạng thái hệ thống (cho dashboard)
app.get('/api/admin/status', (req, res) => {
    try {
        const status = getSystemStatus();
        res.json({
            ...status,
            accounts: config.accounts || [],
            pages: Object.keys(config.pages).map(id => ({
                id,
                name: config.pages[id].name
            }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Thêm tài khoản phụ mới
app.post('/api/admin/accounts/add', (req, res) => {
    try {
        const { name, cookieContent } = req.body;
        if (!name || !cookieContent) return res.status(400).json({ error: 'Missing name or cookies' });

        // Validate JSON cookies
        JSON.parse(cookieContent);

        // Tạo tên file an toàn
        const safeName = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, '_');
        const filename = `cookies/acc_${safeName}_${Date.now()}.json`;
        const fullPath = path.join(__dirname, '..', filename);

        // Đảm bảo thư mục tồn tại
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // 1. Lưu file cookies
        fs.writeFileSync(fullPath, cookieContent, 'utf8');

        // 2. Cập nhật config.json
        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!currentConfig.accounts) currentConfig.accounts = [];

        currentConfig.accounts.push({
            name: name,
            cookie_file: filename
        });

        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 4), 'utf8');
        config = currentConfig; // Update in-memory config

        res.json({ success: true, filename });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Xử lý XÓA tài khoản
app.post('/api/admin/accounts/delete', (req, res) => {
    try {
        const { cookie_file } = req.body;
        if (!cookie_file) return res.status(400).json({ error: 'Missing filename' });

        const currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const accountIndex = currentConfig.accounts.findIndex(acc => acc.cookie_file === cookie_file);

        if (accountIndex > -1) {
            // Xóa file vật lý
            const fullPath = path.join(__dirname, '..', cookie_file);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);

            // Xóa khỏi config
            currentConfig.accounts.splice(accountIndex, 1);
            fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 4), 'utf8');
            config = currentConfig;
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Account not found' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Xử lý REFRESH (Cập nhật) cookies cho nick cũ
app.post('/api/admin/accounts/refresh', (req, res) => {
    try {
        const { cookie_file, cookieContent } = req.body;
        if (!cookie_file || !cookieContent) return res.status(400).json({ error: 'Missing data' });

        // Validate JSON
        JSON.parse(cookieContent);

        const fullPath = path.join(__dirname, '..', cookie_file);
        if (fs.existsSync(fullPath)) {
            fs.writeFileSync(fullPath, cookieContent, 'utf8');
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Restart bot
app.post('/api/admin/restart', (req, res) => {
    console.log('[Admin] Restarting service...');
    res.json({ success: true });
    setTimeout(() => {
        process.exit(0); // PM2 sẽ tự động restart lại app
    }, 1000);
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    console.log(`Admin panel: http://localhost:${port}/admin`);
});
