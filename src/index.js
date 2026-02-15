require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { handleWebhook, verifyWebhook } = require('./webhook');
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
