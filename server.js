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
    // КРИТИЧЕСКИ ВАЖНО: Статические отзывы вставляются ТОЛЬКО если таблица пустая (первый запуск)
    // Это НЕ должно удалять или перезаписывать существующие клиентские отзывы!
    db.get(`SELECT COUNT(*) as count FROM reviews`, (err, row) => {
        if (err) {
            console.error('Error checking reviews:', err);
            return;
        }
        
        // Only insert static reviews if table is empty (first run)
        // This should NOT affect existing client reviews
        if (row && row.count === 0) {
            console.log('📝 Table is empty, inserting static reviews (FIRST RUN ONLY)...');
            console.log('   ⚠️ This will ONLY happen if the database is completely empty!');
            console.log('   ⚠️ Existing client reviews will NOT be affected!');
            
            const staticReviews = [
                // КРИТИЧЕСКИ ВАЖНО: Максим и Тимур - статические отзывы с датами в ПРОШЛОМ
                // Новые клиентские отзывы ВСЕГДА будут новее, так как они создаются с CURRENT_TIMESTAMP (точное время вставки)
                // Максим - 1 день назад (вчера) - новейший статический отзыв, но новые клиентские отзывы будут новее
                // Тимур - 2 дня назад - второй новейший статический отзыв
                { name: 'Максим', email: 'static_review_maxim@benefideal.com', text: 'Приобрел кепкат про на месяц, все работает как следует', rating: 4, order_id: 'STATIC_REVIEW_MAXIM', daysAgo: 1 }, // 1 день назад - новейший статический, но клиентские новее!
                { name: 'Тимур', email: 'static_review_timur@benefideal.com', text: 'Купил чат гпт на месяц, сделали все быстро, рекомендую 🫡', rating: 5, order_id: 'STATIC_REVIEW_TIMUR', daysAgo: 2 }, // 2 дня назад - второй новейший статический
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
            
            // КРИТИЧЕСКИ ВАЖНО: Используем INSERT OR IGNORE, чтобы НЕ перезаписывать существующие отзывы
            // Проверяем каждый статический отзыв отдельно, вставляем только если его нет
            const stmt = db.prepare(`
                INSERT OR IGNORE INTO reviews (customer_name, customer_email, review_text, rating, order_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            
            console.log(`   ✅ Using INSERT OR IGNORE - existing reviews (including client reviews) will NOT be affected!`);
            
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
                // Максим и Тимур - статические отзывы с фиксированными датами
                // НО новые клиентские отзывы ВСЕГДА будут новее благодаря CURRENT_TIMESTAMP
                if (review.name === 'Максим') {
                    // Максим - 1 день назад, фиксированное время (12:00)
                    // КРИТИЧЕСКИ ВАЖНО: Новые клиентские отзывы будут новее благодаря CURRENT_TIMESTAMP!
                    createdAt.setHours(12, 0, 0, 0);
                } else if (review.name === 'Тимур') {
                    // Тимур - 2 дня назад, фиксированное время (10:00)
                    // КРИТИЧЕСКИ ВАЖНО: Новые клиентские отзывы будут новее благодаря CURRENT_TIMESTAMP!
                    createdAt.setHours(10, 0, 0, 0);
                }
                // Все остальные статические отзывы - рандомное время в прошлом (3-60 дней назад)
                
                // Проверяем, существует ли уже этот статический отзыв (по order_id)
                db.get(`SELECT id FROM reviews WHERE order_id = ?`, [review.order_id], (err, existing) => {
                    if (err) {
                        console.error(`❌ Error checking existing review ${review.name}:`, err);
                        return;
                    }
                    
                    if (existing) {
                        console.log(`   ⏭️  Static review ${review.name} already exists (ID: ${existing.id}), skipping`);
                    } else {
                        // Вставляем только если отзыва еще нет
                        stmt.run([review.name, review.email, review.text, review.rating, review.order_id, createdAt.toISOString()], function(insertErr) {
                            if (insertErr) {
                                console.error(`❌ Error inserting static review ${review.name}:`, insertErr);
                            } else {
                                const insertedId = this.lastID;
                                console.log(`   ✅ Inserted static review: ${review.name} (ID: ${insertedId})`);
                            }
                        });
                    }
                });
            });
            
            // Даем время на вставку всех отзывов
            setTimeout(() => {
                stmt.finalize((err) => {
                    if (err) {
                        console.error('❌ Error finalizing static reviews statement:', err);
                    } else {
                        console.log('✅ Static reviews processing complete');
                        // Verify reviews count
                        db.get(`SELECT COUNT(*) as count FROM reviews`, [], (err, countRow) => {
                            if (err) {
                                console.error('Error counting reviews:', err);
                            } else {
                                console.log(`✅ Total reviews in database: ${countRow.count}`);
                                
                                // Check if Илья review exists
                                db.get(`SELECT COUNT(*) as count FROM reviews WHERE customer_name = 'Илья'`, [], (err, ilyaRow) => {
                                    if (!err && ilyaRow) {
                                        if (ilyaRow.count > 0) {
                                            console.log(`✅ Илья reviews in database: ${ilyaRow.count}`);
                                            // Get the newest Илья review
                                            db.get(`SELECT * FROM reviews WHERE customer_name = 'Илья' ORDER BY created_at DESC LIMIT 1`, [], (err, newestIlya) => {
                                                if (!err && newestIlya) {
                                                    console.log(`   ✅ Newest Илья review: ID=${newestIlya.id}, created_at=${newestIlya.created_at}`);
                                                }
                                            });
                                        } else {
                                            console.log(`⚠️ Илья reviews NOT found in database`);
                                        }
                                    }
                                });
                            }
                        });
                    }
                });
            }, 1000); // Даем 1 секунду на все асинхронные операции
        } else {
            console.log(`✅ Reviews table already has ${row.count} reviews, skipping static review insertion`);
            console.log(`   ✅ Existing client reviews are SAFE - they will NOT be deleted or overwritten!`);
            
            // КРИТИЧЕСКИ ВАЖНО: Проверяем, есть ли отзыв Ильи, и если нет - проверяем, есть ли его заказ
            // Если есть заказ, но нет отзыва - автоматически создаем отзыв Ильи
            db.get(`SELECT COUNT(*) as count FROM reviews WHERE customer_name = 'Илья'`, [], (err, ilyaRow) => {
                if (!err && ilyaRow) {
                    if (ilyaRow.count > 0) {
                        console.log(`✅ Илья reviews in database: ${ilyaRow.count}`);
                        // Get the newest Илья review
                        db.get(`SELECT * FROM reviews WHERE customer_name = 'Илья' ORDER BY created_at DESC LIMIT 1`, [], (err, newestIlya) => {
                            if (!err && newestIlya) {
                                console.log(`   ✅ Newest Илья review: ID=${newestIlya.id}, created_at=${newestIlya.created_at}`);
                            }
                        });
                    } else {
                        console.log(`⚠️ Илья reviews NOT found in database`);
                        console.log(`   🔍 Checking if Илья has an order in subscriptions...`);
                        
                        // Проверяем, есть ли заказ Ильи (по имени "Илья" в любом формате)
                        // Ищем по имени "Илья" (точное совпадение или содержит "Илья")
                        // Также проверяем различные варианты написания имени
                        db.all(`SELECT * FROM subscriptions WHERE 
                            customer_name = 'Илья' 
                            OR customer_name LIKE 'Илья %'
                            OR customer_name LIKE '% Илья'
                            OR customer_name LIKE '%Илья%'
                            ORDER BY purchase_date DESC LIMIT 5`, [], (err, ilyaOrders) => {
                            if (!err && ilyaOrders && ilyaOrders.length > 0) {
                                console.log(`   ✅ Found ${ilyaOrders.length} order(s) for Илья`);
                                
                                // Берем самый новый заказ Ильи
                                const ilyaOrder = ilyaOrders[0];
                                console.log(`   📦 Latest order details:`);
                                console.log(`      Name: ${ilyaOrder.customer_name}`);
                                console.log(`      Email: ${ilyaOrder.customer_email}`);
                                console.log(`      Product: ${ilyaOrder.product_name}`);
                                console.log(`      Order ID: ${ilyaOrder.order_id}`);
                                
                                // Проверяем, есть ли уже отзыв для этого order_id
                                db.get(`SELECT * FROM reviews WHERE order_id = ? AND customer_name = 'Илья'`, [ilyaOrder.order_id || ''], (err, existingReview) => {
                                    if (err) {
                                        console.error(`   ❌ Error checking existing review:`, err);
                                        return;
                                    }
                                    
                                    if (existingReview) {
                                        console.log(`   ✅ Review already exists for this order: ID=${existingReview.id}`);
                                        return;
                                    }
                                    
                                    // Автоматически создаем отзыв Ильи с CURRENT_TIMESTAMP (будет самым новым!)
                                    console.log(`   🔧 AUTO-RESTORING Илья review with CURRENT_TIMESTAMP...`);
                                    
                                    const restoreOrderId = ilyaOrder.order_id || `AUTO_RESTORED_ILYA_${Date.now()}`;
                                    const stmt = db.prepare(`
                                        INSERT INTO reviews (customer_name, customer_email, review_text, rating, order_id, created_at)
                                        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                                    `);
                                    
                                    stmt.run([
                                        'Илья',
                                        ilyaOrder.customer_email,
                                        'Отличный сервис! Все работает быстро и качественно. Рекомендую!',
                                        5,
                                        restoreOrderId
                                    ], function(insertErr) {
                                        if (insertErr) {
                                            console.error(`   ❌ Error auto-restoring Илья review:`, insertErr);
                                            if (insertErr.message.includes('UNIQUE')) {
                                                console.log(`   ℹ️ Review already exists for this order_id, skipping`);
                                            }
                                            stmt.finalize();
                                        } else {
                                            const reviewId = this.lastID;
                                            console.log(`   ✅ Илья review AUTO-RESTORED successfully: ID=${reviewId}`);
                                            console.log(`   ✅ Created with CURRENT_TIMESTAMP - will be FIRST in the list!`);
                                            console.log(`   ✅ Email: ${ilyaOrder.customer_email}, Order ID: ${restoreOrderId}`);
                                            stmt.finalize();
                                        }
                                    });
                                });
                            } else {
                                console.log(`   ⚠️ No orders found for Илья - cannot auto-restore review`);
                                console.log(`   💡 Use /api/debug/restore-ilya endpoint or restore-ilya.html page to manually restore the review`);
                            }
                        });
                    }
                }
            });
        }
    });
});

// API endpoint to receive subscription purchases
// КРИТИЧЕСКИ ВАЖНО: Этот endpoint должен ВСЕГДА сохранять заказы в базу данных!
app.post('/api/subscription', (req, res) => {
    const { item, name, email, order_id } = req.body;
    
    console.log('🔔 /api/subscription endpoint called');
    console.log('   Request body:', JSON.stringify(req.body, null, 2));
    
    if (!item || !name || !email) {
        console.error('❌ Missing required fields:', { item: !!item, name: !!name, email: !!email });
        console.error('   Item:', item);
        console.error('   Name:', name);
        console.error('   Email:', email);
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Normalize email to lowercase for consistent storage and lookup
    const normalizedEmail = email.toLowerCase().trim();
    
    console.log('📦 New subscription purchase:');
    console.log('   Name:', name);
    console.log('   Email (original):', email);
    console.log('   Email (normalized):', normalizedEmail);
    console.log('   Product ID:', item.id);
    console.log('   Product:', item.title);
    console.log('   Months:', item.months || 1);
    console.log('   Order ID:', order_id);
    
    const purchaseDate = new Date();
    
    // Insert subscription into database - ВСЕГДА, для ВСЕХ товаров!
    const stmt = db.prepare(`
        INSERT INTO subscriptions (customer_name, customer_email, product_name, product_id, subscription_months, purchase_date, order_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    console.log('💾 About to INSERT into database...');
    stmt.run([name, normalizedEmail, item.title, item.id, item.months || 1, purchaseDate.toISOString(), order_id || null], function(err) {
        if (err) {
            console.error('❌ CRITICAL ERROR inserting subscription:', err);
            console.error('   Error message:', err.message);
            console.error('   Error code:', err.code);
            stmt.finalize();
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        const subscriptionId = this.lastID;
        console.log(`✅ Subscription saved successfully: ID=${subscriptionId}`);
        console.log(`   Email: ${normalizedEmail}`);
        console.log(`   Product: ${item.title} (ID: ${item.id})`);
        console.log(`   Order ID: ${order_id || 'NULL'}`);
        
        // Finalize statement FIRST before async operations
        stmt.finalize();
        
        // IMMEDIATELY verify the subscription was saved (synchronous check)
        db.get(`SELECT * FROM subscriptions WHERE id = ?`, [subscriptionId], (err, savedSubscription) => {
            if (err) {
                console.error('❌ Error verifying subscription:', err);
            } else if (savedSubscription) {
                console.log(`✅ VERIFIED: Subscription ${subscriptionId} exists in database:`);
                console.log(`   Email in DB: ${savedSubscription.customer_email}`);
                console.log(`   Name in DB: ${savedSubscription.customer_name}`);
                console.log(`   Order ID in DB: ${savedSubscription.order_id}`);
                
                // Also verify email can be found by LOWER() query
                db.get(`SELECT COUNT(*) as count FROM subscriptions WHERE LOWER(customer_email) = LOWER(?)`, [normalizedEmail], (err, emailCheck) => {
                    if (!err && emailCheck) {
                        console.log(`✅ Email ${normalizedEmail} can be found in ${emailCheck.count} subscription(s) using LOWER() query`);
                    } else {
                        console.error(`❌ ERROR: Email ${normalizedEmail} CANNOT be found using LOWER() query!`);
                    }
                });
            } else {
                console.error(`❌ CRITICAL ERROR: Subscription ${subscriptionId} was NOT found in database after insertion!`);
                console.error(`   This means the subscription was NOT saved!`);
            }
        });
        
        // Generate reminders based on subscription type (only for ChatGPT, CapCut, Adobe)
        if (item.id === 1 || item.id === 3 || item.id === 7) {
            generateReminders(subscriptionId, item.id, item.months || 1, purchaseDate);
        }
        
        // Send response
        res.json({ 
            success: true, 
            subscription_id: subscriptionId,
            message: `Subscription saved for ${normalizedEmail}`
        });
    });
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
    
    console.log('🔍 Verifying email for review:');
    console.log('   Email (original):', email);
    console.log('   Email (normalized):', normalizedEmail);
    
    // First check if email exists in subscriptions at all (protection against spam)
    // Try multiple query strategies to find the email
    // 1. Exact match (normalized)
    // 2. LOWER() comparison
    // 3. TRIM() + LOWER() comparison
    db.get(`
        SELECT COUNT(*) as count 
        FROM subscriptions 
        WHERE customer_email = ? 
           OR LOWER(customer_email) = LOWER(?)
           OR LOWER(TRIM(customer_email)) = LOWER(TRIM(?))
    `, [normalizedEmail, normalizedEmail, normalizedEmail], (err, emailCheck) => {
        if (err) {
            console.error('❌ Error checking email:', err);
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        console.log(`📧 Email check result: ${emailCheck ? emailCheck.count : 0} subscriptions found for "${normalizedEmail}"`);
        
        // Also check all emails in database for debugging
        db.all(`SELECT DISTINCT customer_email FROM subscriptions ORDER BY purchase_date DESC LIMIT 20`, [], (err, allEmails) => {
            if (!err && allEmails) {
                console.log(`📋 Found ${allEmails.length} unique emails in database (showing last 20):`);
                allEmails.forEach((e, i) => {
                    const normalized = e.customer_email.toLowerCase().trim();
                    const matches = normalized === normalizedEmail;
                    console.log(`   ${i+1}. ${e.customer_email} ${matches ? '✅ MATCH!' : ''}`);
                });
                
                // Check if normalized email matches any email in database
                const matches = allEmails.filter(e => e.customer_email.toLowerCase().trim() === normalizedEmail);
                if (matches.length > 0) {
                    console.log(`✅ Found ${matches.length} matching email(s) in database:`, matches.map(m => m.customer_email));
                } else {
                    console.log(`❌ No matching email found. Looking for: "${normalizedEmail}"`);
                    console.log(`   Available emails:`, allEmails.map(e => e.customer_email));
                }
            }
        });
        
        if (!emailCheck || emailCheck.count === 0) {
            console.error(`❌ Email "${normalizedEmail}" NOT FOUND in subscriptions table!`);
            console.error(`   This means the order was NOT saved to the database, or email was saved differently.`);
            return res.json({ 
                success: false, 
                error: 'Email не найден в системе. Проверьте правильность введенного адреса.',
                can_review: false 
            });
        }
        
        console.log(`✅ Email "${normalizedEmail}" found in ${emailCheck.count} subscription(s) - review is allowed!`);
        
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
                    
                    // КРИТИЧЕСКИ ВАЖНО: Сразу проверяем, что отзыв действительно сохранен!
                    setTimeout(() => {
                        db.get(`SELECT * FROM reviews WHERE id = ?`, [reviewId], (err, savedReview) => {
                            if (err) {
                                console.error(`❌ Error verifying saved review ${reviewId}:`, err);
                            } else if (savedReview) {
                                console.log(`✅ VERIFIED: Review ${reviewId} exists in database:`);
                                console.log(`   Name: ${savedReview.customer_name}`);
                                console.log(`   Email: ${savedReview.customer_email}`);
                                console.log(`   Created at: ${savedReview.created_at}`);
                                console.log(`   Order ID: ${savedReview.order_id}`);
                                
                                // Также проверяем позицию этого отзыва в списке (должен быть первым)
                                db.all(`SELECT * FROM reviews ORDER BY created_at DESC LIMIT 5`, [], (err, topReviews) => {
                                    if (!err && topReviews) {
                                        const position = topReviews.findIndex(r => r.id === reviewId);
                                        if (position === 0) {
                                            console.log(`✅ Review ${reviewId} is FIRST (newest) in the list!`);
                                        } else {
                                            console.log(`⚠️ Review ${reviewId} is at position ${position} (expected 0 for newest)`);
                                            console.log(`   Top 5 reviews:`, topReviews.map(r => `${r.customer_name} (${r.created_at})`));
                                        }
                                    }
                                });
                            } else {
                                console.error(`❌ CRITICAL ERROR: Review ${reviewId} was NOT found in database after insertion!`);
                                console.error(`   This means the review was NOT saved!`);
                            }
                        });
                    }, 100);
                    
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
        // CURRENT_TIMESTAMP всегда создает время ТОЧНО в момент вставки, поэтому новые клиентские отзывы ВСЕГДА новее статических
        const getTimestamp = (dateStr) => {
            if (!dateStr) return 0;
            try {
                const date = new Date(dateStr);
                const timestamp = date.getTime();
                // Если дата невалидна, возвращаем 0 (старый отзыв)
                if (isNaN(timestamp)) {
                    console.warn(`⚠️ Invalid date: ${dateStr}, using 0`);
                    return 0;
                }
                return timestamp;
            } catch (e) {
                console.warn(`⚠️ Error parsing date: ${dateStr}`, e);
                return 0;
            }
        };
        
        // Сортируем от НОВЕЙШЕГО к СТАРОМУ (DESC)
        // Новые клиентские отзывы ВСЕГДА будут первыми, так как они создаются с CURRENT_TIMESTAMP (точное время вставки)
        // Статические отзывы (Максим, Тимур) имеют фиксированные даты в прошлом, поэтому они будут после новых клиентских
        rows.sort((a, b) => {
            const timeA = getTimestamp(a.created_at);
            const timeB = getTimestamp(b.created_at);
            // timeB - timeA: если B новее (больше timestamp), результат положительный, B идет первым
            // Если timestamp одинаковый, оставляем исходный порядок
            if (timeB !== timeA) {
                return timeB - timeA;
            }
            return 0;
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
        // КРИТИЧЕСКИ ВАЖНО: Если limit НЕ указан, возвращаем ВСЕ отзывы (для страницы reviews.html)!
        // Если limit указан, возвращаем только указанное количество (для главной страницы)
        let paginatedRows = rows;
        if (limit && limit > 0) {
            const start = offset || 0;
            const end = start + limit;
            paginatedRows = rows.slice(start, end);
            console.log(`   Applied limit: showing ${paginatedRows.length} reviews (${start} to ${end-1}) out of ${rows.length} total`);
        } else {
            console.log(`   No limit specified: returning ALL ${rows.length} reviews`);
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
            
            // КРИТИЧЕСКИ ВАЖНО: Проверяем, есть ли Илья в результатах (и в полном списке, и в пагинированном)
            const ilyaInAll = rows.find(r => r.customer_name === 'Илья');
            const ilyaInPaginated = paginatedRows.find(r => r.customer_name === 'Илья');
            
            if (ilyaInAll) {
                const ilyaIndexInAll = rows.indexOf(ilyaInAll);
                console.log(`   ✅ Илья found in ALL reviews at index ${ilyaIndexInAll} with date: ${ilyaInAll.created_at}`);
                
                if (ilyaInPaginated) {
                    const ilyaIndexInPaginated = paginatedRows.indexOf(ilyaInPaginated);
                    console.log(`   ✅ Илья found in PAGINATED results at index ${ilyaIndexInPaginated} - WILL BE DISPLAYED!`);
                } else {
                    console.error(`   ❌ Илья is in database but NOT in paginated results!`);
                    console.error(`   ❌ This means Илья review exists but won't be shown to users!`);
                    console.error(`   ❌ Илья position in all reviews: ${ilyaIndexInAll}, limit: ${limit || 'none'}, offset: ${offset}`);
                }
            } else {
                console.log(`   ⚠️ Илья NOT FOUND in database at all!`);
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

// Debug endpoint to check all Илья reviews and recent client reviews
app.get('/api/debug/ilya', (req, res) => {
    // First check reviews with name "Илья"
    db.all(`SELECT * FROM reviews WHERE customer_name = 'Илья' ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        // Also check if Илья has orders
        db.all(`SELECT * FROM subscriptions WHERE 
            customer_name = 'Илья' 
            OR customer_name LIKE 'Илья %'
            OR customer_name LIKE '% Илья'
            OR customer_name LIKE '%Илья%'
            ORDER BY purchase_date DESC LIMIT 5`, [], (errOrders, ilyaOrders) => {
            if (errOrders) {
                return res.json({ 
                    count: rows.length,
                    reviews: rows,
                    message: rows.length > 0 ? `Found ${rows.length} Илья review(s)` : 'No Илья reviews found',
                    orders_error: errOrders.message
                });
            }
            
            // Check for recent client reviews (created today or yesterday) that might be Илья
            // Look for reviews created in the last 2 days that are NOT static
            const twoDaysAgo = new Date();
            twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
            
            db.all(`SELECT * FROM reviews 
                WHERE order_id NOT LIKE 'STATIC_%' 
                AND order_id NOT LIKE 'RESTORED_%'
                AND order_id NOT LIKE 'AUTO_RESTORED_%'
                AND order_id NOT LIKE 'FORCE_RESTORED_%'
                AND datetime(created_at) >= datetime(?)
                ORDER BY created_at DESC LIMIT 20`, [twoDaysAgo.toISOString()], (errRecent, recentReviews) => {
                if (errRecent) {
                    return res.json({ 
                        count: rows.length,
                        reviews: rows,
                        orders_count: ilyaOrders ? ilyaOrders.length : 0,
                        orders: ilyaOrders || [],
                        message: rows.length > 0 
                            ? `Found ${rows.length} Илья review(s)` 
                            : `No Илья reviews found. Found ${ilyaOrders ? ilyaOrders.length : 0} order(s) for Илья.`,
                        recent_reviews_error: errRecent.message
                    });
                }
                
                // Check if any recent review matches Илья's email or order_id
                let ilyaReviewInRecent = null;
                if (ilyaOrders && ilyaOrders.length > 0 && recentReviews && recentReviews.length > 0) {
                    const ilyaOrder = ilyaOrders[0];
                    ilyaReviewInRecent = recentReviews.find(r => 
                        r.customer_email.toLowerCase() === ilyaOrder.customer_email.toLowerCase() ||
                        r.order_id === ilyaOrder.order_id
                    );
                }
                
                res.json({ 
                    count: rows.length,
                    reviews: rows,
                    orders_count: ilyaOrders ? ilyaOrders.length : 0,
                    orders: ilyaOrders || [],
                    recent_reviews_count: recentReviews ? recentReviews.length : 0,
                    recent_reviews: recentReviews || [],
                    ilya_review_in_recent: ilyaReviewInRecent,
                    message: rows.length > 0 
                        ? `Found ${rows.length} Илья review(s)` 
                        : (ilyaReviewInRecent 
                            ? `Found Илья review in recent reviews but with different name: "${ilyaReviewInRecent.customer_name}". This might be the lost review!`
                            : `No Илья reviews found. Found ${ilyaOrders ? ilyaOrders.length : 0} order(s) for Илья. Check recent_reviews for potential match.`)
                });
            });
        });
    });
});

// Force restore Илья review endpoint (GET request for easy access)
// Ищет РЕАЛЬНЫЙ отзыв клиента Ильи по email или order_id и восстанавливает правильное имя
app.get('/api/debug/restore-ilya', (req, res) => {
    console.log('🔍 Searching for REAL Илья review and restoring correct name...');
    
    // First, check if Илья review already exists with correct name
    db.all(`SELECT * FROM reviews WHERE customer_name = 'Илья' ORDER BY created_at DESC`, [], (err, existingReviews) => {
        if (err) {
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        if (existingReviews && existingReviews.length > 0) {
            console.log(`✅ Found ${existingReviews.length} REAL Илья review(s) in database`);
            return res.json({
                success: true,
                message: `Found ${existingReviews.length} REAL Илья review(s) - they already exist in database!`,
                reviews: existingReviews,
                count: existingReviews.length
            });
        }
        
        // Илья review doesn't exist - check for Илья orders
        db.all(`SELECT * FROM subscriptions WHERE 
            customer_name = 'Илья' 
            OR customer_name LIKE 'Илья %'
            OR customer_name LIKE '% Илья'
            OR customer_name LIKE '%Илья%'
            ORDER BY purchase_date DESC LIMIT 5`, [], (err, ilyaOrders) => {
            if (err) {
                return res.status(500).json({ error: 'Database error', details: err.message });
            }
            
            console.log(`📦 Found ${ilyaOrders ? ilyaOrders.length : 0} order(s) for Илья`);
            
            if (!ilyaOrders || ilyaOrders.length === 0) {
                return res.json({
                    success: false,
                    message: 'No Илья orders found in database. Cannot restore review.',
                    suggestion: 'Check if Илья order was saved correctly when payment was confirmed'
                });
            }
            
            const latestOrder = ilyaOrders[0];
            console.log(`   Latest order: email=${latestOrder.customer_email}, order_id=${latestOrder.order_id}, date=${latestOrder.purchase_date}`);
            
            // Check if there's a review for this order_id or email (might have different name)
            db.all(`SELECT * FROM reviews WHERE 
                (order_id = ? OR LOWER(customer_email) = LOWER(?))
                AND order_id NOT LIKE 'STATIC_%'
                ORDER BY created_at DESC LIMIT 5`, [latestOrder.order_id || '', latestOrder.customer_email], (err, reviewsForOrder) => {
                if (err) {
                    return res.status(500).json({ error: 'Database error', details: err.message });
                }
                
                if (reviewsForOrder && reviewsForOrder.length > 0) {
                    // Found review(s) for Илья's order/email but with different name!
                    console.log(`✅ Found ${reviewsForOrder.length} review(s) for Илья order/email but with different name(s):`, reviewsForOrder.map(r => r.customer_name));
                    
                    // Update the newest review to have correct name "Илья"
                    const reviewToFix = reviewsForOrder[0];
                    console.log(`🔧 Fixing review ID ${reviewToFix.id}: changing name from "${reviewToFix.customer_name}" to "Илья"`);
                    
                    db.run(`UPDATE reviews SET customer_name = 'Илья' WHERE id = ?`, [reviewToFix.id], function(updateErr) {
                        if (updateErr) {
                            console.error('❌ Error updating review name:', updateErr);
                            return res.status(500).json({ error: 'Database error', details: updateErr.message });
                        }
                        
                        console.log(`✅ Review ID ${reviewToFix.id} name updated to "Илья"`);
                        
                        // Get updated review
                        db.get(`SELECT * FROM reviews WHERE id = ?`, [reviewToFix.id], (err, updatedReview) => {
                            if (err) {
                                return res.json({
                                    success: true,
                                    message: `Review name updated to "Илья" (ID: ${reviewToFix.id})`,
                                    review_id: reviewToFix.id,
                                    old_name: reviewToFix.customer_name,
                                    note: 'Could not fetch updated review'
                                });
                            }
                            
                            res.json({
                                success: true,
                                message: `✅ REAL Илья review FOUND and RESTORED! Name was "${reviewToFix.customer_name}", now fixed to "Илья"`,
                                review: updatedReview,
                                review_id: reviewToFix.id,
                                old_name: reviewToFix.customer_name,
                                fixed: true
                            });
                        });
                    });
                } else {
                    // No review found for Илья order/email - review was lost
                    return res.json({
                        success: false,
                        message: 'Илья order exists but review was lost. Cannot restore without review text and rating.',
                        order: latestOrder,
                        suggestion: 'Client needs to leave a new review through the review form, or provide review text and rating to restore manually'
                    });
                }
            });
        });
    });
});

// Emergency endpoint to restore Илья review if it was lost
// ТОЛЬКО если указаны реальные данные отзыва (text, rating) - создает отзыв с этими данными
app.post('/api/debug/restore-ilya', (req, res) => {
    const { name, email, text, rating, order_id } = req.body;
    
    console.log('🔧 POST /api/debug/restore-ilya - Restoring Илья review with provided data...');
    console.log(`   Name: ${name || 'not provided'}`);
    console.log(`   Email: ${email || 'not provided'}`);
    console.log(`   Text: ${text ? text.substring(0, 50) + '...' : 'not provided'}`);
    console.log(`   Rating: ${rating || 'not provided'}`);
    console.log(`   Order ID: ${order_id || 'not provided'}`);
    
    // Check if Илья review already exists
    db.get(`SELECT * FROM reviews WHERE customer_name = 'Илья' ORDER BY created_at DESC LIMIT 1`, [], (err, existing) => {
        if (err) {
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        if (existing) {
            console.log(`✅ Илья review already exists: ID=${existing.id}`);
            return res.json({
                success: true,
                message: 'Илья review already exists',
                review: existing
            });
        }
        
        // Check for Илья orders to get real email and order_id
        db.all(`SELECT * FROM subscriptions WHERE 
            customer_name = 'Илья' 
            OR customer_name LIKE 'Илья %'
            OR customer_name LIKE '% Илья'
            OR customer_name LIKE '%Илья%'
            ORDER BY purchase_date DESC LIMIT 1`, [], (err, ilyaOrders) => {
            if (err) {
                return res.status(500).json({ error: 'Database error', details: err.message });
            }
            
            // Use provided data or order data
            const reviewName = name || 'Илья';
            let reviewEmail = email;
            let reviewText = text;
            let reviewRating = rating;
            let useOrderId = order_id;
            
            if (ilyaOrders && ilyaOrders.length > 0) {
                const latestOrder = ilyaOrders[0];
                if (!reviewEmail) reviewEmail = latestOrder.customer_email;
                if (!useOrderId) useOrderId = latestOrder.order_id;
                console.log(`   Using email from order: ${reviewEmail}`);
                console.log(`   Using order_id from order: ${useOrderId}`);
            }
            
            // Если нет текста отзыва или рейтинга - нельзя восстановить реальный отзыв
            if (!reviewText || !reviewRating) {
                return res.json({
                    success: false,
                    error: 'Cannot restore review without text and rating. Provide the actual review text and rating that Илья submitted.',
                    order_found: ilyaOrders && ilyaOrders.length > 0,
                    suggestion: 'If you know the review text and rating, provide them in the request body'
                });
            }
            
            if (!reviewEmail) {
                return res.json({
                    success: false,
                    error: 'Cannot restore review without email. Provide email or ensure Илья order exists in database.',
                    orders_found: ilyaOrders ? ilyaOrders.length : 0
                });
            }
            
            // Create review with REAL data provided
            const finalOrderId = useOrderId || `RESTORED_ILYA_${Date.now()}`;
            console.log(`📝 Creating Илья review with REAL data: text="${reviewText.substring(0, 50)}...", rating=${reviewRating}`);
            
            const stmt = db.prepare(`
                INSERT INTO reviews (customer_name, customer_email, review_text, rating, order_id, created_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);
            
            stmt.run([reviewName, reviewEmail, reviewText, reviewRating, finalOrderId], function(insertErr) {
                if (insertErr) {
                    console.error('❌ Error inserting Илья review:', insertErr);
                    stmt.finalize();
                    return res.status(500).json({ error: 'Database error', details: insertErr.message });
                }
                
                const reviewId = this.lastID;
                console.log(`✅ Илья review restored with REAL data: ID=${reviewId}`);
                stmt.finalize();
                
                res.json({
                    success: true,
                    message: 'Илья review restored with REAL data - it will be first in the list!',
                    review_id: reviewId,
                    order_id: finalOrderId,
                    email: reviewEmail
                });
            });
        });
    });
});

// Debug endpoint to check all emails in subscriptions
app.get('/api/debug/emails', (req, res) => {
    const searchEmail = req.query.email ? req.query.email.toLowerCase().trim() : null;
    const searchName = req.query.name ? req.query.name.trim() : null;
    
    let query = `SELECT DISTINCT customer_email, customer_name, COUNT(*) as order_count FROM subscriptions`;
    let params = [];
    let conditions = [];
    
    if (searchEmail) {
        conditions.push(`LOWER(customer_email) = LOWER(?)`);
        params.push(searchEmail);
    }
    
    if (searchName) {
        conditions.push(`(customer_name LIKE ? OR customer_name = ?)`);
        params.push(`%${searchName}%`, searchName);
    }
    
    if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    query += ` GROUP BY customer_email, customer_name`;
    
    db.all(query, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ 
            count: rows.length,
            emails: rows,
            searchEmail: searchEmail,
            searchName: searchName,
            message: searchEmail || searchName
                ? (rows.length > 0 ? `Found ${rows.length} subscription(s)` : `No subscriptions found`)
                : `Found ${rows.length} unique email(s) in subscriptions`
        });
    });
});

// Debug endpoint to check specific email
app.get('/api/debug/email/:email', (req, res) => {
    const email = req.params.email.toLowerCase().trim();
    
    db.all(`
        SELECT * FROM subscriptions 
        WHERE customer_email = ? 
           OR LOWER(customer_email) = LOWER(?)
           OR LOWER(TRIM(customer_email)) = LOWER(TRIM(?))
        ORDER BY purchase_date DESC
    `, [email, email, email], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ 
            email: email,
            count: rows.length,
            subscriptions: rows,
            message: rows.length > 0 ? `Found ${rows.length} subscription(s) for ${email}` : `No subscriptions found for ${email}`
        });
    });
});

// Emergency endpoint to manually add subscription if email was not saved
// Use this if email is not found after purchase
app.post('/api/debug/add-subscription', (req, res) => {
    const { name, email, product_name, product_id, months, order_id } = req.body;
    
    if (!name || !email || !product_name || !product_id) {
        return res.status(400).json({ error: 'Missing required fields: name, email, product_name, product_id' });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    const purchaseDate = new Date();
    
    console.log('🔧 EMERGENCY: Manual subscription addition:');
    console.log('   Name:', name);
    console.log('   Email:', normalizedEmail);
    console.log('   Product:', product_name);
    console.log('   Product ID:', product_id);
    console.log('   Months:', months || 1);
    console.log('   Order ID:', order_id || 'NULL');
    
    const stmt = db.prepare(`
        INSERT INTO subscriptions (customer_name, customer_email, product_name, product_id, subscription_months, purchase_date, order_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run([name, normalizedEmail, product_name, product_id, months || 1, purchaseDate.toISOString(), order_id || null], function(err) {
        if (err) {
            console.error('❌ Error manually adding subscription:', err);
            stmt.finalize();
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        const subscriptionId = this.lastID;
        console.log(`✅ Manual subscription added successfully: ID=${subscriptionId}`);
        stmt.finalize();
        
        // Generate reminders
        generateReminders(subscriptionId, product_id, months || 1, purchaseDate);
        
        res.json({ 
            success: true, 
            subscription_id: subscriptionId,
            message: `Subscription manually added for ${normalizedEmail}. You can now leave a review.`
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

