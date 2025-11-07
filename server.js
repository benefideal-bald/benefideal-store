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

// Initialize SQLite database FIRST
// IMPORTANT: On Render Free plan, the filesystem is PERSISTENT, but database path matters
// Use __dirname (project root) - this is persistent on Render
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'subscriptions.db');
const fs = require('fs');

console.log('📂 Database initialization:');
console.log('   Current directory (__dirname):', __dirname);
console.log('   Database path:', dbPath);
console.log('   RENDER environment:', process.env.RENDER || 'not set');
console.log('   Database file exists:', fs.existsSync(dbPath));

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('❌ Error opening database:', err);
        console.error('Database path:', dbPath);
        console.error('Current directory:', __dirname);
    } else {
        console.log('✅ Database opened successfully at:', dbPath);
        console.log('✅ Database file exists:', fs.existsSync(dbPath));
        
        // Verify we can write to the database
        db.run('PRAGMA journal_mode=WAL;', (err) => {
            if (err) {
                console.error('❌ Error setting WAL mode:', err);
            } else {
                console.log('✅ WAL mode enabled for better concurrency');
            }
        });
    }
});

// Health check endpoint for Render (prevents timeout, but won't prevent sleep on free plan)
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes must come BEFORE static files
// This ensures /api/* requests are handled by Express, not static files

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
            order_id TEXT,
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
            order_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(customer_email, order_id)
        )
    `);
    
    // Insert static reviews if they don't exist
    db.get(`SELECT COUNT(*) as count FROM reviews`, (err, row) => {
        if (err) {
            console.error('Error checking reviews:', err);
            return;
        }
        
        // Only insert static reviews if table is empty (first run)
        // This should NOT affect existing client reviews
        if (row && row.count === 0) {
            console.log('📝 Table is empty, inserting static reviews...');
            const staticReviews = [
                // Максим и Тимур - статические отзывы (вчера и позавчера) - НЕ новейшие!
                // Новые клиентские отзывы ВСЕГДА будут первыми, так как они создаются с текущей датой/временем
                // Максим и Тимур - НОВЕЙШИЕ отзывы, они ДОЛЖНЫ быть ПЕРВЫМИ!
                // Максим - сегодня (самый новый)
                // Тимур - вчера (второй новейший)
                { name: 'Максим', email: 'static_review_maxim@benefideal.com', text: 'Приобрел кепкат про на месяц, все работает как следует', rating: 4, order_id: 'STATIC_REVIEW_MAXIM', daysAgo: 0 }, // Сегодня - самый новый!
                { name: 'Тимур', email: 'static_review_timur@benefideal.com', text: 'Купил чат гпт на месяц, сделали все быстро, рекомендую 🫡', rating: 5, order_id: 'STATIC_REVIEW_TIMUR', daysAgo: 1 }, // Вчера - второй новейший!
                // Остальные статические отзывы (старше)
                { name: 'София', email: 'static_review_1@benefideal.com', text: 'Заказала CapCut Pro для создания контента в TikTok. Активация прошла за минуты, все функции работают, включая премиум эффекты. Огромная экономия!', rating: 5, order_id: 'STATIC_REVIEW_1', daysAgo: null },
                { name: 'Павел', email: 'static_review_2@benefideal.com', text: 'Прекрасный сервис! ChatGPT Plus работает идеально, быстрые ответы, доступ к GPT-4. Пользуюсь уже месяц, всё стабильно. Обязательно продлю подписку!', rating: 5, order_id: 'STATIC_REVIEW_2', daysAgo: null },
                { name: 'Юлия', email: 'static_review_3@benefideal.com', text: 'Adobe заказала для работы над дизайн-проектами. Photoshop, Illustrator, InDesign — все работает без глюков. Поддержка оперативно отвечает на вопросы. Рекомендую!', rating: 5, order_id: 'STATIC_REVIEW_3', daysAgo: null },
                { name: 'Роман', email: 'static_review_4@benefideal.com', text: 'CapCut Pro стал моим основным редактором. Премиум шаблоны и эффекты открывают новые возможности для творчества. Активация мгновенная, цена приятная!', rating: 5, order_id: 'STATIC_REVIEW_4', daysAgo: null },
                { name: 'Татьяна', email: 'static_review_5@benefideal.com', text: 'ChatGPT Plus использую для написания текстов и исследования. За такие деньги — просто находка! Все возможности GPT-4 доступны, скорость ответов отличная.', rating: 5, order_id: 'STATIC_REVIEW_5', daysAgo: null },
                { name: 'Никита', email: 'static_review_6@benefideal.com', text: 'Adobe Creative Cloud — лучшая покупка! Использую для фриланса. Premiere Pro, After Effects работают без нареканий. Экономия огромная, качество не уступает официальной версии!', rating: 5, order_id: 'STATIC_REVIEW_6', daysAgo: null },
                { name: 'Арина', email: 'static_review_7@benefideal.com', text: 'CapCut Pro покупала для блога в Instagram. Все премиум функции доступны: убираю водяные знаки, использую эксклюзивные эффекты. Сервис на высоте!', rating: 5, order_id: 'STATIC_REVIEW_7', daysAgo: null },
                { name: 'Константин', email: 'static_review_8@benefideal.com', text: 'ChatGPT Plus приобрел для работы над стартапом. AI помощник невероятный! Генерирую идеи, пишу код, анализирую данные. Скорость и качество превосходят ожидания!', rating: 5, order_id: 'STATIC_REVIEW_8', daysAgo: null },
                { name: 'Карина', email: 'static_review_9@benefideal.com', text: 'Adobe заказала для обучения дизайну. Полный доступ ко всем программам по разумной цене. Учеба теперь намного интереснее, все инструменты под рукой!', rating: 5, order_id: 'STATIC_REVIEW_9', daysAgo: null },
                { name: 'Андрей', email: 'static_review_10@benefideal.com', text: 'Купил Adobe Creative Cloud для видеомонтажа. Все программы работают отлично, обновления приходят регулярно. Цена очень выгодная по сравнению с официальной подпиской!', rating: 5, order_id: 'STATIC_REVIEW_10', daysAgo: null },
                { name: 'Алексей', email: 'static_review_11@benefideal.com', text: 'Отличный сервис! Получил данные для ChatGPT Plus буквально через час после оплаты. Всё работает идеально, качество на высоте. Рекомендую!', rating: 5, order_id: 'STATIC_REVIEW_11', daysAgo: null },
                { name: 'Мария', email: 'static_review_12@benefideal.com', text: 'Заказала Adobe Creative Cloud на 3 месяца. Данные пришли очень быстро, всё активировалось без проблем. Поддержка отвечает оперативно. Спасибо!', rating: 5, order_id: 'STATIC_REVIEW_12', daysAgo: null },
                { name: 'Дмитрий', email: 'static_review_13@benefideal.com', text: 'Пользуюсь уже несколько месяцев, всё стабильно работает. Цены очень выгодные по сравнению с официальными подписками. Обязательно буду заказывать снова!', rating: 5, order_id: 'STATIC_REVIEW_13', daysAgo: null },
                { name: 'Елена', email: 'static_review_14@benefideal.com', text: 'Качественный сервис и быстрая выдача данных. CapCut Pro работает отлично, все функции доступны. Очень довольна покупкой!', rating: 5, order_id: 'STATIC_REVIEW_14', daysAgo: null },
                { name: 'Иван', email: 'static_review_15@benefideal.com', text: 'Быстрая обработка заказа, всё четко и по делу. Оплатил, получил данные, активировал, никаких проблем. Сервис на пять звёзд!', rating: 5, order_id: 'STATIC_REVIEW_15', daysAgo: null },
                { name: 'Ольга', email: 'static_review_16@benefideal.com', text: 'Отличные цены и быстрое обслуживание! Получила доступ к Adobe почти сразу после оплаты. Очень рекомендую этот магазин.', rating: 5, order_id: 'STATIC_REVIEW_16', daysAgo: null }
            ];
            
            const stmt = db.prepare(`
                INSERT OR IGNORE INTO reviews (customer_name, customer_email, review_text, rating, order_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            
            staticReviews.forEach((review) => {
                // Максим и Тимур - новейшие (сегодня и вчера), остальные - рандомно за последние 60 дней
                let daysAgo;
                if (review.daysAgo !== null && review.daysAgo !== undefined) {
                    // Явно указано количество дней (для Максима и Тимура)
                    daysAgo = review.daysAgo;
                } else {
                    // Рандомно от 3 до 60 дней назад (не перекрываем Максима и Тимура)
                    daysAgo = Math.floor(Math.random() * 57) + 3;
                }
                
                const createdAt = new Date();
                createdAt.setDate(createdAt.getDate() - daysAgo);
                // Устанавливаем время для Максима и Тимура - они должны быть НОВЕЙШИМИ!
                if (review.name === 'Максим') {
                    // Максим - сегодня, текущее время (самый новый)
                    createdAt.setHours(new Date().getHours(), new Date().getMinutes(), 0, 0);
                } else if (review.name === 'Тимур') {
                    // Тимур - вчера, но ближе к концу дня (второй новейший)
                    createdAt.setHours(23, 59, 0, 0);
                }
                // Все остальные статические отзывы - рандомное время в прошлом
                
                stmt.run([review.name, review.email, review.text, review.rating, review.order_id, createdAt.toISOString()], (err) => {
                    if (err) {
                        console.error(`❌ Error inserting static review ${review.name}:`, err);
                    } else {
                        console.log(`✅ Inserted static review: ${review.name}`);
                    }
                });
            });
            
            stmt.finalize((err) => {
                if (err) {
                    console.error('❌ Error finalizing static reviews statement:', err);
                } else {
                    console.log('✅ Static reviews statement finalized');
                    // Verify static reviews were inserted
                    db.get(`SELECT COUNT(*) as count FROM reviews`, [], (err, countRow) => {
                        if (err) {
                            console.error('Error counting reviews after static insert:', err);
                        } else {
                            console.log(`✅ Total reviews in database after static insert: ${countRow.count}`);
                        }
                    });
                }
            });
        } else {
            console.log(`✅ Reviews table already has ${row.count} reviews, skipping static review insertion`);
            // Check if Илья review exists
            db.get(`SELECT COUNT(*) as count FROM reviews WHERE customer_name = 'Илья'`, [], (err, ilyaRow) => {
                if (!err && ilyaRow) {
                    console.log(`📊 Илья reviews in database: ${ilyaRow.count}`);
                }
            });
        }
    });
});

