require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { handleWebhook, verifyWebhook } = require('./webhook');
const fs = require('fs');
const path = require('path');

// Load config
const configPath = path.join(__dirname, '../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const app = express();
const port = config.port || 3000;

app.use(bodyParser.json());

// FB Webhook verification
app.get('/webhook', (req, res) => verifyWebhook(req, res, config));

// FB Webhook event handling
app.post('/webhook', (req, res) => handleWebhook(req, res, config));

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
