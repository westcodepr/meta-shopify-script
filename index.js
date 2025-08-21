const express = require('express');
const app = express();
const port = process.env.PORT || 8080;
require('dotenv').config();

const { mainMeta } = require('./services/meta');
const { mainShopify } = require('./services/shopify');

app.get('/', async (req, res) => {
  const mode = req.query.mode || 'current'; // current, lastWeek, lastMonth, lastYear

  try {
    await Promise.all([
      mainMeta(mode),
      mainShopify(mode)
    ]);
    res.status(200).send(`Metrics for mode: ${mode} executed successfully.`);
  } catch (error) {
    console.error('Execution error:', error);
    res.status(500).send('Error executing metrics.');
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

function getDateRange(period) {
  const tzOffset = -4 * 60; // UTC-4
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

module.exports = { getDateRange };