// API endpoint to receive subscription purchases
app.post('/api/subscription', (req, res) => {
    const { item, name, email, order_id } = req.body;
    
    if (!item || !name || !email) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const purchaseDate = new Date();
    
    // Insert subscription into database
    const stmt = db.prepare(`
        INSERT INTO subscriptions (customer_name, customer_email, product_name, product_id, subscription_months, purchase_date, order_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run([name, email, item.title, item.id, item.months || 1, purchaseDate.toISOString(), order_id || null], function(err) {
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
    
    // Generate test order_id
    const testOrderId = `TEST_ORDER_${Date.now()}`;
    
    // Create test subscription for Andrey
    const stmt = db.prepare(`
        INSERT INTO subscriptions (customer_name, customer_email, product_name, product_id, subscription_months, purchase_date, order_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(['Андрей', 'porkcity@gmail.com', 'Chat-GPT Plus', 1, 3, purchaseDate.toISOString(), testOrderId], async function(err) {
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
    
    // Normalize email to lowercase for case-insensitive comparison
    const normalizedEmail = email.toLowerCase().trim();
    
    console.log('Review verify request for email:', normalizedEmail);
    
    // First check if email exists in subscriptions at all (protection against spam)
    // Use LOWER() for case-insensitive comparison
    db.get(`
        SELECT COUNT(*) as count 
        FROM subscriptions 
        WHERE LOWER(customer_email) = LOWER(?)
    `, [normalizedEmail], (err, emailCheck) => {
        if (err) {
            console.error('Error checking email:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!emailCheck || emailCheck.count === 0) {
            return res.json({ 
                success: false, 
                error: 'Email не найден в системе. Проверьте правильность введенного адреса.',
                can_review: false 
            });
        }
        
        // Check all orders (with or without order_id), get newest first
        // Use LOWER() for case-insensitive comparison
        db.all(`
            SELECT DISTINCT 
                COALESCE(s.order_id, 'NULL_ORDER') as order_id,
                MIN(s.purchase_date) as purchase_date
            FROM subscriptions s
            WHERE LOWER(s.customer_email) = LOWER(?)
            GROUP BY COALESCE(s.order_id, 'NULL_ORDER')
            ORDER BY purchase_date DESC
        `, [normalizedEmail], (err, allOrders) => {
            if (err) {
                console.error('Error checking orders:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            if (!allOrders || allOrders.length === 0) {
                return res.json({ 
                    success: false, 
                    error: 'Email не найден в системе. Проверьте правильность введенного адреса.',
                    can_review: false 
                });
            }
            
            // Get the newest order (first in sorted list)
            const newestOrder = allOrders[0];
            const newestOrderId = newestOrder.order_id === 'NULL_ORDER' ? null : newestOrder.order_id;
            
            // Check if this order already has a review
            let reviewCheckQuery;
            let reviewCheckParams;
            
            if (newestOrderId === null) {
                // For orders without order_id, check reviews with NULL order_id
                reviewCheckQuery = `
                    SELECT COUNT(*) as count 
                    FROM reviews 
                    WHERE LOWER(customer_email) = LOWER(?) AND (order_id IS NULL OR order_id = '')
                `;
                reviewCheckParams = [normalizedEmail];
            } else {
                // For orders with order_id, check reviews with that order_id
                reviewCheckQuery = `
                    SELECT COUNT(*) as count 
                    FROM reviews 
                    WHERE LOWER(customer_email) = LOWER(?) AND order_id = ?
                `;
                reviewCheckParams = [normalizedEmail, newestOrderId];
            }
            
            db.get(reviewCheckQuery, reviewCheckParams, (err, reviewedCheck) => {
                if (err) {
                    console.error('Error checking reviews:', err);
                    return res.status(500).json({ error: 'Database error' });
                }
                
                if (reviewedCheck && reviewedCheck.count > 0) {
                    return res.json({ 
                        success: false, 
                        error: 'Вы уже оставили отзыв для вашего последнего заказа',
                        can_review: false 
                    });
                }
                
                res.json({ 
                    success: true, 
                    can_review: true,
                    message: 'Email найден. Вы можете оставить отзыв.',
                    available_orders: 1
                });
            });
        });
    });
});

// API endpoint to submit review
app.post('/api/review', (req, res) => {
    const { name, email, text, rating } = req.body;
    
    if (!name || !email || !text || !rating) {
        return res.status(400).json({ error: 'Все поля обязательны для заполнения' });
    }
    
    // Normalize email to lowercase for case-insensitive comparison
    const normalizedEmail = email.toLowerCase().trim();
    
    console.log('📨 Review submit request received:');
    console.log('   Name:', name);
    console.log('   Email:', normalizedEmail);
    console.log('   Rating:', rating);
    console.log('   Text length:', text ? text.length : 0);
    
    // First verify email exists in subscriptions at all (protection against spam)
    // Use LOWER() for case-insensitive comparison
    db.get(`
        SELECT COUNT(*) as count 
        FROM subscriptions 
        WHERE LOWER(customer_email) = LOWER(?)
    `, [normalizedEmail], (err, emailCheck) => {
        if (err) {
            console.error('❌ Error checking email:', err);
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        console.log(`📧 Email check result: ${emailCheck ? emailCheck.count : 0} subscriptions found for ${normalizedEmail}`);
        
        if (!emailCheck || emailCheck.count === 0) {
            console.error(`❌ Email ${normalizedEmail} not found in subscriptions`);
            return res.status(400).json({ 
                success: false,
                error: 'Email не найден в системе. Проверьте правильность введенного адреса.' 
            });
        }
        
        // Get all orders (with or without order_id), get newest first
        // Use LOWER() for case-insensitive comparison
        db.all(`
            SELECT DISTINCT 
                COALESCE(s.order_id, 'NULL_ORDER') as order_id,
                MIN(s.purchase_date) as purchase_date
            FROM subscriptions s
            WHERE LOWER(s.customer_email) = LOWER(?)
            GROUP BY COALESCE(s.order_id, 'NULL_ORDER')
            ORDER BY purchase_date DESC
        `, [normalizedEmail], (err, allOrders) => {
            if (err) {
                console.error('Error checking orders:', err);
                return res.status(500).json({ error: 'Database error' });
            }
        
            if (!allOrders || allOrders.length === 0) {
                return res.status(400).json({ 
                    success: false,
                    error: 'У вас нет заказов для отзыва.' 
                });
            }
            
            // Get the newest order (first in sorted list)
            const newestOrder = allOrders[0];
            const newestOrderId = newestOrder.order_id === 'NULL_ORDER' ? null : newestOrder.order_id;
            
            // Check if this order already has a review
            let reviewCheckQuery;
            let reviewCheckParams;
            
            if (newestOrderId === null) {
                // For orders without order_id, check reviews with NULL order_id
                reviewCheckQuery = `
                    SELECT COUNT(*) as count 
                    FROM reviews 
                    WHERE LOWER(customer_email) = LOWER(?) AND (order_id IS NULL OR order_id = '')
                `;
                reviewCheckParams = [normalizedEmail];
            } else {
                // For orders with order_id, check reviews with that order_id
                reviewCheckQuery = `
                    SELECT COUNT(*) as count 
                    FROM reviews 
                    WHERE LOWER(customer_email) = LOWER(?) AND order_id = ?
                `;
                reviewCheckParams = [normalizedEmail, newestOrderId];
            }
            
            db.get(reviewCheckQuery, reviewCheckParams, (err, reviewedCheck) => {
                if (err) {
                    console.error('Error checking reviews:', err);
                    return res.status(500).json({ error: 'Database error' });
                }
                
                if (reviewedCheck && reviewedCheck.count > 0) {
                    return res.status(400).json({ 
                        success: false,
                        error: 'Вы уже оставили отзыв для вашего последнего заказа.' 
                    });
                }
                
                // Insert review with order_id (or NULL if no order_id)
                // Use normalized email for consistency
                // Explicitly set created_at to current timestamp to ensure newest reviews are first
                console.log(`📝 Inserting review: name=${name}, email=${normalizedEmail}, rating=${rating}, order_id=${newestOrderId}`);
                
                // КРИТИЧЕСКИ ВАЖНО: Используем CURRENT_TIMESTAMP чтобы новый отзыв был САМЫМ НОВЫМ и ПЕРВЫМ в списке!
                const stmt = db.prepare(`
                    INSERT INTO reviews (customer_name, customer_email, review_text, rating, order_id, created_at)
                    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                `);
                
                console.log(`📝 Inserting NEW review for ${name} - it will be FIRST in the list (newest first)`);
                
                stmt.run([name, normalizedEmail, text, rating, newestOrderId], function(err) {
                    if (err) {
                        stmt.finalize();
                        if (err.message.includes('UNIQUE constraint')) {
                            console.error(`❌ UNIQUE constraint error for ${name} (${normalizedEmail}):`, err.message);
                            return res.status(400).json({ 
                                success: false,
                                error: 'Вы уже оставили отзыв для этого заказа. Один заказ = один отзыв.' 
                            });
                        }
                        console.error(`❌ Error inserting review for ${name}:`, err);
                        console.error(`❌ Error details:`, err.message, err.stack);
                        return res.status(500).json({ error: 'Database error', details: err.message });
                    }
                    
                    const reviewId = this.lastID;
                    console.log(`✅ Review inserted successfully: ID=${reviewId}, name=${name}, email=${normalizedEmail}, order_id=${newestOrderId}`);
                    console.log(`✅ Last insert rowid: ${reviewId}`);
                    
                    // Finalize statement AFTER getting the ID
                    stmt.finalize();
                    
                    // Immediately verify the review was inserted
                    setTimeout(() => {
                        db.get(`SELECT * FROM reviews WHERE id = ?`, [reviewId], (err, insertedReview) => {
                            if (err) {
                                console.error('❌ Error verifying inserted review:', err);
                            } else if (insertedReview) {
                                console.log(`✅ Verified: Review ${reviewId} exists in database:`);
                                console.log(`   Name: ${insertedReview.customer_name}`);
                                console.log(`   Email: ${insertedReview.customer_email}`);
                                console.log(`   Created: ${insertedReview.created_at}`);
                                console.log(`   Order ID: ${insertedReview.order_id}`);
                            } else {
                                console.error(`❌ CRITICAL ERROR: Review ${reviewId} was NOT found in database after insertion!`);
                                console.error(`   This means the review was NOT saved!`);
                            }
                        });
                    }, 100);
                    
                    // Send response
                    res.json({ 
                        success: true, 
                        message: 'Отзыв успешно отправлен',
                        review_id: reviewId 
                    });
                });
            });
        });
    });
});

// API endpoint to get reviews
app.get('/api/reviews', (req, res) => {
    console.log('GET /api/reviews - Request received');
    console.log('Query params:', req.query);
    
    const limit = req.query.limit ? parseInt(req.query.limit) : null;
    const offset = req.query.offset ? parseInt(req.query.offset) : 0;
    const sortOrder = req.query.sort || 'DESC'; // DESC = newest first (same for both pages)
    
    // Validate sort order - ALWAYS DESC (newest first) for both pages
    const validSort = 'DESC'; // Force DESC - newest first always
    
    // Don't sort in SQL - we'll sort in JavaScript to handle mixed date formats
    // Don't apply LIMIT in SQL - apply it after sorting in JavaScript
    let query = `SELECT * FROM reviews`;
    const params = [];
    
    console.log('Executing query:', query);
    
    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('Error fetching reviews:', err);
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        console.log(`Found ${rows.length} reviews in database`);
        
        // Log all reviews with Илья name before sorting
        const ilyaReviewsBefore = rows.filter(r => r.customer_name === 'Илья');
        if (ilyaReviewsBefore.length > 0) {
            console.log(`🔍 Found ${ilyaReviewsBefore.length} Илья review(s) BEFORE sorting:`, ilyaReviewsBefore.map(r => ({ id: r.id, name: r.customer_name, date: r.created_at, email: r.customer_email })));
        } else {
            console.log(`⚠️ NO Илья reviews found in database! Total reviews: ${rows.length}`);
        }
        
        // КРИТИЧЕСКИ ВАЖНО: Каждый новый отзыв ВСЕГДА должен быть ПЕРВЫМ (сверху)!
        // Сортировка: DESC = новейшие первыми (больший timestamp = новее = идет первым)
        const getTimestamp = (dateStr) => {
            if (!dateStr) return 0;
            try {
                return new Date(dateStr).getTime();
            } catch (e) {
                return 0;
            }
        };
        
        // Сортируем от НОВЕЙШЕГО к СТАРОМУ (DESC)
        // Новые отзывы ВСЕГДА будут первыми, так как они создаются с CURRENT_TIMESTAMP
        rows.sort((a, b) => {
            const timeA = getTimestamp(a.created_at);
            const timeB = getTimestamp(b.created_at);
            // timeB - timeA: если B новее (больше timestamp), результат положительный, B идет первым
            return timeB - timeA;
        });
        
        // Log all reviews with Илья name after sorting
        const ilyaReviewsAfter = rows.filter(r => r.customer_name === 'Илья');
        if (ilyaReviewsAfter.length > 0) {
            ilyaReviewsAfter.forEach((review, index) => {
                const position = rows.indexOf(review);
                console.log(`✅ Илья review AFTER sorting: position=${position}, id=${review.id}, date=${review.created_at}, email=${review.customer_email}`);
            });
        }
        
        // Apply limit and offset after sorting
        let paginatedRows = rows;
        if (limit) {
            const start = offset || 0;
            const end = start + limit;
            paginatedRows = rows.slice(start, end);
        }
        
        // Log first and last review for debugging - ВАЖНО: первый должен быть НОВЕЙШИМ!
        if (paginatedRows.length > 0) {
            console.log(`✅ Reviews sorted DESC (newest first):`);
            console.log(`   FIRST (newest): ${paginatedRows[0].customer_name} - ${paginatedRows[0].created_at}`);
            if (paginatedRows.length > 1) {
                console.log(`   SECOND: ${paginatedRows[1].customer_name} - ${paginatedRows[1].created_at}`);
            }
            if (paginatedRows.length > 2) {
                console.log(`   THIRD: ${paginatedRows[2].customer_name} - ${paginatedRows[2].created_at}`);
            }
            console.log(`   LAST (oldest in this page): ${paginatedRows[paginatedRows.length-1].customer_name} - ${paginatedRows[paginatedRows.length-1].created_at}`);
            
            // Check if Илья is in the results
            const ilyaReview = rows.find(r => r.customer_name === 'Илья');
            if (ilyaReview) {
                const ilyaIndex = rows.indexOf(ilyaReview);
                console.log(`   ✅ Илья found at index ${ilyaIndex} with date: ${ilyaReview.created_at}`);
            } else {
                console.log(`   ⚠️ Илья NOT FOUND in database!`);
            }
        }
        
        res.json({ 
            success: true,
            reviews: paginatedRows,
            count: paginatedRows.length,
            total: rows.length
        });
    });
});

// Debug endpoint to check all Илья reviews
app.get('/api/debug/ilya', (req, res) => {
    db.all(`SELECT * FROM reviews WHERE customer_name = 'Илья' ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ 
            count: rows.length,
            reviews: rows,
            message: rows.length > 0 ? `Found ${rows.length} Илья review(s)` : 'No Илья reviews found'
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

// Auto-ping to prevent sleep on Render free plan (runs every 10 minutes)
// This keeps the server active by making HTTP requests to itself
// Note: This only works if the server is already awake (cron stops when server sleeps)
// For guaranteed uptime, use external service like UptimeRobot
cron.schedule('*/10 * * * *', async () => {
    try {
        // Determine server URL - Render sets RENDER_EXTERNAL_URL or use custom domain
        let serverUrl = process.env.RENDER_EXTERNAL_URL;
        
        if (!serverUrl) {
            // Try to get from custom domain or fallback to localhost for development
            const customDomain = process.env.CUSTOM_DOMAIN || 'benefideal.ru';
            serverUrl = `https://${customDomain}`;
        }
        
        // Only ping if we have a valid URL (not localhost in production)
        if (serverUrl && !serverUrl.includes('localhost')) {
            // Ping health endpoint to keep server awake
            const response = await axios.get(`${serverUrl}/health`, {
                timeout: 10000,
                validateStatus: (status) => status < 500 // Accept any status < 500
            });
            
            console.log(`✅ Auto-ping successful at ${new Date().toISOString()} - Server is awake`);
        } else {
            console.log(`ℹ️ Auto-ping skipped (localhost/dev mode)`);
        }
    } catch (error) {
        // Silently ignore errors (server might be starting up or sleeping)
        // This is expected behavior on free plan
        console.log(`⚠️ Auto-ping failed (this is normal if server is sleeping): ${error.message}`);
    }
});

// Test endpoint to verify server is running
app.get('/api/test', (req, res) => {
    res.json({ 
        success: true, 
        message: 'Server is running!',
        timestamp: new Date().toISOString()
    });
});

// Serve static files AFTER API routes
// This ensures API routes are processed first
app.use(express.static('.'));

// Handle all other routes - serve index.html for SPA
app.get('*', (req, res) => {
    // Don't serve index.html for API routes
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API endpoint not found', path: req.path });
    }
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handler for unhandled errors
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // Don't exit on Render - let it restart
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit on Render - let it restart
});

// Start server - bind to 0.0.0.0 for Render
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Database path: ${dbPath}`);
    console.log('Subscription reminders scheduled');
    console.log('API routes available:');
    console.log('  GET  /api/test - Test endpoint');
    console.log('  GET  /api/reviews - Get reviews');
    console.log('  POST /api/review - Submit review');
    console.log('  POST /api/review/verify - Verify review eligibility');
    console.log('  POST /api/subscription - Submit subscription');
}).on('error', (err) => {
    console.error('❌ Server error:', err);
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use`);
    }
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

