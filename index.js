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
  return Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000; // entre 5 y 10 segundos
  return Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000;
}

function getColumnLetter(index) {
@@ -32,52 +32,82 @@
}

function getDateRange(period) {
  const tzOffset = -4 * 60; // UTC-4
  const tzOffset = -4 * 60;
  const now = new Date(new Date().getTime() + tzOffset * 60000);
  let since = "", until = now.toISOString().split('T')[0];

  const mondayOfThisWeek = new Date(now);
  mondayOfThisWeek.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));

  if (period === 'week') {
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    since = mondayOfThisWeek.toISOString().split('T')[0];
  } else if (period === 'lastWeek') {
    const monday = new Date(mondayOfThisWeek);
    monday.setDate(monday.getDate() - 7);
    const sunday = new Date(mondayOfThisWeek);
    sunday.setDate(sunday.getDate() - 1);
    since = monday.toISOString().split('T')[0];
    until = sunday.toISOString().split('T')[0];
  } else if (period === 'month') {
    since = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  } else if (period === 'lastMonth') {
    const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
    since = firstDay.toISOString().split('T')[0];
    until = lastDay.toISOString().split('T')[0];
  } else if (period === 'year') {
    since = `${now.getFullYear()}-01-01`;
  } else if (period === 'lastYear') {
    since = `${now.getFullYear() - 1}-01-01`;
    until = `${now.getFullYear() - 1}-12-31`;
  }

  return { since, until };
}

async function run() {
async function run(mode) {
  const client = await authorize();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const sheetId = process.env.SHEET_ID;
  const sheetName = 'Shopify Meta';

  if (!sheetId) throw new Error('❌ Falta la variable de entorno SHEET_ID.');

  // 🟦 NUEVAS FILAS para Meta Ads
  const metaRows = {
    week: 6,
    month: 8,
    year: 10
  };

  // 🟩 NUEVAS FILAS para Shopify
  const shopifyRows = {
    sales: {
      week: 18,
      month: 20,
      year: 22
    },
    orders: {
      week: 24,
      month: 26,
      year: 28
    }
  };
  let periods, metaRows, shopifyRows;

  if (mode === 'lastWeek') {
    periods = ['lastWeek'];
    metaRows = { lastWeek: 7 };
    shopifyRows = {
      sales: { lastWeek: 19 },
      orders: { lastWeek: 25 }
    };
  } else if (mode === 'lastMonth') {
    periods = ['lastMonth'];
    metaRows = { lastMonth: 9 };
    shopifyRows = {
      sales: { lastMonth: 21 },
      orders: { lastMonth: 27 }
    };
  } else if (mode === 'lastYear') {
    periods = ['lastYear'];
    metaRows = { lastYear: 11 };
    shopifyRows = {
      sales: { lastYear: 23 },
      orders: { lastYear: 29 }
    };
  } else {
    periods = ['week', 'month', 'year'];
    metaRows = {
      week: 6,
      month: 8,
      year: 10
    };
    shopifyRows = {
      sales: { week: 18, month: 20, year: 22 },
      orders: { week: 24, month: 26, year: 28 }
    };
  }

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
@@ -91,13 +121,11 @@
    const adAccountId = values[2]?.[col];
    const metaToken = values[3]?.[col];
    const campaignIdRaw = values[4]?.[col];

    // 🔁 FILAS ACTUALIZADAS para credenciales Shopify
    const shopifyToken = values[14]?.[col];
    const shopUrl = values[15]?.[col];
    const version = values[16]?.[col];

    for (const period of ['week', 'month', 'year']) {
    for (const period of periods) {
      const { since, until } = getDateRange(period);

      // Meta Ads
@@ -151,7 +179,7 @@

            const linkHeader = response.headers.get('link');
            if (linkHeader && linkHeader.includes('rel="next"')) {
              const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
              const match = linkHeader.match(/<([^>]+)>;\\s*rel="next"/);
              pageUrl = match ? match[1] : null;
            } else {
              pageUrl = null;
@@ -176,22 +204,6 @@
          });
        } catch (e) {
          console.log(`⚠️ Shopify error: ${e.message}`);
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            requestBody: {
              data: [
                {
                  range: `${sheetName}!${getColumnLetter(col)}${shopifyRows.sales[period]}`,
                  values: [["Error"]]
                },
                {
                  range: `${sheetName}!${getColumnLetter(col)}${shopifyRows.orders[period]}`,
                  values: [["Error"]]
                }
              ],
              valueInputOption: 'RAW'
            }
          });
        }
      }
    }
@@ -206,18 +218,19 @@

app.get('/', async (req, res) => {
  try {
    await run();
    res.send('✅ El script se ejecutó correctamente desde Cloud Run.');
    const mode = req.query.mode || 'current';
    await run(mode);
    res.send(`✅ Script ejecutado correctamente con mode=${mode}`);
  } catch (err) {
    console.error(err);
    res.status(500).send(`
      ❌ Hubo un error al ejecutar el script.<br><br>
      <pre>${err.message}</pre>
      <pre>${err.stack}</pre>
    `);
  }
});

app.listen(port, () => {
  console.log(`🟢 Servidor escuchando en el puerto ${port}`);
});
