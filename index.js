const express = require('express');
const app = express();
const port = process.env.PORT || 8080;
require('dotenv').config();
const { google } = require('googleapis');
const fetch = require('node-fetch');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay() {
  return Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000;
}

function getColumnLetter(index) {
  let letter = '';
  while (index >= 0) {
    letter = String.fromCharCode((index % 26) + 65) + letter;
    index = Math.floor(index / 26) - 1;
  }
  return letter;
}

async function authorize() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return await auth.getClient();
}

function getDateRange(period) {
  const tzOffset = -4 * 60;
  const now = new Date(new Date().getTime() + tzOffset * 60000);
  let since = '', until = now.toISOString();

  const mondayOfThisWeek = new Date(now);
  mondayOfThisWeek.setUTCDate(
    mondayOfThisWeek.getUTCDate() - (mondayOfThisWeek.getUTCDay() === 0 ? 6 : mondayOfThisWeek.getUTCDay() - 1)
  );
  mondayOfThisWeek.setUTCHours(0, 0, 0, 0);

  if (period === 'week' || period === 'current') {
    since = mondayOfThisWeek.toISOString();
  } else if (period === 'lastWeek') {
    const monday = new Date(mondayOfThisWeek);
    monday.setUTCDate(monday.getUTCDate() - 7);
    monday.setUTCHours(0, 0, 0, 0);
    const sunday = new Date(mondayOfThisWeek);
    sunday.setUTCDate(sunday.getUTCDate() - 1);
    sunday.setUTCHours(23, 59, 59, 999);
    since = monday.toISOString();
    until = sunday.toISOString();
  } else if (period === 'month') {
    const firstDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    since = firstDay.toISOString();
  } else if (period === 'lastMonth') {
    const firstDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));
    since = firstDay.toISOString();
    until = lastDay.toISOString();
  } else if (period === 'year') {
    const janFirst = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    since = janFirst.toISOString();
  } else if (period === 'lastYear') {
    const firstDay = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
    const lastDay = new Date(Date.UTC(now.getUTCFullYear() - 1, 11, 31, 23, 59, 59, 999));
    since = firstDay.toISOString();
    until = lastDay.toISOString();
  }

  return { since, until };
}

async function run(mode) {
  const client = await authorize();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const sheetId = process.env.SHEET_ID;
  const sheetName = 'Shopify Meta';
  if (!sheetId) throw new Error('❌ Falta la variable de entorno SHEET_ID.');

  let periods, metaRows, shopifyRows;
  if (mode === 'lastWeek') {
    periods = ['lastWeek'];
    metaRows = { lastWeek: 7 };
    shopifyRows = { sales: { lastWeek: 19 }, orders: { lastWeek: 25 } };
  } else if (mode === 'lastMonth') {
    periods = ['lastMonth'];
    metaRows = { lastMonth: 9 };
    shopifyRows = { sales: { lastMonth: 21 }, orders: { lastMonth: 27 } };
  } else if (mode === 'lastYear') {
    periods = ['lastYear'];
    metaRows = { lastYear: 11 };
    shopifyRows = { sales: { lastYear: 23 }, orders: { lastYear: 29 } };
  } else {
    periods = ['week', 'month', 'year'];
    metaRows = { week: 6, month: 8, year: 10 };
    shopifyRows = { sales: { week: 18, month: 20, year: 22 }, orders: { week: 24, month: 26, year: 28 } };
  }

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!A1:ZZ30`,
  });
  const values = data.values;
  const colCount = values[0]?.length || 0;

  for (let col = 1; col < colCount; col++) {
    const adAccountId = values[2]?.[col];
    const metaToken = values[3]?.[col];
    const campaignIdRaw = values[4]?.[col];
    const shopifyToken = values[14]?.[col];
    const shopUrl = values[15]?.[col];
    const version = values[16]?.[col];

    for (const period of periods) {
      const { since, until } = getDateRange(period);

      // Meta Ads
      if (metaToken && campaignIdRaw) {
        const campaignIds = campaignIdRaw.split(',').map(id => id.trim());
        let totalSpend = 0;
        for (const campaignId of campaignIds) {
          const url = `https://graph.facebook.com/v19.0/${campaignId}/insights?fields=spend&access_token=${metaToken}&time_range[since]=${since}&time_range[until]=${until}&level=campaign&attribution_setting=7d_click_1d_view`;
          try {
            const response = await fetch(url);
            const json = await response.json();
            const spend = parseFloat(json?.data?.[0]?.spend || "0.00");
            totalSpend += spend;
          } catch (e) {
            console.log(`⚠️ Meta Ads error on campaign ${campaignId}: ${e.message}`);
          }
        }
        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: `${sheetName}!${getColumnLetter(col)}${metaRows[period]}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[Math.round(totalSpend * 100) / 100]] },
        });
      }

      // Shopify
      if (shopifyToken && shopUrl && version) {
        let orders = [];
        let totalSales = 0;
        let pageUrl = `${shopUrl}/admin/api/${version}/orders.json?created_at_min=${since}&created_at_max=${until}&status=any&limit=250`;
        try {
          while (pageUrl) {
            const response = await fetch(pageUrl, {
              method: 'GET',
              headers: { 'X-Shopify-Access-Token': shopifyToken }
            });
            const json = await response.json();
            const data = json.orders || [];
            for (const order of data) {
              for (const item of order.line_items || []) {
                const price = parseFloat(item.price || 0);
                const quantity = parseInt(item.quantity || 1);
                totalSales += price * quantity;
              }
              orders.push(order);
            }
            const linkHeader = response.headers.get('link');
            if (linkHeader && linkHeader.includes('rel="next"')) {
              const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
              pageUrl = match ? match[1] : null;
            } else {
              pageUrl = null;
            }
          }
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            requestBody: {
              data: [
                {
                  range: `${sheetName}!${getColumnLetter(col)}${shopifyRows.sales[period]}`,
                  values: [[Math.round(totalSales * 100) / 100]]
                },
                {
                  range: `${sheetName}!${getColumnLetter(col)}${shopifyRows.orders[period]}`,
                  values: [[orders.length]]
                }
              ],
              valueInputOption: 'RAW'
            }
          });
        } catch (e) {
          console.log(`⚠️ Shopify error: ${e.message}`);
        }
      }
    }
    const delay = randomDelay();
    console.log(`⏳ Esperando ${delay / 1000} segundos antes de continuar con la próxima columna...`);
    await sleep(delay);
  }
  console.log("✅ Script ejecutado correctamente.");
}

app.get('/', async (req, res) => {
  try {
    const mode = req.query.mode || 'current';
    await run(mode);
    res.send(`✅ Script ejecutado correctamente con mode=${mode}`);
  } catch (err) {
    console.error(err);
    res.status(500).send(`❌ Hubo un error al ejecutar el script.<br><br><pre>${err.message}</pre><pre>${err.stack}</pre>`);
  }
});

app.listen(port, () => {
  console.log(`🟢 Servidor escuchando en el puerto ${port}`);
});
