const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Telegram Bot configuration
const BOT_TOKEN = '8460494431:AAFOmSEPrzQ1j4_L-4vBG_c38iL2rfx41us';
const CHAT_ID = 8334777900;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('.'));

// Initialize SQLite database
const db = new sqlite3.Database('subscriptions.db');

// Create tables
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_name TEXT NOT NULL,
            customer_email TEXT NOT NULL,
            product_name TEXT NOT NULL,
            product_id INTEGER NOT NULL,
            subscription_months INTEGER NOT NULL,
            purchase_date DATETIME NOT NULL,
            is_active INTEGER DEFAULT 1
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subscription_id INTEGER NOT NULL,
            reminder_date DATETIME NOT NULL,
            reminder_type TEXT NOT NULL,
            is_sent INTEGER DEFAULT 0,
            FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
        )
    `);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_name TEXT NOT NULL,
            customer_email TEXT NOT NULL,
            review_text TEXT NOT NULL,
            rating INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(customer_email)
        )
    `);
});

// API endpoint to receive subscription purchases
app.post('/api/subscription', (req, res) => {
    const { item, name, email } = req.body;
    
    if (!item || !name || !email) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const purchaseDate = new Date();
    
    // Insert subscription into database
    const stmt = db.prepare(`
        INSERT INTO subscriptions (customer_name, customer_email, product_name, product_id, subscription_months, purchase_date)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run([name, email, item.title, item.id, item.months || 1, purchaseDate.toISOString()], function(err) {
        if (err) {
            console.error('Error inserting subscription:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        const subscriptionId = this.lastID;
        
        // Generate reminders based on subscription type
        generateReminders(subscriptionId, item.id, item.months || 1, purchaseDate);
        
        res.json({ success: true, subscription_id: subscriptionId });
    });
    
    stmt.finalize();
});

// Test endpoint - simulates Andrey's subscription scenario
app.post('/api/test-andrey', async (req, res) => {
    // Simulate purchase date: October 2 at 22:03
    const purchaseDate = new Date('2024-10-02T22:03:00');
    
    // Create test subscription for Andrey
    const stmt = db.prepare(`
        INSERT INTO subscriptions (customer_name, customer_email, product_name, product_id, subscription_months, purchase_date)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(['Андрей', 'porkcity@gmail.com', 'Chat-GPT Plus', 1, 3, purchaseDate.toISOString()], async function(err) {
        if (err) {
            console.error('Error creating test subscription:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        const subscriptionId = this.lastID;
        
        // Create reminders as they would be created for real subscription
        // But set the first reminder to trigger in 1 minute for testing
        const testReminderDate = new Date();
        testReminderDate.setMinutes(testReminderDate.getMinutes() + 1); // Test reminder in 1 minute
        
        // Create first reminder (2 months remaining) - set to trigger in 1 minute for test
        db.run(`
            INSERT INTO reminders (subscription_id, reminder_date, reminder_type)
            VALUES (?, ?, ?)
        `, [subscriptionId, testReminderDate.toISOString(), 'renewal_2months'], async (err) => {
            if (err) {
                console.error('Error creating test reminder:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            // Also send a test message immediately to show the format (correct declension)
            const testMessage = `⏰ Продлить подписку Chat-GPT Plus Андрей porkcity@gmail.com 2 месяца до окончания подписки`;
            const telegramSent = await sendTelegramMessage(testMessage);
            
            res.json({ 
                success: true, 
                message: 'Test subscription created for Andrey',
                subscription_id: subscriptionId,
                purchase_date: purchaseDate.toISOString(),
                test_reminder_time: testReminderDate.toISOString(),
                telegram_sent: telegramSent,
                telegram_message: testMessage,
                note: telegramSent 
                    ? 'Telegram message sent successfully! You should receive another notification in ~1 minute.'
                    : 'Telegram message failed. Check server logs for details.'
            });
        });
    });
    
    stmt.finalize();
});

// Test endpoint - creates a test subscription with reminder in 2 minutes
app.post('/api/test-reminder', (req, res) => {
    const testPurchaseDate = new Date();
    const testReminderDate = new Date();
    testReminderDate.setMinutes(testReminderDate.getMinutes() + 2); // Reminder in 2 minutes
    
    // Create test subscription
    const stmt = db.prepare(`
        INSERT INTO subscriptions (customer_name, customer_email, product_name, product_id, subscription_months, purchase_date)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(['Тестовый', 'test@test.com', 'Chat-GPT', 1, 1, testPurchaseDate.toISOString()], function(err) {
        if (err) {
            console.error('Error creating test subscription:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        const subscriptionId = this.lastID;
        
        // Create test reminder
        db.run(`
            INSERT INTO reminders (subscription_id, reminder_date, reminder_type)
            VALUES (?, ?, ?)
        `, [subscriptionId, testReminderDate.toISOString(), 'renewal_5months'], (err) => {
            if (err) {
                console.error('Error creating test reminder:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            res.json({ 
                success: true, 
                message: 'Test reminder created',
                subscription_id: subscriptionId,
                reminder_time: testReminderDate.toISOString(),
                current_time: new Date().toISOString(),
                note: 'You should receive a Telegram notification in ~2 minutes'
            });
        });
    });
    
    stmt.finalize();
});

// API endpoint to verify email exists in orders
app.post('/api/review/verify', (req, res) => {
    const { email } = req.body;
    
    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }
    
    // Check if email exists in subscriptions
    db.get(`
        SELECT COUNT(*) as count 
        FROM subscriptions 
        WHERE customer_email = ?
    `, [email], (err, row) => {
        if (err) {
            console.error('Error checking email:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (row.count > 0) {
            // Check if review already exists
            db.get(`
                SELECT COUNT(*) as count 
                FROM reviews 
                WHERE customer_email = ?
            `, [email], (err, reviewRow) => {
                if (err) {
                    console.error('Error checking review:', err);
                    return res.status(500).json({ error: 'Database error' });
                }
                
                if (reviewRow.count > 0) {
                    return res.json({ 
                        success: false, 
                        error: 'Вы уже оставили отзыв для этого email',
                        can_review: false 
                    });
                }
                
                res.json({ 
                    success: true, 
                    can_review: true,
                    message: 'Email найден. Вы можете оставить отзыв.' 
                });
            });
        } else {
            res.json({ 
                success: false, 
                error: 'Email не найден в системе. Проверьте правильность введенного адреса.',
                can_review: false 
            });
        }
    });
});

// API endpoint to submit review
app.post('/api/review', (req, res) => {
    const { name, email, text, rating } = req.body;
    
    if (!name || !email || !text || !rating) {
        return res.status(400).json({ error: 'Все поля обязательны для заполнения' });
    }
    
    // First verify email exists in subscriptions
    db.get(`
        SELECT COUNT(*) as count 
        FROM subscriptions 
        WHERE customer_email = ?
    `, [email], (err, row) => {
        if (err) {
            console.error('Error checking email:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (row.count === 0) {
            return res.status(400).json({ 
                success: false,
                error: 'Email не найден в системе. Проверьте правильность введенного адреса.' 
            });
        }
        
        // Check if review already exists
        db.get(`
            SELECT COUNT(*) as count 
            FROM reviews 
            WHERE customer_email = ?
        `, [email], (err, reviewRow) => {
            if (err) {
                console.error('Error checking review:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            if (reviewRow.count > 0) {
                return res.status(400).json({ 
                    success: false,
                    error: 'Вы уже оставили отзыв для этого email. Один заказ = один отзыв.' 
                });
            }
            
            // Insert review
            const stmt = db.prepare(`
                INSERT INTO reviews (customer_name, customer_email, review_text, rating)
                VALUES (?, ?, ?, ?)
            `);
            
            stmt.run([name, email, text, rating], function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint')) {
                        return res.status(400).json({ 
                            success: false,
                            error: 'Вы уже оставили отзыв для этого email.' 
                        });
                    }
                    console.error('Error inserting review:', err);
                    return res.status(500).json({ error: 'Database error' });
                }
                
                res.json({ 
                    success: true, 
                    message: 'Отзыв успешно отправлен',
                    review_id: this.lastID 
                });
            });
            
            stmt.finalize();
        });
    });
});

// Generate reminders for a subscription
function generateReminders(subscriptionId, productId, months, purchaseDate) {
    console.log(`Generating reminders for subscription ${subscriptionId}, product ${productId}, ${months} months`);
    
    // Get original purchase time (hour and minutes)
    const purchaseHour = purchaseDate.getHours();
    const purchaseMinute = purchaseDate.getMinutes();
    
    // Calculate reminder time: 1 hour before purchase time
    let reminderHour = purchaseHour - 1;
    let reminderMinute = purchaseMinute;
    
    // Handle case when purchase was at midnight (hour 0)
    if (reminderHour < 0) {
        reminderHour = 23;
    }
    
    if (productId === 3) {
        // Adobe: fixed subscription periods
        if (months === 12) {
            // Year subscription: two 6-month purchases
            const firstRenewal = new Date(purchaseDate);
            firstRenewal.setMonth(firstRenewal.getMonth() + 6);
            firstRenewal.setHours(reminderHour, reminderMinute, 0, 0);
            insertReminder(subscriptionId, firstRenewal, 'renewal_6months');
            
            const secondRenewal = new Date(purchaseDate);
            secondRenewal.setMonth(secondRenewal.getMonth() + 12);
            secondRenewal.setHours(reminderHour, reminderMinute, 0, 0);
            insertReminder(subscriptionId, secondRenewal, 'expiry');
        } else {
            // 1, 3, or 6 months: one purchase
            const expiry = new Date(purchaseDate);
            expiry.setMonth(expiry.getMonth() + months);
            expiry.setHours(reminderHour, reminderMinute, 0, 0);
            insertReminder(subscriptionId, expiry, 'expiry');
        }
    } else if (productId === 1 || productId === 7) {
        // ChatGPT and CapCut: monthly renewals
        for (let i = 1; i <= months; i++) {
            const renewalDate = new Date(purchaseDate);
            renewalDate.setMonth(renewalDate.getMonth() + i);
            renewalDate.setHours(reminderHour, reminderMinute, 0, 0);
            
            const monthsRemaining = months - i;
            const reminderType = monthsRemaining > 0 ? `renewal_${monthsRemaining}months` : 'expiry';
            
            insertReminder(subscriptionId, renewalDate, reminderType);
        }
    }
}

// Insert a reminder into the database
function insertReminder(subscriptionId, reminderDate, reminderType) {
    const stmt = db.prepare(`
        INSERT INTO reminders (subscription_id, reminder_date, reminder_type)
        VALUES (?, ?, ?)
    `);
    
    stmt.run([subscriptionId, reminderDate.toISOString(), reminderType], (err) => {
        if (err) {
            console.error('Error inserting reminder:', err);
        }
    });
    
    stmt.finalize();
}

// Send Telegram message
async function sendTelegramMessage(message) {
    try {
        console.log('Attempting to send Telegram message to chat:', CHAT_ID);
        console.log('Message:', message);
        const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log('Telegram message sent successfully:', response.data);
        return true;
    } catch (error) {
        console.error('Error sending Telegram message:');
        console.error('Status:', error.response?.status);
        console.error('Data:', error.response?.data);
        console.error('Message:', error.message);
        return false;
    }
}

// Format reminder message
function formatReminderMessage(subscription, reminderType) {
    const monthsRemaining = parseInt(reminderType.split('_')[1]) || 0;
    const productName = subscription.product_name;
    
    // Правильное склонение месяцев в русском языке
    let monthWord = 'месяцев';
    if (monthsRemaining === 1) {
        monthWord = 'месяц';
    } else if (monthsRemaining >= 2 && monthsRemaining <= 4) {
        monthWord = 'месяца';
    }
    
    if (reminderType === 'expiry') {
        return `🔴 У ${subscription.customer_name} ${subscription.customer_email} закончилась подписка на ${productName}`;
    } else {
        return `⏰ Продлить подписку ${productName} ${subscription.customer_name} ${subscription.customer_email} ${monthsRemaining} ${monthWord} до окончания подписки`;
    }
}

// Cron job to check and send reminders (runs every minute)
cron.schedule('* * * * *', async () => {
    const now = new Date();
    const nowISO = now.toISOString().split('.')[0].replace('T', ' ');
    
    // Find reminders that are due
    db.all(`
        SELECT r.id, r.subscription_id, r.reminder_type, s.customer_name, s.customer_email, s.product_name
        FROM reminders r
        JOIN subscriptions s ON r.subscription_id = s.id
        WHERE r.is_sent = 0 
        AND datetime(r.reminder_date) <= datetime(?)
        AND s.is_active = 1
    `, [nowISO], async (err, reminders) => {
        if (err) {
            console.error('Error querying reminders:', err);
            return;
        }
        
        for (const reminder of reminders) {
            const message = formatReminderMessage(reminder, reminder.reminder_type);
            const sent = await sendTelegramMessage(message);
            
            if (sent) {
                // Mark reminder as sent
                db.run('UPDATE reminders SET is_sent = 1 WHERE id = ?', [reminder.id], (err) => {
                    if (err) {
                        console.error('Error updating reminder:', err);
                    } else {
                        console.log(`Reminder ${reminder.id} marked as sent`);
                    }
                });
            }
        }
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Subscription reminders scheduled');
});

// Graceful shutdown
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err);
        } else {
            console.log('Database connection closed');
        }
        process.exit(0);
    });
});

