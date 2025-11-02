# Benefideal Store

Subscription store with automated Telegram reminders.

## Features

- Modern web store for digital subscriptions
- Automated monthly reminders via Telegram bot
- Support for ChatGPT Plus, Adobe Creative Cloud, and CapCut Pro

## Installation

### 1. Install Node.js

If you don't have Node.js installed:

**On macOS:**
```bash
# Install via Homebrew
brew install node

# Or download from https://nodejs.org/
```

**Verify installation:**
```bash
node --version  # Should be 18.x or higher
npm --version
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start the Server

```bash
npm start
```

The server will run on `http://localhost:3000`

### 4. Open the Website

Open `index.html` in your browser or access `http://localhost:3000`

## How Reminders Work

When a customer purchases a subscription:
1. The purchase details are sent to the backend server
2. Reminder dates are calculated and stored in the database
3. A cron job checks every minute for due reminders
4. Reminders are automatically sent to Telegram at 15:00 (3 PM) local time

### Reminder Types

**ChatGPT & CapCut:**
- Monthly reminders 1 hour before renewal time (15:00)
- Shows months remaining until subscription ends

**Adobe:**
- Fixed period subscriptions (1, 3, 6, or 12 months)
- For 12-month subscriptions: reminder at 6 months and at expiry

## Running in Production

For production deployment:

1. **Use a process manager:**
```bash
npm install -g pm2
pm2 start server.js --name benefideal
pm2 save
```

2. **Set up as a system service** (example for Ubuntu):
```bash
sudo nano /etc/systemd/system/benefideal.service
```

Add this configuration:
```ini
[Unit]
Description=Benefideal Store Server
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/benefideal-store
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

3. **Start the service:**
```bash
sudo systemctl enable benefideal
sudo systemctl start benefideal
```

## Database

The SQLite database (`subscriptions.db`) stores:
- Subscription records
- Reminder schedules
- Sent status for each reminder

## Telegram Bot

The bot is configured with token `8460494431:AAFOmSEPrzQ1j4_L-4vBG_c38iL2rfx41us`
and sends reminders to chat ID `8334777900`.

## License

ISC

