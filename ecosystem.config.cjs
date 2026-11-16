// PM2 process manager config: keeps the bot running and restarts it on crash (Windows, macOS, Linux).
//   npm install -g pm2
//   npm run build
//   pm2 start ecosystem.config.cjs
//   pm2 logs whatsapp-finance-bot      # QR / pairing code on first run
//   pm2 save                           # remember it; see README for starting on boot
module.exports = {
  apps: [
    {
      name: 'whatsapp-finance-bot',
      script: 'dist/main.js',
      cwd: __dirname,
      instances: 1, // WhatsApp allows one connection per linked device: never scale this up
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
