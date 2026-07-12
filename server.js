const express = require('express');
const bot = require('./bot');
const { initScheduler } = require('./scheduler');
const { PORT } = require('./config');

const app = express();

app.get('/', (req, res) => {
  res.send('Attendance bot is running.');
});

app.listen(PORT, () => {
  console.log(`[server] Đang chạy tại port ${PORT}`);
});

bot
  .launch()
  .then(() => {
    console.log('[bot] Telegram bot đã khởi động.');
    initScheduler(bot);
  })
  .catch((err) => {
    console.error('[bot] Lỗi khởi động bot:', err);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
