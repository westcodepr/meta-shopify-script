const express = require('express');
const app = express();
const port = process.env.PORT || 8080;

require('dotenv').config();
const { google } = require('googleapis');
const fetch = require('node-fetch');
const pLimit = require('p-limit');

function columnLetter(col) {
  let temp = '';
  let letter = '';
  while (col > 0) {
    temp = (col - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    col = (col - temp - 1) / 26;
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
  let since = '', until = now.toISOString().split('T')[0];

  if (period === 'week') {
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    since = monday.toISOString().split('T')[0];
  } else if (period === 'month') {
    since = `${now.getFullYear()}-${String(now.getMonth() + 1).toString().padStart(2, '0')}-01`;
  } else {
    since = `${now.getFullYear()}-01-01`;
  }

  return { since, until };
}

async function run() {
  const client = await authorize();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const sheetId = process.env.SHEET_ID;
  const sheetName = 'Shopify Meta';

  if (!sheetId) throw new Error('❌ Falta la variable de entorno SHEET_ID.');

  const metaRows = { week: 6, month: 7, year: 8 };
  const shopifyRows = {
    sales: { week: 15, month: 16, year: 17 },
    orders: { week: 18, month: 19, year: 20 }
  };

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!A1:1`,
    majorDimension: 'ROWS'
  });

  const header = headerRes.data.values?.[0] || [];
  const colCount = header.length;
  const endColLetter = columnLetter(colCount);

  const fullDataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!A1:${endColLetter}21`,
  });

  const values = fullDataRes.data.values;
  const limit = pLimit(4);

  const columnTasks = Array.from({ length: colCount - 1 }, (_, i) => i + 1).map((col) =>
    limit(async () => {
      const adAccountId = values[2]?.[col];
      const metaToken = values[3]?.[col];
      const campaignIdRaw = values[4]?.[col];
      const shopifyToken = values[11]?.[col];
      const shopUrl = values[12]?.[col];
      const version = values[13]?.[col];

      for (const period of ['week', 'month', 'year']) {
        const { since, until } = getDateRange(period);

        if (metaToken && campaignIdRaw) {
          const campaignIds = campaignIdRaw.split(',').map(id => id.trim());
          const metaSpend = await Promise.all(campaignIds.map(async (campaignId) => {
            const url = `https://graph.facebook.com/v19.0/${campaignId}/insights?fields=spend&access_token=${metaToken}&time_range[since]=${since}&time_range[until]=${until}&level=campaign&attribution_setting=7d_click_1d_view`;
            try {
              const res = await fetch(url);
              const json = await res.json();
              return parseFloat(json?.data?.[0]?.spend || "0.00");
            } catch (e) {
              console.log(`⚠️ Meta Ads error on campaign ${campaignId}: ${e.message}`);
              return 0;
            }
          }));

          const totalSpend = metaSpend.reduce((sum, val) => sum + val, 0);

          await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: `${sheetName}!${columnLetter(col + 1)}${metaRows[period]}`,
            valueInputOption: 'RAW',
            requestBody: { values: [[Math.round(totalSpend * 100) / 100]] },
          });
        }

        if (shopifyToken && shopUrl && version) {
          let totalSales = 0;
          let orders = [];
          let pageUrl = `${shopUrl}/admin/api/${version}/orders.json?created_at_min=${since}T00:00:00-04:00&created_at_max=${until}T23:59:59-04:00&status=any&limit=250`;

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
              const match = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
              pageUrl = match ? match[1] : null;
            }

            await sheets.spreadsheets.values.batchUpdate({
              spreadsheetId: sheetId,
              requestBody: {
                data: [
                  {
                    range: `${sheetName}!${columnLetter(col + 1)}${shopifyRows.sales[period]}`,
                    values: [[Math.round(totalSales * 100) / 100]]
                  },
                  {
                    range: `${sheetName}!${columnLetter(col + 1)}${shopifyRows.orders[period]}`,
                    values: [[orders.length]]
                  }
                ],
                valueInputOption: 'RAW'
              }
            });
          } catch (e) {
            console.log(`⚠️ Shopify error: ${e.message}`);
            await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: sheetId,
  requestBody: {
    data: [
      {
        range: `${sheetName}!${columnLetter(col + 1)}${shopifyRows.sales[period]}`,
        values: [[`Error: ${e.message}`]]
      },
      {
        range: `${sheetName}!${columnLetter(col + 1)}${shopifyRows.orders[period]}`,
        values: [[`Error: ${e.message}`]]
      }
    ],
    valueInputOption: 'RAW'
  }
});
          }
        }
      }
    })
  );

  await Promise.all(columnTasks);

  console.log("✅ Script ejecutado correctamente.");
}

app.get('/', async (req, res) => {
  try {
    await run();
    res.send('✅ El script se ejecutó correctamente desde Cloud Run.');
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
