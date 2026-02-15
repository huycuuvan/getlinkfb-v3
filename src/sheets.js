const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const fs = require('fs');
const path = require('path');

async function appendToSheet(rowData, spreadsheetId, sheetName = 'Sheet1') {
    try {
        const credentialsPath = path.join(__dirname, '../service_account.json');
        const creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

        const serviceAccountAuth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);

        await doc.loadInfo();
        const sheet = doc.sheetsByTitle[sheetName] || doc.sheetsByIndex[0];

        await sheet.addRow(rowData);
        console.log(`Row added to Google Sheet (${sheetName}) successfully`);
    } catch (error) {
        console.error('Error adding to Google Sheet:', error);
    }
}

module.exports = {
    appendToSheet
};
