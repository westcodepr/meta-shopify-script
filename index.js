//codigo final
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

// ---------- Zona horaria de la tienda ----------
function offsetFromTimeZone(timeZone, date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'shortOffset'
    }).formatToParts(date);
    const tzName = parts.find(p => p.type === 'timeZoneName')?.value || ''; // p.ej. "GMT-4"
    const m = tzName.match(/(GMT|UTC)([+-]\d{1,2})(?::?(\d{2}))?/i);
    if (m) {
      const sign = m[2].startsWith('-') ? '-' : '+';
      const hh = String(Math.abs(parseInt(m[2], 10))).padStart(2, '0');
      const mm = m[3] ? m[3] : '00';
      return `${sign}${hh}:${mm}`;
    }
  } catch {}
  return '+00:00';
}

function makeRangeForDate(dateStr, timeZone) {
  // Usamos mediodía para obtener el offset del día (DST-safe)
  const probeUtc = new Date(`${dateStr}T12:00:00Z`);
  const off = offsetFromTimeZone(timeZone, probeUtc);
  return {
    min: `${dateStr}T00:00:00${off}`,
    max: `${dateStr}T23:59:59${off}`,
    offset: off
  };
}

function getDateRange(period) {
  // Igual que tu lógica original (la zona fina la ajustamos arriba)
  const tzOffset = -4 * 60;
  const now = new Date(new Date().getTime() + tzOffset * 60000);
  let since = "", until = now.toISOString().split('T')[0];

  const mondayOfThisWeek = new Date(now);
  mondayOfThisWeek.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));

  if (period === 'week') {
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

async function getShopTimeZone(shopUrl, version, token) {
  try {
    const r = await fetch(`${shopUrl}/admin/api/${version}/shop.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    if (!r.ok) return null;
    const js = await r.json();
    return js?.shop?.iana_timezone || js?.shop?.timezone || null;
  } catch {
    return null;
  }
}

// ---------- Cálculo robusto de refunds (solo items+tax) ----------
function refundItemsAmount(refund) {
  let items = 0;

  // (A) Preferimos transactions; restamos shipping si viene en refund.shipping.amount
  if (Array.isArray(refund.transactions) && refund.transactions.length) {
    let tx = 0;
    for (const t of refund.transactions) {
      if ((t.kind === 'refund' || t.kind === 'sale_refund') && t.status === 'success') {
        const amt = Math.abs(parseFloat(t.amount ?? '0'));
        if (!isNaN(amt)) tx += amt;
      }
    }
    const ship = refund?.shipping?.amount ? Math.abs(parseFloat(refund.shipping.amount) || 0) : 0;
    items += Math.max(0, tx - ship);
    if (items > 0) return items; // suficiente
  }

  // (B) Fallback: refund_line_items (subtotal + total_tax)
  if (Array.isArray(refund.refund_line_items) && refund.refund_line_items.length) {
    for (const rli of refund.refund_line_items) {
      const subtotal = parseFloat(rli.subtotal ?? rli.subtotal_set?.shop_money?.amount ?? '0') || 0;
      const tax = parseFloat(rli.total_tax ?? rli.total_tax_set?.shop_money?.amount ?? '0') || 0;
      items += Math.abs(subtotal + tax);
    }
    if (items > 0) return items;
  }

  // (C) Último recurso: amount (si lo hay)
  if (refund.amount != null) {
    const amt = Math.abs(parseFloat(refund.amount) || 0);
    items += amt;
  }
  return items;
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
    metaRows = { week: 6, month: 8, year: 10 };
    shopifyRows = {
      sales: { week: 18, month: 20, year: 22 },
      orders: { week: 24, month: 26, year: 28 }
    };
  }

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!A1:ZZ30`,
  });

  const values = data.values;
  const colCount = values[0]?.length || 0;

  for (let col = 1; col < colCount; col++) {
    const metaToken = values[3]?.[col];
    const campaignIdRaw = values[4]?.[col];
    const shopifyToken = values[14]?.[col];
    const shopUrl = values[15]?.[col];
    const version = values[16]?.[col];

    // Zona horaria de la tienda por columna
    let shopTimeZone = 'UTC';
    if (shopifyToken && shopUrl && version) {
      const tz = await getShopTimeZone(shopUrl, version, shopifyToken);
      if (tz) shopTimeZone = tz;
    }

    for (const period of periods) {
      const { since, until } = getDateRange(period);

      // -------- Meta Ads --------
      if (metaToken && campaignIdRaw) {
        const campaignIds = campaignIdRaw.split(',').map(id => id.trim());
        let totalSpend = 0, metaError = false, metaErrorMsg = 'ERROR API (Meta)';

        for (const campaignId of campaignIds) {
          const url = `https://graph.facebook.com/v19.0/${campaignId}/insights?fields=spend&access_token=${metaToken}&time_range[since]=${since}&time_range[until]=${until}&level=campaign&attribution_setting=7d_click_1d_view`;
          try {
            const response = await fetch(url);
            if (!response.ok) { metaError = true; metaErrorMsg = `ERROR API (Meta ${response.status})`; break; }
            const json = await response.json();
            const spend = parseFloat(json?.data?.[0]?.spend || "0");
            if (isNaN(spend)) { metaError = true; metaErrorMsg = 'ERROR API (Meta parse)'; break; }
            totalSpend += spend;
          } catch (e) { metaError = true; metaErrorMsg = 'ERROR API (Meta fetch)'; break; }
        }

        await sheets.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: `${sheetName}!${getColumnLetter(col)}${metaRows[period]}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[ metaError ? metaErrorMsg : Math.round(totalSpend * 100) / 100 ]] }
        });
      }

      // -------- Shopify: Total sales --------
      if (shopifyToken && shopUrl && version) {
        // Construcción de rangos con TZ de la tienda
        const createdStart = makeRangeForDate(since, shopTimeZone);
        const createdEnd   = makeRangeForDate(until, shopTimeZone);
        const createdMin = createdStart.min;
        const createdMax = createdEnd.max;
        const updatedMin = createdMin;
        const updatedMax = createdMax;

        let orders = [];
        let totalSalesPositives = 0; // sum(total_price) de pedidos creados
        let totalRefundsItems = 0;   // solo items+tax (sin shipping)
        let shopifyError = false;
        let shopifyErrorMsg = 'ERROR API (Shopify)';

        // (A) Ventas positivas
        let pageUrl = `${shopUrl}/admin/api/${version}/orders.json?` +
                      `created_at_min=${encodeURIComponent(createdMin)}&created_at_max=${encodeURIComponent(createdMax)}` +
                      `&status=any&limit=250`;
        try {
          while (pageUrl) {
            const response = await fetch(pageUrl, { headers: { 'X-Shopify-Access-Token': shopifyToken } });
            if (!response.ok) { shopifyError = true; shopifyErrorMsg = `ERROR API (Shopify ${response.status})`; break; }
            const json = await response.json();
            const data = json.orders || [];
            for (const order of data) {
              const total = parseFloat(order.total_price ?? "0");
              if (isNaN(total)) { shopifyError = true; shopifyErrorMsg = 'ERROR API (Shopify parse total_price)'; break; }
              totalSalesPositives += total;
              orders.push(order);
            }
            if (shopifyError) break;
            const linkHeader = response.headers.get('link');
            if (linkHeader && linkHeader.includes('rel="next"')) {
              const match = linkHeader.match(/<([^>]+)>\;\s*rel="next"/);
              pageUrl = match ? match[1] : null;
            } else { pageUrl = null; }
          }
        } catch (e) { shopifyError = true; shopifyErrorMsg = 'ERROR API (Shopify fetch ventas)'; }

        // (B) Returns por processed_at (excluyendo shipping)
        if (!shopifyError) {
          let updatedUrl = `${shopUrl}/admin/api/${version}/orders.json?` +
                           `updated_at_min=${encodeURIComponent(updatedMin)}&updated_at_max=${encodeURIComponent(updatedMax)}` +
                           `&status=any&limit=250`;
          try {
            while (updatedUrl) {
              const response = await fetch(updatedUrl, { headers: { 'X-Shopify-Access-Token': shopifyToken } });
              if (!response.ok) { shopifyError = true; shopifyErrorMsg = `ERROR API (Shopify ${response.status} refunds)`; break; }
              const json = await response.json();
              const data = json.orders || [];

              for (const order of data) {
                const refunds = Array.isArray(order.refunds) ? order.refunds : [];
                for (const r of refunds) {
                  const processedAt = r.processed_at ? new Date(r.processed_at) : null;
                  if (!processedAt) continue;
                  const ts = processedAt.getTime();
                  const inRange = ts >= new Date(updatedMin).getTime() && ts <= new Date(updatedMax).getTime();
                  if (!inRange) continue;

                  const itemsAmount = refundItemsAmount(r);
                  totalRefundsItems += itemsAmount;
                }
              }

              const linkHeader = response.headers.get('link');
              if (linkHeader && linkHeader.includes('rel="next"')) {
                const match = linkHeader.match(/<([^>]+)>\;\s*rel="next"/);
                updatedUrl = match ? match[1] : null;
              } else { updatedUrl = null; }
            }
          } catch (e) { shopifyError = true; shopifyErrorMsg = 'ERROR API (Shopify fetch refunds)'; }
        }

        // Escritura
        if (shopifyError) {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            requestBody: {
              data: [
                { range: `${sheetName}!${getColumnLetter(col)}${shopifyRows.sales[period]}`,  values: [[shopifyErrorMsg]] },
                { range: `${sheetName}!${getColumnLetter(col)}${shopifyRows.orders[period]}`, values: [[shopifyErrorMsg]] }
              ],
              valueInputOption: 'RAW'
            }
          });
        } else {
          const totalSales = Math.round((totalSalesPositives - totalRefundsItems) * 100) / 100;
          console.log(`[${period}] tz=${shopTimeZone} off=${createdStart.offset} ventas=${totalSalesPositives.toFixed(2)} returns_items=${totalRefundsItems.toFixed(2)} total=${totalSales.toFixed(2)}`);
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            requestBody: {
              data: [
                { range: `${sheetName}!${getColumnLetter(col)}${shopifyRows.sales[period]}`,  values: [[totalSales]] },
                { range: `${sheetName}!${getColumnLetter(col)}${shopifyRows.orders[period]}`, values: [[orders.length]] }
              ],
              valueInputOption: 'RAW'
            }
          });
        }
      } else {
        // Credenciales faltantes
        const salesRow = shopifyRows.sales[period];
        const ordersRow = shopifyRows.orders[period];
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: sheetId,
          requestBody: {
            data: [
              { range: `${sheetName}!${getColumnLetter(col)}${salesRow}`,  values: [['ERROR API (Shopify creds)']] },
              { range: `${sheetName}!${getColumnLetter(col)}${ordersRow}`, values: [['ERROR API (Shopify creds)']] }
            ],
            valueInputOption: 'RAW'
          }
        });
      }
    }

    const delay = randomDelay();
    console.log(`⏳ Esperando ${delay / 1000} segundos antes de continuar con la próxima columna...`);
    await sleep(delay);
  }

  console.log("✅ Script ejecutado correctamente.");
}

// Health endpoint
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Endpoint de ejecución manual
app.get('/', async (req, res) => {
  try {
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

// Cloud Run bind
app.listen(port, '0.0.0.0', () => {
  console.log(`🟢 Servidor escuchando en el puerto ${port}`);
});
