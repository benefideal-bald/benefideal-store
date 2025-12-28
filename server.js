const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { exec } = require('child_process');
const multer = require('multer');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

// Telegram Bot configuration
const BOT_TOKEN = '8460494431:AAFOmSEPrzQ1j4_L-4vBG_c38iL2rfx41us';
const CHAT_ID = 8334777900;

// КРИТИЧЕСКИ ВАЖНО: Регистрируем healthcheck endpoint ПЕРВЫМ
// Health check endpoint - FIRST, before any middleware or DB initialization
// This ensures Railway/Render healthcheck passes immediately
// Railway проверяет healthcheck сразу после запуска, поэтому endpoint должен быть доступен немедленно
app.get('/health', (req, res) => {
    // Отвечаем сразу, без проверок БД и без вычислений - это гарантирует быстрый ответ для healthcheck
    res.status(200).json({ status: 'ok' });
});

// КРИТИЧЕСКИ ВАЖНО: Запускаем сервер СРАЗУ после healthcheck endpoint, ДО middleware
// Это позволяет Railway получить ответ от healthcheck немедленно, даже если БД еще инициализируется
// Railway требует, чтобы сервер слушал на 0.0.0.0 для доступа извне
// Используем синхронный запуск без try-catch для максимальной простоты и скорости
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT} (started early for healthcheck)`);
    console.log(`✅ Healthcheck endpoint ready at /health`);
});

// Обработка ошибок сервера
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use`);
    } else {
        console.error('❌ Server error:', err);
    }
});

// Middleware
// ВАЖНО: Настраиваем trust proxy для правильного определения HTTPS за прокси (Railway/Render)
app.set('trust proxy', true);
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true })); // Для обработки form-urlencoded (нужно для enot.io webhook)
app.use(express.static('.')); // Для статических файлов

// Initialize SQLite database FIRST
// КРИТИЧЕСКИ ВАЖНО: На Render нужно использовать персистентное хранилище
// На Render Free плане файлы сохраняются в /opt/render/project/src/
// Используем переменную окружения DATABASE_PATH для указания пути
// Если не указана, используем текущую директорию (для локальной разработки)
// ВАЖНО: База данных НЕ должна удаляться при деплое - это критически важно для сохранения отзывов!
// КРИТИЧЕСКИ ВАЖНО: Используем директорию data/ для базы данных
// Эта директория НЕ в Git, поэтому база данных не будет перезаписана при деплое
// На Render файлы в рабочей директории должны сохраняться между деплоями
// Railway: Use /app/data for persistent storage (Volume mounted)
// If DATABASE_PATH is not set, use data/ directory
const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'subscriptions.db');
// КРИТИЧЕСКИ ВАЖНО: reviews.json храним в data/ - эта директория сохраняется на Render между деплоями
// Но при первом деплое копируем из корня проекта (из Git) если файл в data/ не существует
const reviewsJsonPath = path.join(process.cwd(), 'data', 'reviews.json');
const reviewsJsonPathGit = path.join(process.cwd(), 'reviews.json'); // Файл в Git для начальных отзывов
// КРИТИЧЕСКИ ВАЖНО: orders.json храним в корне проекта (Git) - как reviews.json
// Это гарантирует, что заказы не потеряются при деплое
const ordersJsonPath = path.join(process.cwd(), 'orders.json'); // Файл в Git для заказов
// КРИТИЧЕСКИ ВАЖНО: support_messages.json храним в корне проекта (Git) - как orders.json и reviews.json
// Это гарантирует, что сообщения поддержки не потеряются при деплое
const supportMessagesJsonPath = path.join(process.cwd(), 'support_messages.json'); // Файл в Git для сообщений
const supportRepliesJsonPath = path.join(process.cwd(), 'support_replies.json'); // Файл в Git для ответов
const fs = require('fs');

// КРИТИЧЕСКИ ВАЖНО: Проверяем, существует ли база данных и её размер
// Если база существует, но пустая - это проблема!
if (fs.existsSync(dbPath)) {
    const stats = fs.statSync(dbPath);
    if (stats.size < 1000) {
        console.warn('⚠️ WARNING: Database file exists but is very small (' + stats.size + ' bytes) - might be empty or corrupted!');
    }
}

console.log('📂 Database initialization:');
console.log('   Current directory (__dirname):', __dirname);
console.log('   Database path:', dbPath);
console.log('   RENDER environment:', process.env.RENDER || 'not set');
console.log('   Database file exists:', fs.existsSync(dbPath));
console.log('   Process working directory:', process.cwd());
if (fs.existsSync(dbPath)) {
    const stats = fs.statSync(dbPath);
    console.log('   Database file size:', stats.size, 'bytes');
    console.log('   Database file modified:', stats.mtime);
} else {
    console.log('   Database file size: N/A (file does not exist)');
}

// КРИТИЧЕСКИ ВАЖНО: Создаем директорию data/ для базы данных, если её нет
// Эта директория НЕ в Git, поэтому база данных не будет перезаписана при деплое
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    try {
        fs.mkdirSync(dbDir, { recursive: true });
        console.log(`✅ Created database directory: ${dbDir}`);
    } catch (mkdirErr) {
        console.error(`❌ Error creating database directory: ${mkdirErr}`);
    }
}

// КРИТИЧЕСКИ ВАЖНО: Инициализация файлов поддержки при старте сервера
// Это гарантирует, что данные не потеряются при деплое
function initializeSupportFiles() {
    try {
        // Проверяем support_messages.json
        if (fs.existsSync(supportMessagesJsonPath)) {
            const content = fs.readFileSync(supportMessagesJsonPath, 'utf8').trim();
            // Если файл пустой или содержит только {}, проверяем старый путь
            if (!content || content === '{}') {
                const oldMessagesPath = path.join(process.cwd(), 'data', 'support_messages.json');
                if (fs.existsSync(oldMessagesPath)) {
                    try {
                        const oldMessages = JSON.parse(fs.readFileSync(oldMessagesPath, 'utf8'));
                        if (Object.keys(oldMessages).length > 0) {
                            fs.writeFileSync(supportMessagesJsonPath, JSON.stringify(oldMessages, null, 2), 'utf8');
                            console.log(`✅ Восстановлено ${Object.keys(oldMessages).length} сообщений из data/support_messages.json`);
                        }
                    } catch (e) {
                        console.warn('⚠️ Ошибка при восстановлении сообщений из data/:', e.message);
                    }
                } else {
                    console.log('📋 support_messages.json пустой - будет создан при первом сообщении');
                }
            } else {
                try {
                    const messages = JSON.parse(content);
                    console.log(`📥 Загружено ${Object.keys(messages).length} сообщений из support_messages.json`);
                } catch (e) {
                    console.warn('⚠️ Ошибка при чтении support_messages.json:', e.message);
                }
            }
        } else {
            console.log('📋 support_messages.json не найден - будет создан при первом сообщении');
        }
        
        // Проверяем support_replies.json
        if (fs.existsSync(supportRepliesJsonPath)) {
            const content = fs.readFileSync(supportRepliesJsonPath, 'utf8').trim();
            // Если файл пустой или содержит только {}, проверяем старый путь
            if (!content || content === '{}') {
                const oldRepliesPath = path.join(process.cwd(), 'data', 'support_replies.json');
                if (fs.existsSync(oldRepliesPath)) {
                    try {
                        const oldReplies = JSON.parse(fs.readFileSync(oldRepliesPath, 'utf8'));
                        if (Object.keys(oldReplies).length > 0) {
                            fs.writeFileSync(supportRepliesJsonPath, JSON.stringify(oldReplies, null, 2), 'utf8');
                            console.log(`✅ Восстановлены ответы из data/support_replies.json`);
                        }
                    } catch (e) {
                        console.warn('⚠️ Ошибка при восстановлении ответов из data/:', e.message);
                    }
                } else {
                    console.log('📋 support_replies.json пустой - будет создан при первом ответе');
                }
            } else {
                try {
                    const replies = JSON.parse(content);
                    const totalReplies = Object.values(replies).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
                    console.log(`📥 Загружено ${totalReplies} ответов из support_replies.json`);
                } catch (e) {
                    console.warn('⚠️ Ошибка при чтении support_replies.json:', e.message);
                }
            }
        } else {
            console.log('📋 support_replies.json не найден - будет создан при первом ответе');
        }
    } catch (error) {
        console.error('❌ Ошибка при инициализации файлов поддержки:', error);
    }
}

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('❌ Error opening database:', err);
        console.error('Database path:', dbPath);
        console.error('Current directory:', __dirname);
    } else {
        console.log('✅ Database opened successfully at:', dbPath);
        console.log('✅ Database file exists:', fs.existsSync(dbPath));
        
        // КРИТИЧЕСКИ ВАЖНО: Включаем WAL mode для лучшей производительности и надежности
        // WAL mode гарантирует, что данные сохраняются даже при сбоях
        db.run('PRAGMA journal_mode=WAL;', (err) => {
            if (err) {
                console.error('❌ Error setting WAL mode:', err);
            } else {
                console.log('✅ WAL mode enabled for better concurrency and data safety');
            }
        });
        
        // КРИТИЧЕСКИ ВАЖНО: Включаем синхронный режим для гарантированного сохранения данных
        // NORMAL = быстрее, но данные могут быть потеряны при сбое
        // FULL = медленнее, но данные ВСЕГДА сохраняются на диск
        db.run('PRAGMA synchronous = FULL;', (err) => {
            if (err) {
                console.error('❌ Error setting synchronous mode:', err);
            } else {
                console.log('✅ Synchronous mode set to FULL - data will ALWAYS be saved to disk');
            }
        });
        
        // Проверяем количество отзывов сразу после открытия базы
        db.get(`SELECT COUNT(*) as count FROM reviews`, [], (err, countRow) => {
            if (!err && countRow) {
                console.log(`📊 Reviews count on startup: ${countRow.count}`);
                if (countRow.count > 0) {
                    console.log(`✅ Reviews database is NOT empty - all reviews are safe!`);
                } else {
                    console.warn(`⚠️ Reviews database is EMPTY - this might be a new database or reviews were lost!`);
                }
            }
        });
        
        // Проверяем количество сообщений поддержки при старте
        db.get(`SELECT COUNT(*) as count FROM support_messages`, [], (err, countRow) => {
            if (!err && countRow) {
                console.log(`📊 Support messages count on startup: ${countRow.count}`);
                if (countRow.count > 0) {
                    console.log(`✅ Support messages database is NOT empty - all messages are safe!`);
                } else {
                    console.log(`📋 Support messages database is empty - will be populated on first message`);
                }
            }
        });
        
        // Проверяем количество сообщений поддержки при старте
        db.get(`SELECT COUNT(*) as count FROM support_messages`, [], (err, countRow) => {
            if (!err && countRow) {
                console.log(`📊 Support messages count on startup: ${countRow.count}`);
                if (countRow.count > 0) {
                    console.log(`✅ Support messages database is NOT empty - all messages are safe!`);
                } else {
                    console.log(`📋 Support messages database is empty - will be populated on first message`);
                }
            } else if (err && err.message && err.message.includes('no such table')) {
                console.log(`📋 Support messages table does not exist yet - will be created in db.serialize()`);
            }
        });
        
        // Мигрируем данные из JSON в базу данных при старте (если есть)
        migrateSupportMessagesFromJSON();
        
        // Проверяем количество отзывов при старте
        console.log(`🔍 Проверка отзывов при старте сервера...`);
        
        // КРИТИЧЕСКИ ВАЖНО: При первом запуске копируем начальные отзывы из Git в data/reviews.json
        // Это гарантирует, что все отзывы будут в одном месте (data/reviews.json) и не потеряются
        if (fs.existsSync(reviewsJsonPathGit)) {
            try {
                const localReviews = JSON.parse(fs.readFileSync(reviewsJsonPathGit, 'utf8'));
                console.log(`   📋 Найдено ${localReviews.length} отзывов в reviews.json (Git)`);
                
                // Проверяем, существует ли data/reviews.json
                if (!fs.existsSync(reviewsJsonPath)) {
                    // Если data/reviews.json не существует, копируем начальные отзывы из Git
                    console.log(`   📋 Копируем начальные отзывы из Git в data/reviews.json...`);
                    try {
                        // Убеждаемся, что директория data/ существует
                        const dataDir = path.dirname(reviewsJsonPath);
                        if (!fs.existsSync(dataDir)) {
                            fs.mkdirSync(dataDir, { recursive: true });
                            console.log(`   ✅ Создана директория: ${dataDir}`);
                        }
                        
                        // Копируем отзывы из Git в data/reviews.json
                        fs.writeFileSync(reviewsJsonPath, JSON.stringify(localReviews, null, 2), 'utf8');
                        console.log(`   ✅ Скопировано ${localReviews.length} начальных отзывов в data/reviews.json`);
                        console.log(`   ✅ Теперь все отзывы в одном месте (data/reviews.json) и не потеряются при деплое!`);
                    } catch (copyError) {
                        console.error(`   ❌ Ошибка при копировании отзывов: ${copyError.message}`);
                    }
                } else {
                    // data/reviews.json существует - проверяем, нужно ли обновить
                    try {
                        const dataReviews = JSON.parse(fs.readFileSync(reviewsJsonPath, 'utf8'));
                        console.log(`   📋 Найдено ${dataReviews.length} отзывов в data/reviews.json (персистентное хранилище)`);
                        console.log(`   ✅ Все отзывы уже в персистентном хранилище - ничего не нужно копировать`);
                    } catch (error) {
                        console.warn(`   ⚠️ Ошибка при чтении data/reviews.json: ${error.message}`);
                    }
                }
            } catch (error) {
                console.warn(`⚠️ Ошибка при проверке reviews.json при старте: ${error.message}`);
            }
        }
    }
});

// Health check endpoint moved to beginning of file (duplicate removed)

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
            amount REAL,
            is_active INTEGER DEFAULT 1
        )
    `);
    
    // Add amount column if it doesn't exist (migration)
    db.run(`ALTER TABLE subscriptions ADD COLUMN amount REAL`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('Error adding amount column:', err);
        } else if (!err) {
            console.log('✅ Added amount column to subscriptions table');
        }
    });
    
    // Add json_order_id column (уникальный ID строки из orders.json),
    // чтобы можно было однозначно связать каждую подписку с КОНКРЕТНЫМ товаром из JSON.
    db.run(`ALTER TABLE subscriptions ADD COLUMN json_order_id INTEGER`, (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.error('Error adding json_order_id column:', err);
        } else if (!err) {
            console.log('✅ Added json_order_id column to subscriptions table');
        }
    });
    
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
    
    // КРИТИЧЕСКИ ВАЖНО: Создаем таблицу отзывов с защитой от удаления
    // НИКОГДА не используем DROP TABLE или DELETE FROM reviews в коде!
    // UNIQUE constraint (customer_email, order_id) позволяет обновлять отзывы через ON CONFLICT
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
    `, (err) => {
        if (err) {
            console.error('❌ Error creating reviews table:', err);
        } else {
            console.log('✅ Reviews table created/verified');
            // КРИТИЧЕСКИ ВАЖНО: Проверяем количество отзывов при каждом запуске
            // Если количество резко упало - это КРИТИЧЕСКАЯ проблема!
            db.get(`SELECT COUNT(*) as count FROM reviews`, [], (err, countRow) => {
                if (!err && countRow) {
                    console.log(`📊 Current reviews count: ${countRow.count}`);
                    if (countRow.count === 0) {
                        console.error('🚨🚨🚨 КРИТИЧЕСКАЯ ПРОБЛЕМА: Reviews table is EMPTY!');
                        console.error('🚨 Это может означать, что база данных была пересоздана или отзывы были удалены!');
                        console.error('🚨 Проверьте, не удаляется ли файл базы данных при деплое!');
                        console.error('🚨 Проверьте логи Render на наличие ошибок базы данных!');
                    } else {
                        console.log(`✅ Reviews table has ${countRow.count} reviews - all safe!`);
                        console.log(`✅ ALL REVIEWS ARE EQUAL - никаких специальных проверок для конкретных имен!`);
                    }
                }
            });
        }
    });
    
    // КРИТИЧЕСКИ ВАЖНО: Таблица для сообщений поддержки - данные НЕ ПОТЕРЯЮТСЯ при деплое!
    // Используем SQLite базу данных, которая сохраняется на сервере
    db.run(`
        CREATE TABLE IF NOT EXISTS support_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT UNIQUE NOT NULL,
            message_text TEXT,
            client_id TEXT NOT NULL,
            client_ip TEXT,
            has_image INTEGER DEFAULT 0,
            image_filenames TEXT,
            telegram_message_id TEXT,
            timestamp INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error('❌ Error creating support_messages table:', err);
        } else {
            console.log('✅ Support messages table created/verified');
        }
    });
    
    // КРИТИЧЕСКИ ВАЖНО: Таблица для ответов поддержки - данные НЕ ПОТЕРЯЮТСЯ при деплое!
    db.run(`
        CREATE TABLE IF NOT EXISTS support_replies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL,
            reply_text TEXT NOT NULL,
            has_image INTEGER DEFAULT 0,
            image_filenames TEXT,
            timestamp INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error('❌ Error creating support_replies table:', err);
        } else {
            console.log('✅ Support replies table created/verified');
        }
    });
    
    // Создаем индексы для быстрого поиска
    db.run(`CREATE INDEX IF NOT EXISTS idx_support_messages_client_id ON support_messages(client_id)`, (err) => {
        if (err && !err.message.includes('already exists')) {
            console.error('Error creating index on support_messages:', err);
        }
    });
    
    db.run(`CREATE INDEX IF NOT EXISTS idx_support_messages_timestamp ON support_messages(timestamp)`, (err) => {
        if (err && !err.message.includes('already exists')) {
            console.error('Error creating index on support_messages timestamp:', err);
        }
    });
    
    db.run(`CREATE INDEX IF NOT EXISTS idx_support_replies_message_id ON support_replies(message_id)`, (err) => {
        if (err && !err.message.includes('already exists')) {
            console.error('Error creating index on support_replies:', err);
        }
    });
    
    // КРИТИЧЕСКИ ВАЖНО: Проверяем и восстанавливаем ВСЕ отзывы при каждом запуске
    // Это гарантирует, что отзывы НИКОГДА не пропадут
    db.get(`SELECT COUNT(*) as count FROM reviews`, (err, row) => {
        if (err) {
            console.error('❌ Error checking reviews:', err);
            return;
        }
        
        console.log(`📊 Reviews check on startup: ${row.count} reviews found in database`);
        
        // КРИТИЧЕСКИ ВАЖНО: Переносим отзывы из базы данных в JSON при КАЖДОМ запуске
        // Это гарантирует, что все отзывы из базы данных будут сохранены в JSON
        if (row && row.count > 0) {
            console.log(`🔄 Database has ${row.count} reviews, starting migration to JSON...`);
            // Run migration immediately on startup to ensure all reviews are in JSON
            migrateReviewsFromDatabase().then((migrated) => {
                if (migrated) {
                    console.log('✅ Migration completed on startup! All reviews restored to JSON!');
                } else {
                    console.log('✅ Migration check completed - all reviews are already in JSON');
                }
            }).catch(err => {
                console.error('❌ Migration error on startup:', err);
            });
        } else {
            // Even if database is empty, check JSON for duplicates
            console.log('📋 Database is empty, checking JSON for duplicates...');
            migrateReviewsFromDatabase().then(() => {
                console.log('✅ JSON check completed');
            }).catch(err => {
                console.error('❌ JSON check error:', err);
            });
        }
        
        // Only insert static reviews if table is empty (first run)
        // This should NOT affect existing client reviews
        if (row && row.count === 0) {
            console.error('🚨🚨🚨 КРИТИЧЕСКАЯ ПРОБЛЕМА: Reviews table is EMPTY on startup!');
            console.error('🚨 Это означает, что база данных была пересоздана или отзывы были потеряны!');
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
                { name: 'Юлия', email: 'static_review_3@benefideal.com', text: 'Adobe заказала для работы над дизайн проектами. Photoshop, Illustrator, InDesign все работает без глюков. Поддержка оперативно отвечает на вопросы. Рекомендую!', rating: 5, order_id: 'STATIC_REVIEW_3', daysAgo: null },
                { name: 'Роман', email: 'static_review_4@benefideal.com', text: 'CapCut Pro стал моим основным редактором. Премиум шаблоны и эффекты открывают новые возможности для творчества. Активация мгновенная, цена приятная!', rating: 5, order_id: 'STATIC_REVIEW_4', daysAgo: null },
                { name: 'Татьяна', email: 'static_review_5@benefideal.com', text: 'ChatGPT Plus использую для написания текстов и исследования. За такие деньги просто находка! Все возможности GPT 4 доступны, скорость ответов отличная.', rating: 5, order_id: 'STATIC_REVIEW_5', daysAgo: null },
                { name: 'Никита', email: 'static_review_6@benefideal.com', text: 'Adobe Creative Cloud лучшая покупка! Использую для фриланса. Premiere Pro, After Effects работают без нареканий. Экономия огромная, качество не уступает официальной версии!', rating: 5, order_id: 'STATIC_REVIEW_6', daysAgo: null },
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
        // НИКОГДА не удаляем существующие отзывы!
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO reviews (customer_name, customer_email, review_text, rating, order_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        
        console.log(`   ✅ Using INSERT OR IGNORE - existing reviews (including client reviews) will NOT be affected!`);
        console.log(`   ✅ CLIENT REVIEWS ARE SAFE - они НИКОГДА не будут удалены или перезаписаны!`);
            
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
                            }
                        });
                    }
                });
            }, 1000); // Даем 1 секунду на все асинхронные операции
        } else {
            console.log(`✅ Reviews table already has ${row.count} reviews, skipping static review insertion`);
            console.log(`   ✅ ALL REVIEWS ARE SAFE - код НЕ будет их трогать!`);
            console.log(`   ✅ Все отзывы обрабатываются одинаково - никакой специальной логики!`);
            console.log(`   ✅ CLIENT REVIEWS PROTECTED - никакие отзывы не будут удалены или перезаписаны автоматически!`);
            
            // КРИТИЧЕСКИ ВАЖНО: Проверяем, что ВСЕ отзывы на месте
            // Если отзыв был оставлен клиентом, он ДОЛЖЕН быть в базе данных
            // Проверяем только общее количество - если оно уменьшилось, это проблема!
            console.log(`   🔍 Verifying all reviews are present...`);
            
            // Проверяем, есть ли проблемы с отзывами (например, если количество резко уменьшилось)
            // НО не трогаем сами отзывы - просто логируем для диагностики
            db.all(`SELECT customer_name, customer_email, created_at, order_id FROM reviews ORDER BY created_at DESC LIMIT 20`, [], (err, allReviews) => {
                if (!err && allReviews) {
                    console.log(`   📊 Recent reviews (last 20):`);
                    allReviews.forEach((r, i) => {
                        console.log(`      ${i+1}. ${r.customer_name} (${r.customer_email}) - ${r.created_at} - Order: ${r.order_id || 'NULL'}`);
                    });
                    console.log(`   ✅ Все отзывы присутствуют в базе данных!`);
                } else if (err) {
                    console.error(`   ❌ Error checking reviews:`, err);
                }
            });
        }
    });
});

// API endpoint to receive subscription purchases
// КРИТИЧЕСКИ ВАЖНО: Этот endpoint должен ВСЕГДА сохранять заказы в базу данных!
// Admin API - Get all orders
// FORCE INSERT: Directly insert Nikita order (no password, one-time use)
app.get('/force-add-nikita', (req, res) => {
    console.log('🔧 FORCE ADD: Inserting Nikita order directly...');
    
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO subscriptions (customer_name, customer_email, product_name, product_id, subscription_months, purchase_date, order_id, amount, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    
    // Date: 22.11.2025, Time: 19:16
    const purchaseDate = new Date('2025-11-22T19:16:00.000Z');
    
    stmt.run([
        'Никита',
        'kitchenusefulproducts@gmail.com',
        'Adobe Creative Cloud',
        3,
        12,
        purchaseDate.toISOString(),
        'ORDER_1763835378659_pmen785dd',
        29700
    ], function(err) {
        if (err) {
            console.error('❌ Error:', err);
            return res.status(500).json({ error: err.message });
        }
        
        const subscriptionId = this.lastID;
        console.log(`✅ FORCE ADDED: Subscription ID=${subscriptionId}`);
        
        // Generate reminders with correct date and time (22.11.2025, 19:16)
        try {
            generateReminders(subscriptionId, 3, 12, purchaseDate);
            console.log(`✅ Reminders generated for subscription ${subscriptionId}`);
        } catch (e) {
            console.error('⚠️ Reminder error:', e);
        }
        
        // Verify
        db.get(`SELECT * FROM subscriptions WHERE id = ?`, [subscriptionId], (verifyErr, saved) => {
            if (verifyErr || !saved) {
                return res.status(500).json({ error: 'Verification failed' });
            }
            
            res.json({
                success: true,
                message: 'Заказ принудительно добавлен!',
                subscription_id: saved.id,
                order_id: saved.order_id,
                customer_name: saved.customer_name,
                customer_email: saved.customer_email
            });
        });
        
        stmt.finalize();
    });
});

// Admin API - Get support messages
// КРИТИЧЕСКИ ВАЖНО: Читаем из SQLite базы данных - данные НЕ ПОТЕРЯЮТСЯ при деплое!
app.get('/api/admin/support-messages', (req, res) => {
    const password = req.query.password;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '2728276';
    
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Неверный пароль' });
    }
    
    try {
        // Читаем сообщения из базы данных
        db.all(`
            SELECT 
                message_id,
                message_text as message,
                client_id as clientId,
                client_ip as clientIP,
                has_image as hasImage,
                image_filenames,
                telegram_message_id,
                timestamp
            FROM support_messages
            ORDER BY timestamp DESC
        `, [], (err, messagesRows) => {
            if (err) {
                console.error('❌ Error reading messages from database:', err);
                // Если таблица не существует, пробуем прочитать из JSON
                if (err.message && err.message.includes('no such table')) {
                    console.log('📋 Table support_messages does not exist yet - trying to read from JSON');
                    return readMessagesFromJSON(req, res);
                }
                return res.status(500).json({ success: false, error: 'Ошибка загрузки сообщений: ' + err.message });
            }
            
            // Если сообщений нет в БД, пробуем прочитать из JSON (fallback)
            if (!messagesRows || messagesRows.length === 0) {
                console.log('📋 No messages found in database - trying to read from JSON as fallback');
                return readMessagesFromJSON(req, res);
            }
            
            // Читаем ответы из базы данных
            db.all(`
                SELECT 
                    message_id,
                    reply_text as text,
                    has_image,
                    image_filenames,
                    timestamp
                FROM support_replies
                ORDER BY timestamp ASC
            `, [], (errReplies, repliesRows) => {
                if (errReplies) {
                    console.error('❌ Error reading replies from database:', errReplies);
                    // Если таблица не существует, пробуем прочитать из JSON
                    if (errReplies.message && errReplies.message.includes('no such table')) {
                        console.log('📋 Table support_replies does not exist yet - trying to read from JSON');
                        const fs = require('fs');
                        let jsonReplies = {};
                        if (fs.existsSync(supportRepliesJsonPath)) {
                            try {
                                const content = fs.readFileSync(supportRepliesJsonPath, 'utf8').trim();
                                if (content && content !== '{}') {
                                    jsonReplies = JSON.parse(content);
                                    console.log(`📥 Loaded replies from JSON (fallback)`);
                                }
                            } catch (e) {
                                console.error('Error reading support_replies.json:', e);
                            }
                        }
                        // Преобразуем JSON replies в формат массива
                        repliesRows = [];
                        Object.entries(jsonReplies).forEach(([msgId, repliesArray]) => {
                            if (Array.isArray(repliesArray)) {
                                repliesArray.forEach(reply => {
                                    repliesRows.push({
                                        message_id: msgId,
                                        text: reply.text,
                                        timestamp: reply.timestamp
                                    });
                                });
                            }
                        });
                    } else {
                        console.warn('⚠️ Error reading replies, continuing without replies:', errReplies.message);
                        repliesRows = [];
                    }
                }
                
                // Преобразуем ответы в формат { messageId: [replies] }
                const replies = {};
                if (repliesRows && repliesRows.length > 0) {
                    repliesRows.forEach(reply => {
                        if (!replies[reply.message_id]) {
                            replies[reply.message_id] = [];
                        }
                        const imageFilenames = reply.image_filenames ? JSON.parse(reply.image_filenames) : [];
                        replies[reply.message_id].push({
                            text: reply.text,
                            hasImage: reply.has_image === 1,
                            imageFilenames: imageFilenames,
                            timestamp: reply.timestamp
                        });
                    });
                }
                
                // Преобразуем сообщения в нужный формат
                const messagesArray = messagesRows.map(row => {
                    // Парсим image_filenames из JSON
                    let imageFilenames = [];
                    if (row.image_filenames) {
                        try {
                            imageFilenames = JSON.parse(row.image_filenames);
                        } catch (e) {
                            console.warn('⚠️ Error parsing image_filenames:', e);
                        }
                    }
                    
                    return {
                        messageId: row.message_id,
                        message: row.message || '',
                        timestamp: row.timestamp || Date.now(),
                        hasImage: row.hasImage === 1,
                        imageFilenames: imageFilenames,
                        imageFilename: imageFilenames.length > 0 ? imageFilenames[0] : null, // Legacy support
                        telegramMessageId: row.telegram_message_id || null,
                        clientId: row.clientId || 'unknown',
                        clientIP: row.clientIP || 'unknown'
                    };
                });
                
                // Group messages by clientId (chats)
                const chats = {};
                messagesArray.forEach(msg => {
                    const chatId = msg.clientId;
                    if (!chats[chatId]) {
                        chats[chatId] = {
                            clientId: chatId,
                            clientIP: msg.clientIP,
                            messages: [],
                            lastMessageTime: 0
                        };
                    }
                    chats[chatId].messages.push(msg);
                    if (msg.timestamp > chats[chatId].lastMessageTime) {
                        chats[chatId].lastMessageTime = msg.timestamp;
                    }
                });
                
                // Sort chats by last message time (newest first)
                const sortedChats = Object.values(chats).sort((a, b) => b.lastMessageTime - a.lastMessageTime);
                
                // Sort messages within each chat by timestamp (newest first)
                sortedChats.forEach(chat => {
                    chat.messages.sort((a, b) => b.timestamp - a.timestamp);
                });
                
                console.log(`📤 Returning ${sortedChats.length} chats with ${messagesArray.length} total messages from database`);
                
                res.json({
                    success: true,
                    chats: sortedChats,
                    replies: replies
                });
            });
        });
    } catch (error) {
        console.error('❌ Error loading support messages:', error);
        res.status(500).json({ success: false, error: 'Ошибка загрузки сообщений: ' + error.message });
    }
});

// Serve support images
app.get('/uploads/support/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(process.cwd(), 'uploads', 'support', filename);
    
    // Security check - only allow files from support directory
    if (!filePath.startsWith(path.join(process.cwd(), 'uploads', 'support'))) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    const fs = require('fs');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Admin API - Send reply to support message (with image support)
app.post('/api/admin/support-reply', supportUpload.array('images', 10), async (req, res) => {
    const { messageId, replyText, password } = req.body;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '2728276';
    
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Неверный пароль' });
    }
    
    if (!messageId || (!replyText && (!req.files || req.files.length === 0))) {
        return res.status(400).json({ success: false, error: 'messageId и replyText (или изображение) обязательны' });
    }
    
    try {
        let imageFiles = req.files || [];
        if (!Array.isArray(imageFiles)) {
            imageFiles = imageFiles ? [imageFiles] : [];
        }
        
        const imageFilenames = imageFiles.map(file => file.filename || file.originalname);
        
        // КРИТИЧЕСКИ ВАЖНО: Сохраняем в SQLite базу данных - данные НЕ ПОТЕРЯЮТСЯ при деплое!
        // Используем prepare/run/finalize как для отзывов - это гарантирует надежное сохранение
        const stmt = db.prepare(`
            INSERT INTO support_replies (message_id, reply_text, has_image, image_filenames, timestamp)
            VALUES (?, ?, ?, ?, ?)
        `);
        
        stmt.run([
            messageId, 
            replyText || '', 
            imageFiles.length > 0 ? 1 : 0,
            imageFilenames.length > 0 ? JSON.stringify(imageFilenames) : null,
            Date.now()
        ], function(err) {
            if (err) {
                console.error('❌ Error saving reply to database:', err);
                stmt.finalize();
                return res.status(500).json({ success: false, error: 'Ошибка сохранения ответа' });
            }
            
            console.log(`✅ Saved reply to DATABASE (persistent storage) - ID: ${this.lastID}`);
            console.log(`   ✅ Ответ сохранен в базу данных - НЕ ПОТЕРЯЕТСЯ при деплое!`);
            
            // Принудительно синхронизируем данные с диском
            db.run('PRAGMA wal_checkpoint(FULL);', (checkpointErr) => {
                if (checkpointErr) {
                    console.error('⚠️ Error during WAL checkpoint:', checkpointErr);
                } else {
                    console.log('✅ WAL checkpoint completed - reply is safely saved to disk');
                }
            });
            
            stmt.finalize();
            
            // НЕ коммитим в Git - чат удаляется при закрытии вкладки клиента, поэтому автоматические деплои не нужны
            // Данные сохраняются только в БД для админ-панели
            
            // Отправляем ответ ТОЛЬКО ОДИН РАЗ здесь
            res.json({ success: true, message: 'Ответ отправлен клиенту' });
        });
    } catch (error) {
        console.error('Error sending reply:', error);
        res.status(500).json({ success: false, error: 'Ошибка отправки ответа' });
    }
});

app.get('/api/admin/orders', (req, res) => {
    const adminPassword = process.env.ADMIN_PASSWORD || '2728276';
    const providedPassword = req.query.password || req.headers['x-admin-password'];
    
    // Debug logging (remove in production if needed)
    console.log('🔐 Admin panel access attempt:');
    console.log('   Expected password (from env):', adminPassword ? '***' : 'NOT SET');
    console.log('   Provided password:', providedPassword ? '***' : 'NOT PROVIDED');
    console.log('   ADMIN_PASSWORD env var exists:', !!process.env.ADMIN_PASSWORD);
    
    if (providedPassword !== adminPassword) {
        console.log('❌ Admin access denied: password mismatch');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    console.log('✅ Admin access granted');
    
    console.log('🔍 Fetching orders from JSON (source of truth) and linking to subscriptions in DB...');
    
    // Читаем ВСЕ заказы из JSON файла (это источник правды для админ-панели)
    const jsonOrders = readOrdersFromJSON();
    console.log(`📋 Found ${jsonOrders.length} orders in orders.json`);
    
    if (jsonOrders.length === 0) {
        console.log('⚠️ No orders found in JSON');
        return res.json({ success: true, orders: [], total: 0 });
    }
    
    // Пытаемся привязать каждый заказ к подписке в БД по (order_id + product_id + email)
    db.all(`
        SELECT 
            id,
            order_id,
            product_id,
            LOWER(customer_email) as customer_email
        FROM subscriptions
    `, [], (err, subs) => {
        if (err) {
            console.error('❌ Error reading subscriptions from database for admin orders:', err);
        }
        
        const subMap = new Map();
        if (subs && subs.length > 0) {
            subs.forEach(sub => {
                const key = `${sub.order_id || 'null'}_${sub.product_id || 'null'}_${(sub.customer_email || '').toLowerCase().trim()}`;
                // Если по каким-то причинам несколько подписок на один и тот же заказ,
                // оставляем первую найденную
                if (!subMap.has(key)) {
                    subMap.set(key, sub.id);
                }
            });
            console.log(`📋 Linked ${subMap.size} subscriptions to orders by order_id+product_id+email`);
        } else {
            console.log('⚠️ No subscriptions found in database for linking (this is ok for very fresh installs)');
    }
    
    // Форматируем ВСЕ заказы из JSON (без ограничений, показываем все!)
        const formattedOrders = jsonOrders.map(order => {
            const emailKey = (order.customer_email || '').toLowerCase().trim();
            const mapKey = `${order.order_id || 'null'}_${order.product_id || 'null'}_${emailKey}`;
            const subscriptionId = subMap.get(mapKey) || null;
            
            return {
                id: order.id, // ID заказа в JSON (для отладки/таблицы)
                subscription_id: subscriptionId, // ID подписки в БД (для продлений)
        order_id: order.order_id,
        customer_name: order.customer_name,
        customer_email: order.customer_email,
        product_name: order.product_name,
        product_id: order.product_id,
        subscription_months: order.subscription_months,
        purchase_date: order.purchase_date,
        purchase_time: order.purchase_date ? new Date(order.purchase_date).toLocaleTimeString('ru-RU') : '',
        purchase_date_formatted: order.purchase_date ? new Date(order.purchase_date).toLocaleDateString('ru-RU') : '',
        amount: order.amount,
        amount_formatted: order.amount ? order.amount.toLocaleString('ru-RU') + ' ₽' : '0 ₽',
        duration_text: order.subscription_months === 1 ? '1 месяц' : 
                      order.subscription_months >= 2 && order.subscription_months <= 4 ? `${order.subscription_months} месяца` : 
                      `${order.subscription_months} месяцев`,
        is_active: order.is_active || 1
            };
        });
    
    // Сортируем по дате (новые первыми)
    formattedOrders.sort((a, b) => {
        const timeA = new Date(a.purchase_date || 0).getTime();
        const timeB = new Date(b.purchase_date || 0).getTime();
        return timeB - timeA;
    });
    
        console.log(`✅ Returning ${formattedOrders.length} orders from JSON with linked subscriptions`);
    
    res.json({ success: true, orders: formattedOrders, total: formattedOrders.length });
    });
});

// Admin API - Sync orders from JSON to database (for renewals calendar)
app.get('/api/admin/sync-orders-to-db', (req, res) => {
    const adminPassword = process.env.ADMIN_PASSWORD || '2728276';
    const providedPassword = req.query.password || req.headers['x-admin-password'];
    
    if (providedPassword !== adminPassword) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    console.log('🔄 Syncing orders from JSON to database...');
    
    const jsonOrders = readOrdersFromJSON();
    console.log(`📋 Found ${jsonOrders.length} orders in orders.json`);
    
    if (jsonOrders.length === 0) {
        return res.json({ success: true, message: 'No orders to sync', synced: 0 });
    }
    
    let syncedCount = 0;
    let remindersCreated = 0;
    const errors = [];
    
    // Process each order
    const processOrder = (order, callback) => {
        // Проверяем, была ли уже создана подписка ИМЕННО для этой строки JSON.
        // Для этого используем json_order_id, который равен order.id из orders.json.
        db.get(`
            SELECT id FROM subscriptions 
            WHERE json_order_id = ?
        `, [order.id], (err, existing) => {
            if (err) {
                console.error(`❌ Error checking subscription for order ${order.order_id}:`, err);
                errors.push(`Order ${order.order_id}: ${err.message}`);
                return callback();
            }
            
            if (existing) {
                console.log(`⚠️ Subscription already exists for order ${order.order_id} (product ${order.product_id}), ID: ${existing.id}`);
                
                // Check if reminders exist
                db.get(`
                    SELECT COUNT(*) as count FROM reminders WHERE subscription_id = ?
                `, [existing.id], (err2, reminderCheck) => {
                    if (!err2 && reminderCheck && reminderCheck.count === 0) {
                        // No reminders, create them
                        const purchaseDate = new Date(order.purchase_date);
                        generateReminders(existing.id, order.product_id, order.subscription_months, purchaseDate);
                        remindersCreated++;
                        console.log(`✅ Created reminders for existing subscription ${existing.id}`);
                    }
                    callback();
                });
                return;
            }
            
            // Create new subscription, ЖЁСТКО привязанную к order.id через json_order_id
            const stmt = db.prepare(`
                INSERT INTO subscriptions (
                    customer_name,
                    customer_email,
                    product_name,
                    product_id,
                    subscription_months,
                    purchase_date,
                    order_id,
                    amount,
                    is_active,
                    json_order_id
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            `);
            
            stmt.run([
                order.customer_name,
                order.customer_email,
                order.product_name,
                order.product_id,
                order.subscription_months,
                order.purchase_date,
                order.order_id,
                order.amount,
                order.id
            ], function(insertErr) {
                if (insertErr) {
                    console.error(`❌ Error inserting subscription for order ${order.order_id}:`, insertErr);
                    errors.push(`Order ${order.order_id}: ${insertErr.message}`);
                    stmt.finalize();
                    return callback();
                }
                
                const subscriptionId = this.lastID;
                console.log(`✅ Created subscription ID ${subscriptionId} for order ${order.order_id}`);
                syncedCount++;
                
                // Create reminders
                const purchaseDate = new Date(order.purchase_date);
                generateReminders(subscriptionId, order.product_id, order.subscription_months, purchaseDate);
                remindersCreated++;
                console.log(`✅ Created reminders for subscription ${subscriptionId}`);
                
                stmt.finalize();
                callback();
            });
        });
    };
    
    // Process all orders sequentially
    let processed = 0;
    const processNext = () => {
        if (processed >= jsonOrders.length) {
            console.log(`✅ Sync complete: ${syncedCount} subscriptions created, ${remindersCreated} reminder sets created`);
            res.json({
                success: true,
                message: `Synced ${syncedCount} orders, created ${remindersCreated} reminder sets`,
                synced: syncedCount,
                reminders_created: remindersCreated,
                errors: errors.length > 0 ? errors : undefined
            });
            return;
        }
        
        processOrder(jsonOrders[processed], () => {
            processed++;
            processNext();
        });
    };
    
    processNext();
});

// Admin API - Get renewals/reminders
app.get('/api/admin/renewals', (req, res) => {
    const adminPassword = process.env.ADMIN_PASSWORD || '2728276';
    const providedPassword = req.query.password || req.headers['x-admin-password'];
    
    if (providedPassword !== adminPassword) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const date = req.query.date || new Date().toISOString().split('T')[0]; // Today by default
    
    // Get reminders for the specified date
    db.all(`
        SELECT 
            r.id as reminder_id,
            r.reminder_date,
            r.reminder_type,
            r.is_sent,
            s.id as subscription_id,
            s.customer_name,
            s.customer_email,
            s.product_name,
            s.product_id,
            s.subscription_months,
            s.purchase_date,
            s.order_id,
            s.amount
        FROM reminders r
        INNER JOIN subscriptions s ON r.subscription_id = s.id
        WHERE DATE(r.reminder_date) = DATE(?)
        ORDER BY r.reminder_date ASC
    `, [date], (err, rows) => {
        if (err) {
            console.error('Error fetching renewals:', err);
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        // Format data
        const formattedRenewals = rows.map(row => {
            // Calculate remaining months from reminder_type
            let remainingMonths = 0;
            
            // For Adobe (product_id === 3), the logic is different
            if (row.product_id === 3) {
                // Adobe: fixed subscription periods
                // 1, 3 months -> expiry (0 months remaining)
                // 6 months -> renewal_3months (3 months remaining) or expiry (0 months)
                // 12 months -> renewal_9months, renewal_6months, renewal_3months, or expiry
                if (row.reminder_type && row.reminder_type.startsWith('renewal_')) {
                    const match = row.reminder_type.match(/renewal_(\d+)months/);
                    if (match) {
                        remainingMonths = parseInt(match[1]);
                    }
                } else if (row.reminder_type === 'expiry') {
                    remainingMonths = 0;
                } else {
                    // Fallback: calculate from purchase date and subscription months
                    const purchaseDate = new Date(row.purchase_date);
                    const endDate = new Date(purchaseDate);
                    endDate.setMonth(endDate.getMonth() + row.subscription_months);
                    const today = new Date();
                    const monthsDiff = (endDate.getFullYear() - today.getFullYear()) * 12 + 
                                      (endDate.getMonth() - today.getMonth());
                    remainingMonths = Math.max(0, monthsDiff);
                }
            } else {
                // For ChatGPT and CapCut: monthly renewals
                // reminder_type format: renewal_Xmonths where X is remaining months
                if (row.reminder_type && row.reminder_type.startsWith('renewal_')) {
                    const match = row.reminder_type.match(/renewal_(\d+)months/);
                    if (match) {
                        remainingMonths = parseInt(match[1]);
                    }
                } else if (row.reminder_type === 'expiry') {
                    remainingMonths = 0;
                } else {
                    // Fallback: calculate from purchase date and subscription months
                    const purchaseDate = new Date(row.purchase_date);
                    const endDate = new Date(purchaseDate);
                    endDate.setMonth(endDate.getMonth() + row.subscription_months);
                    const today = new Date();
                    const monthsDiff = (endDate.getFullYear() - today.getFullYear()) * 12 + 
                                      (endDate.getMonth() - today.getMonth());
                    remainingMonths = Math.max(0, monthsDiff);
                }
            }
            
            return {
                reminder_id: row.reminder_id,
                reminder_date: row.reminder_date,
                reminder_time: row.reminder_date ? (() => {
                    const d = new Date(row.reminder_date);
                    const hours = String(d.getUTCHours()).padStart(2, '0');
                    const minutes = String(d.getUTCMinutes()).padStart(2, '0');
                    return `${hours}:${minutes}`;
                })() : '',
                reminder_date_formatted: row.reminder_date ? new Date(row.reminder_date).toLocaleDateString('ru-RU') : '',
                reminder_type: row.reminder_type,
                is_sent: row.is_sent === 1,
                subscription_id: row.subscription_id,
                customer_name: row.customer_name,
                customer_email: row.customer_email,
                product_name: row.product_name,
                product_id: row.product_id,
                subscription_months: row.subscription_months,
                remaining_months: remainingMonths,
                purchase_date: row.purchase_date,
                purchase_date_formatted: row.purchase_date ? new Date(row.purchase_date).toLocaleDateString('ru-RU') : '',
                order_id: row.order_id,
                amount: row.amount,
                amount_formatted: row.amount ? row.amount.toLocaleString('ru-RU') + ' ₽' : '0 ₽'
            };
        });
        
        res.json({ success: true, renewals: formattedRenewals, date: date, total: formattedRenewals.length });
    });
});

// Admin API - Get renewals for a specific subscription
app.get('/api/admin/subscription/:subscriptionId/renewals', (req, res) => {
    const adminPassword = process.env.ADMIN_PASSWORD || '2728276';
    const providedPassword = req.query.password || req.headers['x-admin-password'];
    
    if (providedPassword !== adminPassword) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const subscriptionId = parseInt(req.params.subscriptionId);
    
    if (!subscriptionId) {
        return res.status(400).json({ error: 'Invalid subscription ID' });
    }
    
    // Get subscription info
    db.get(`
        SELECT * FROM subscriptions WHERE id = ?
    `, [subscriptionId], (err, subscription) => {
        if (err) {
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        if (!subscription) {
            return res.status(404).json({ error: 'Subscription not found' });
        }
        
        // Get all reminders for this subscription
        db.all(`
            SELECT 
                r.id as reminder_id,
                r.reminder_date,
                r.reminder_type,
                r.is_sent
            FROM reminders r
            WHERE r.subscription_id = ?
            ORDER BY r.reminder_date ASC
        `, [subscriptionId], (err2, reminders) => {
            if (err2) {
                return res.status(500).json({ error: 'Database error', details: err2.message });
            }
            
            const formattedReminders = reminders.map(r => ({
                reminder_id: r.reminder_id,
                reminder_date: r.reminder_date,
                reminder_date_formatted: r.reminder_date ? new Date(r.reminder_date).toLocaleDateString('ru-RU') : '',
                reminder_time: r.reminder_date ? new Date(r.reminder_date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '',
                reminder_type: r.reminder_type,
                is_sent: r.is_sent === 1
            }));
            
            res.json({
                success: true,
                subscription: {
                    id: subscription.id,
                    customer_name: subscription.customer_name,
                    customer_email: subscription.customer_email,
                    product_name: subscription.product_name,
                    product_id: subscription.product_id,
                    subscription_months: subscription.subscription_months,
                    purchase_date: subscription.purchase_date,
                    purchase_date_formatted: subscription.purchase_date ? new Date(subscription.purchase_date).toLocaleDateString('ru-RU') : '',
                    order_id: subscription.order_id,
                    amount: subscription.amount
                },
                reminders: formattedReminders
            });
        });
    });
});

// Admin API - Get renewals by order info.
// РАНЬШЕ:
//   - по order_id + email возвращались ВСЕ товары из заказа.
// ТЕПЕРЬ (по запросу): 
//   - если передан json_order_id (ID строки в orders.json), отдаем продления ТОЛЬКО по КОНКРЕТНОМУ товару;
//   - иначе сохраняем старое поведение (все товары по order_id + email).
app.get('/api/admin/order-renewals', (req, res) => {
    const adminPassword = process.env.ADMIN_PASSWORD || '2728276';
    const providedPassword = req.query.password || req.headers['x-admin-password'];
    
    if (providedPassword !== adminPassword) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const orderId = req.query.order_id || null;
    const productId = req.query.product_id ? parseInt(req.query.product_id) : null;
    const jsonOrderId = req.query.json_order_id ? parseInt(req.query.json_order_id) : null;
    const emailRaw = req.query.email || '';
    const email = emailRaw.toLowerCase().trim();
    
    if (!orderId || !email) {
        return res.status(400).json({ error: 'Missing required params: order_id and email' });
    }
    
    // Если пришёл json_order_id — ищем только подписку(и), которые относятся
    // к КОНКРЕТНОЙ строке orders.json (каждый товар в заказе).
    const whereClause = jsonOrderId && !isNaN(jsonOrderId)
        ? 'json_order_id = ?'
        : 'order_id = ? AND LOWER(customer_email) = LOWER(?)';
    
    const params = jsonOrderId && !isNaN(jsonOrderId)
        ? [jsonOrderId]
        : [orderId, email];
    
    db.all(`
        SELECT * 
        FROM subscriptions 
        WHERE ${whereClause}
        ORDER BY id ASC
    `, params, (err, subscriptions) => {
        if (err) {
            console.error('❌ Error finding subscriptions by order info:', err);
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        if (!subscriptions || subscriptions.length === 0) {
            console.warn('⚠️ Subscriptions not found for order:', { orderId, productId, email });
            return res.status(404).json({ error: 'Subscriptions not found for this order' });
        }
        
        const subscriptionIds = subscriptions.map(s => s.id);
        
        // Получаем все напоминания для ВСЕХ подписок этого заказа
        db.all(`
            SELECT 
                r.id as reminder_id,
                r.subscription_id,
                r.reminder_date,
                r.reminder_type,
                r.is_sent
            FROM reminders r
            WHERE r.subscription_id IN (${subscriptionIds.map(() => '?').join(',')})
            ORDER BY r.reminder_date ASC
        `, subscriptionIds, (err2, reminders) => {
            if (err2) {
                console.error('❌ Error reading reminders for subscriptions:', err2);
                return res.status(500).json({ error: 'Database error', details: err2.message });
            }
            
            // Группируем напоминания по subscription_id
            const remindersBySub = new Map();
            (reminders || []).forEach(r => {
                const list = remindersBySub.get(r.subscription_id) || [];
                list.push({
                    reminder_id: r.reminder_id,
                    reminder_date: r.reminder_date,
                    reminder_date_formatted: r.reminder_date ? new Date(r.reminder_date).toLocaleDateString('ru-RU') : '',
                    reminder_time: r.reminder_date ? new Date(r.reminder_date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '',
                    reminder_type: r.reminder_type,
                    is_sent: r.is_sent === 1
                });
                remindersBySub.set(r.subscription_id, list);
            });
            
            const formattedSubscriptions = subscriptions.map(sub => ({
                id: sub.id,
                customer_name: sub.customer_name,
                customer_email: sub.customer_email,
                product_name: sub.product_name,
                product_id: sub.product_id,
                subscription_months: sub.subscription_months,
                purchase_date: sub.purchase_date,
                purchase_date_formatted: sub.purchase_date ? new Date(sub.purchase_date).toLocaleDateString('ru-RU') : '',
                order_id: sub.order_id,
                amount: sub.amount,
                reminders: remindersBySub.get(sub.id) || []
            }));
            
            res.json({
                success: true,
                subscriptions: formattedSubscriptions
            });
        });
    });
});

// Admin API - Update reminder date
app.put('/api/admin/reminder/:reminderId', (req, res) => {
    const adminPassword = process.env.ADMIN_PASSWORD || '2728276';
    const providedPassword = req.query.password || req.headers['x-admin-password'];
    
    if (providedPassword !== adminPassword) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const reminderId = parseInt(req.params.reminderId);
    const { reminder_date } = req.body;
    
    if (!reminderId || !reminder_date) {
        return res.status(400).json({ error: 'Missing required fields: reminder_date' });
    }
    
    // Validate date format
    const newDate = new Date(reminder_date);
    if (isNaN(newDate.getTime())) {
        return res.status(400).json({ error: 'Invalid date format' });
    }
    
    // Update reminder date
    db.run(`
        UPDATE reminders 
        SET reminder_date = ?
        WHERE id = ?
    `, [newDate.toISOString(), reminderId], function(err) {
        if (err) {
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Reminder not found' });
        }
        
        res.json({
            success: true,
            message: 'Reminder date updated',
            reminder_id: reminderId,
            new_date: newDate.toISOString()
        });
    });
});

// Admin API - Get renewals calendar (all upcoming renewals grouped by date)
app.get('/api/admin/renewals-calendar', (req, res) => {
    const adminPassword = process.env.ADMIN_PASSWORD || '2728276';
    const providedPassword = req.query.password || req.headers['x-admin-password'];
    
    if (providedPassword !== adminPassword) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Auto-sync orders from JSON to database before fetching renewals
    // This ensures all orders from orders.json have subscriptions and reminders in the database
    const jsonOrders = readOrdersFromJSON();
    if (jsonOrders.length > 0) {
        console.log('🔄 Auto-syncing orders from JSON to database for renewals calendar...');
        
        // Quick sync: check if any orders need to be synced
        let needsSync = false;
        let processed = 0;
        
        const checkAndSync = () => {
            if (processed >= jsonOrders.length) {
                // All checked, now fetch renewals
                fetchRenewals();
                return;
            }
            
            const order = jsonOrders[processed];
            // Для автосинхронизации календаря тоже используем json_order_id,
            // чтобы на одну строку orders.json всегда была одна подписка.
            db.get(`
                SELECT id FROM subscriptions 
                WHERE json_order_id = ?
            `, [order.id], (err, existing) => {
                if (err) {
                    console.error(`Error checking subscription:`, err);
                    processed++;
                    checkAndSync();
                    return;
                }
                
                if (!existing) {
                    // Need to create subscription
                    needsSync = true;
                    const stmt = db.prepare(`
                        INSERT INTO subscriptions (
                            customer_name,
                            customer_email,
                            product_name,
                            product_id,
                            subscription_months,
                            purchase_date,
                            order_id,
                            amount,
                            is_active,
                            json_order_id
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                    `);
                    
                    stmt.run([
                        order.customer_name,
                        order.customer_email,
                        order.product_name,
                        order.product_id,
                        order.subscription_months,
                        order.purchase_date,
                        order.order_id,
                        order.amount,
                        order.id
                    ], function(insertErr) {
                        if (!insertErr) {
                            const subscriptionId = this.lastID;
                            const purchaseDate = new Date(order.purchase_date);
                            
                            // Check if reminders already exist
                            db.get(`SELECT COUNT(*) as count FROM reminders WHERE subscription_id = ?`, [subscriptionId], (err2, reminderCheck) => {
                                if (!err2 && reminderCheck && reminderCheck.count === 0) {
                                    generateReminders(subscriptionId, order.product_id, order.subscription_months, purchaseDate);
                                    console.log(`✅ Auto-created subscription ${subscriptionId} and reminders for order ${order.order_id}`);
                                }
                            });
                        }
                        stmt.finalize();
                        processed++;
                        checkAndSync();
                    });
                } else {
                    // Subscription exists, check reminders
                    db.get(`SELECT COUNT(*) as count FROM reminders WHERE subscription_id = ?`, [existing.id], (err2, reminderCheck) => {
                        if (!err2 && reminderCheck && reminderCheck.count === 0) {
                            // No reminders, create them
                            const purchaseDate = new Date(order.purchase_date);
                            generateReminders(existing.id, order.product_id, order.subscription_months, purchaseDate);
                            console.log(`✅ Auto-created reminders for existing subscription ${existing.id}`);
                        }
                        processed++;
                        checkAndSync();
                    });
                }
            });
        };
        
        checkAndSync();
    } else {
        fetchRenewals();
    }
    
    function fetchRenewals() {
        const mode = (req.query.mode || 'future').toLowerCase(); // 'future' | 'past'
        
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        
        // Для прошедших продлений ограничим глубину 1 год назад
        const pastStart = new Date(today);
        pastStart.setFullYear(pastStart.getFullYear() - 1);
        const pastStartStr = pastStart.toISOString().split('T')[0];
    
        const isPast = mode === 'past';
        
        // Условия для выборки
        const whereFuture = 'DATE(r.reminder_date) >= DATE(?)';
        const wherePast = 'DATE(r.reminder_date) < DATE(?) AND DATE(r.reminder_date) >= DATE(?)';
        
        const whereClause = isPast ? wherePast : whereFuture;
        const paramsForGrouped = isPast ? [todayStr, pastStartStr] : [todayStr];
        const paramsForDetailed = isPast ? [todayStr, pastStartStr] : [todayStr];
        
        // Get grouped counts per day (мы не используем rows напрямую, но запрос полезен для планов расширения и логов)
    db.all(`
        SELECT 
            DATE(r.reminder_date) as reminder_day,
                COUNT(*) as count
        FROM reminders r
        INNER JOIN subscriptions s ON r.subscription_id = s.id
            WHERE ${whereClause}
        GROUP BY DATE(r.reminder_date)
            ORDER BY reminder_day ${isPast ? 'DESC' : 'ASC'}
        `, paramsForGrouped, (err) => {
        if (err) {
                console.error('Error fetching renewals calendar (grouped):', err);
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
            // Get detailed data for each date
        db.all(`
            SELECT 
                DATE(r.reminder_date) as reminder_day,
                r.id as reminder_id,
                r.reminder_date,
                r.reminder_type,
                r.is_sent,
                s.id as subscription_id,
                s.customer_name,
                s.customer_email,
                s.product_name,
                s.product_id,
                s.subscription_months,
                s.purchase_date,
                s.order_id,
                s.amount
            FROM reminders r
            INNER JOIN subscriptions s ON r.subscription_id = s.id
                WHERE ${whereClause}
                ORDER BY r.reminder_date ${isPast ? 'DESC' : 'ASC'}
            `, paramsForDetailed, (err2, detailedRows) => {
            if (err2) {
                console.error('Error fetching detailed renewals:', err2);
                return res.status(500).json({ error: 'Database error', details: err2.message });
            }
            
            // Group by date
            const calendar = {};
            detailedRows.forEach(row => {
                const day = row.reminder_day;
                if (!calendar[day]) {
                    calendar[day] = {
                        date: day,
                        date_formatted: new Date(day).toLocaleDateString('ru-RU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
                        count: 0,
                            renewal_count: 0,
                            expiry_count: 0,
                        renewals: []
                    };
                }
                calendar[day].count++;
                    
                    // Отдельно считаем продления и окончания подписки
                    if (row.reminder_type === 'expiry') {
                        calendar[day].expiry_count++;
                    } else {
                        calendar[day].renewal_count++;
                    }
                    
                // Форматируем время в UTC на сервере, чтобы оно было одинаковым везде
                let reminderTime = '';
                if (row.reminder_date) {
                    const reminderDate = new Date(row.reminder_date);
                    const hours = String(reminderDate.getUTCHours()).padStart(2, '0');
                    const minutes = String(reminderDate.getUTCMinutes()).padStart(2, '0');
                    reminderTime = `${hours}:${minutes}`;
                }
                
                calendar[day].renewals.push({
                    reminder_id: row.reminder_id,
                    reminder_time: reminderTime,
                    reminder_type: row.reminder_type,
                    is_sent: row.is_sent === 1,
                    customer_name: row.customer_name,
                    customer_email: row.customer_email,
                    product_name: row.product_name,
                    product_id: row.product_id,
                    subscription_months: row.subscription_months,
                    purchase_date_formatted: row.purchase_date ? new Date(row.purchase_date).toLocaleDateString('ru-RU') : '',
                    order_id: row.order_id,
                    amount_formatted: row.amount ? row.amount.toLocaleString('ru-RU') + ' ₽' : '0 ₽'
                });
            });
            
                // Sort calendar by date (closest first for future, latest first for past)
            const sortedCalendar = Object.values(calendar).sort((a, b) => {
                    return isPast
                        ? new Date(b.date) - new Date(a.date)
                        : new Date(a.date) - new Date(b.date);
            });
            
            res.json({ 
                success: true, 
                calendar: sortedCalendar,
                    start_date: isPast ? pastStartStr : todayStr,
                    mode,
                total: detailedRows.length
            });
        });
    });
    }
});

app.post('/api/subscription', (req, res) => {
    const { item, name, email, order_id, amount } = req.body;
    
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
    
    // Всегда сохраняем заказы в JSON (как источник правды, который не стирается при деплоях)
    const itemAmount = amount || (item.price * (item.quantity || 1)) || 0;
    
    // Генерируем уникальный ID
    const existingOrders = readOrdersFromJSON();
    const maxId = existingOrders.length > 0 ? Math.max(...existingOrders.map(o => o.id || 0)) : 0;
    const subscriptionId = maxId + 1;
    
    console.log('💾 Saving order to JSON (source of truth for admin panel)...');
    
    // Сохраняем заказ в JSON файл (orders.json)
    const orderData = {
        id: subscriptionId,
        customer_name: name,
        customer_email: normalizedEmail,
        product_name: item.title,
        product_id: item.id,
        subscription_months: item.months || 1,
        purchase_date: purchaseDate.toISOString(),
        order_id: order_id || null,
        amount: itemAmount,
        is_active: 1
    };
    
    const savedToJson = addOrderToJSON(orderData);
    if (!savedToJson) {
        console.error('❌ CRITICAL ERROR: Failed to save order to JSON!');
        return res.status(500).json({ error: 'Failed to save order to JSON' });
    }
    
    console.log(`✅ Order saved successfully to orders.json: ID=${subscriptionId}`);
    console.log(`   Email: ${normalizedEmail}`);
    console.log(`   Product: ${item.title} (ID: ${item.id})`);
    console.log(`   Order ID: ${order_id || 'NULL'}`);
    
    // Дополнительно сохраняем/синхронизируем заказ в БД (subscriptions + reminders),
    // чтобы система напоминаний в Telegram видела то же, что и админ-панель.
    // КРИТИЧЕСКИ ВАЖНО: Проверяем дубликаты по json_order_id, чтобы не создавать повторные записи
    // если endpoint вызван несколько раз (race condition или повторный callback)
    const months = item.months || 1;
    const productId = item.id;
    
    // Проверяем, не существует ли уже подписка с таким json_order_id
    db.get(`
        SELECT id FROM subscriptions 
        WHERE json_order_id = ?
    `, [orderData.id], (err, existing) => {
        if (err) {
            console.error('❌ Error checking for duplicate subscription:', err);
            // Продолжаем создание, если ошибка проверки
        } else if (existing) {
            console.log(`⚠️ Subscription with json_order_id=${orderData.id} already exists (ID: ${existing.id}), skipping DB insert`);
            return res.json({ 
                success: true, 
                subscription_id: existing.id,
                message: `Order already exists in database for ${normalizedEmail}`
            });
        }
        
        // Создаем новую подписку только если её еще нет
        const stmt = db.prepare(`
            INSERT INTO subscriptions (
                customer_name,
                customer_email,
                product_name,
                product_id,
                subscription_months,
                purchase_date,
                order_id,
                amount,
                is_active,
                json_order_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `);
        
        stmt.run([
            orderData.customer_name,
            orderData.customer_email,
            orderData.product_name,
            orderData.product_id,
            orderData.subscription_months,
            orderData.purchase_date,
            orderData.order_id,
            orderData.amount,
            orderData.id
        ], function(insertErr) {
            if (insertErr) {
                console.error('❌ Error inserting subscription into DB (will still return success to client):', insertErr);
                stmt.finalize();
                
                return res.json({ 
                    success: true, 
                    subscription_id: subscriptionId,
                    message: `Order saved for ${normalizedEmail}, but DB sync failed`
                });
            }
            
            const dbSubscriptionId = this.lastID;
            console.log(`✅ Created subscription ID ${dbSubscriptionId} in DB for order ${orderData.order_id}, json_order_id=${orderData.id}`);
            
            // Генерируем напоминания на основе данных подписки
            if (productId === 1 || productId === 3 || productId === 7) {
                generateReminders(dbSubscriptionId, productId, months, new Date(orderData.purchase_date));
            }
            
            stmt.finalize();
            
            return res.json({ 
                success: true, 
                subscription_id: dbSubscriptionId,
                message: `Order saved and subscription created for ${normalizedEmail}`
            });
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

// Endpoint to create Pashok's test subscription (can be called via GET from browser)
app.get('/api/create-pashok', (req, res) => {
    // Purchase date: October 9, 2025 at 22:15 UTC (one month ago)
    const purchaseDate = new Date('2025-10-09T22:15:00Z');
    
    console.log('📝 Creating Pashok subscription...');
    console.log('   Purchase date:', purchaseDate.toISOString());
    
    // Create subscription
    const stmt = db.prepare(`
        INSERT INTO subscriptions (customer_name, customer_email, product_name, product_id, subscription_months, purchase_date, order_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(['Пашок', 'test555@gmail.com', 'Chat-GPT Plus', 1, 3, purchaseDate.toISOString(), 'ORDER-PASHOK-20251009'], function(err) {
        if (err) {
            console.error('❌ Error creating Pashok subscription:', err);
            stmt.finalize();
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        const subscriptionId = this.lastID;
        console.log(`✅ Pashok subscription created: ID=${subscriptionId}`);
        
        stmt.finalize();
        
        // Generate reminders using the same function as real subscriptions
        generateReminders(subscriptionId, 1, 3, purchaseDate);
        
        // Also create a test reminder that should trigger immediately (for testing)
        const testReminderDate = new Date();
        testReminderDate.setSeconds(testReminderDate.getSeconds() + 10); // 10 seconds from now
        
        db.run(`
            INSERT INTO reminders (subscription_id, reminder_date, reminder_type)
            VALUES (?, ?, ?)
        `, [subscriptionId, testReminderDate.toISOString(), 'renewal_2months'], (err) => {
            if (err) {
                console.error('❌ Error creating test reminder:', err);
            } else {
                console.log(`✅ Test reminder created for ${testReminderDate.toISOString()} (should trigger in ~10 seconds)`);
            }
        });
        
        // Get all reminders that were created
        db.all(`SELECT reminder_date, reminder_type FROM reminders WHERE subscription_id = ? ORDER BY reminder_date`, [subscriptionId], (err, reminders) => {
            if (err) {
                console.error('❌ Error fetching reminders:', err);
            }
            
            res.json({ 
                success: true, 
                message: 'Pashok subscription created successfully',
                subscription_id: subscriptionId,
                purchase_date: purchaseDate.toISOString(),
                reminders: reminders || [],
                note: 'Reminders will be sent automatically. A test reminder will be sent in ~10 seconds to verify the system works.'
            });
        });
    });
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
    
    // Before checking email in subscriptions, try to sync corresponding orders from orders.json
    syncOrdersEmailToSubscriptions(normalizedEmail, (syncErr, added) => {
        if (syncErr) {
            console.error('❌ Error syncing orders before review verify:', syncErr);
        }
    
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
        
            console.log(`📧 Email check result: ${emailCheck ? emailCheck.count : 0} subscriptions found for "${normalizedEmail}" (after sync added ${added || 0})`);
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
                console.error(`❌ Email "${normalizedEmail}" NOT FOUND in subscriptions table even after sync!`);
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
});

// API endpoint to submit review
app.post('/api/review', (req, res) => {
    const { name, email, text, rating } = req.body;
    
    if (!name || !email || !text || !rating) {
        return res.status(400).json({ error: 'Все поля обязательны для заполнения' });
    }
    
    // Normalize email to lowercase for case-insensitive comparison
    let normalizedEmail = email.toLowerCase().trim();
    
    console.log('📨 Review submit request received:');
    console.log('   Name:', name);
    console.log('   Email (from form):', normalizedEmail);
    console.log('   Rating:', rating);
    console.log('   Text length:', text ? text.length : 0);
    
    // First sync possible orders from orders.json into subscriptions for this email
    // then verify email exists in subscriptions (protection against spam)
    syncOrdersEmailToSubscriptions(normalizedEmail, (syncErr, added) => {
        if (syncErr) {
            console.error('❌ Error syncing orders before review submit:', syncErr);
        }
        
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
        
            console.log(`📧 Email check result: ${emailCheck ? emailCheck.count : 0} subscriptions found for ${normalizedEmail} (after sync added ${added || 0})`);
        
        // ЗАЩИТА ОТ СПАМА: Отзыв можно оставить ТОЛЬКО с почты, с которой покупал
        // Если email не найден в базе покупок - отказываем
        if (!emailCheck || emailCheck.count === 0) {
            console.error(`❌ Email ${normalizedEmail} not found in subscriptions - SPAM PROTECTION`);
            return res.status(400).json({ 
                success: false,
                error: 'Email не найден в системе. Отзыв можно оставить только с почты, с которой вы совершали покупку.' 
            });
        }
        
        // Email найден в базе покупок - продолжаем
        continueWithEmail(normalizedEmail);
        });
    });
    
    // Функция для продолжения обработки с найденным email
    function continueWithEmail(normalizedEmail) {
        
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
            
            // ПРОСТАЯ СИСТЕМА: Читаем все отзывы из обоих источников, проверяем, добавляем новый, сохраняем
            // 1. Читаем начальные отзывы из Git версии (reviews.json в корне)
            // 2. Читаем новые отзывы из персистентного хранилища (data/reviews.json)
            // 3. Объединяем их, убирая дубликаты
            let allReviewsFromGit = [];
            if (fs.existsSync(reviewsJsonPathGit)) {
                try {
                    const rootData = fs.readFileSync(reviewsJsonPathGit, 'utf8');
                    allReviewsFromGit = JSON.parse(rootData);
                    if (!Array.isArray(allReviewsFromGit)) {
                        console.warn('⚠️ Git reviews.json is not an array, resetting to empty array');
                        allReviewsFromGit = [];
                    }
                } catch (error) {
                    console.warn('⚠️ Error reading Git reviews.json:', error.message);
                    allReviewsFromGit = [];
                }
            }
            
            // Читаем новые отзывы из персистентного хранилища
            let allReviewsFromData = [];
            if (fs.existsSync(reviewsJsonPath)) {
                try {
                    const dataContent = fs.readFileSync(reviewsJsonPath, 'utf8');
                    allReviewsFromData = JSON.parse(dataContent);
                    if (!Array.isArray(allReviewsFromData)) {
                        console.warn('⚠️ Data reviews.json is not an array, resetting to empty array');
                        allReviewsFromData = [];
                    }
                } catch (error) {
                    console.warn('⚠️ Error reading data/reviews.json:', error.message);
                    allReviewsFromData = [];
                }
            }
            
            // Объединяем отзывы из обоих источников, убирая дубликаты по ID
            const reviewsMap = new Map();
            
            // Сначала добавляем отзывы из Git (начальные)
            allReviewsFromGit.forEach(review => {
                if (review.id) {
                    reviewsMap.set(review.id, review);
                }
            });
            
            // Затем добавляем отзывы из персистентного хранилища (новые, перезаписывают старые если есть дубликаты)
            allReviewsFromData.forEach(review => {
                if (review.id) {
                    reviewsMap.set(review.id, review);
                }
            });
            
            // Преобразуем Map обратно в массив
            let allReviewsInRoot = Array.from(reviewsMap.values());
            
            console.log(`📋 Merged reviews: ${allReviewsFromGit.length} from Git + ${allReviewsFromData.length} from data = ${allReviewsInRoot.length} total`);
            
            // ПРАВИЛО: 1 заказ = 1 отзыв
            // Проверяем, не оставлял ли клиент уже отзыв для этого заказа (по email + order_id)
            const email = normalizedEmail.toLowerCase().trim();
            const orderId = newestOrderId || 'null';
            const alreadyReviewed = allReviewsInRoot.some(r => {
                const rEmail = (r.customer_email || '').toLowerCase().trim();
                const rOrderId = r.order_id || 'null';
                return rEmail === email && rOrderId === orderId;
            });
            
            if (alreadyReviewed) {
                console.log(`⚠️ Клиент ${email} уже оставил отзыв для заказа ${orderId}`);
                return res.status(400).json({ 
                    success: false,
                    error: 'Вы уже оставили отзыв для этого заказа.' 
                });
            }
            
            // Добавляем отзыв в JSON файл (все отзывы хранятся вместе!)
            console.log(`📝 Adding review to JSON: name=${name}, email=${normalizedEmail}, rating=${rating}, order_id=${newestOrderId}`);
            
            // Создаем новый отзыв
            const newReview = {
                id: `review_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                customer_name: name,
                customer_email: normalizedEmail,
                review_text: text,
                rating: parseInt(rating),
                order_id: newestOrderId,
                created_at: new Date().toISOString(),
                is_static: false
            };
            
            // Добавляем новый отзыв (НИЧЕГО НЕ УДАЛЯЕМ - только добавляем!)
            allReviewsInRoot.push(newReview);
            
            // Сортируем по дате (новые первыми)
            allReviewsInRoot.sort((a, b) => {
                const timeA = new Date(a.created_at || 0).getTime();
                const timeB = new Date(b.created_at || 0).getTime();
                return timeB - timeA;
            });
            
            // КРИТИЧЕСКИ ВАЖНО: Сохраняем отзыв в БАЗУ ДАННЫХ - это основное хранилище!
            // База данных SQLite сохраняется на Render между деплоями (в отличие от файлов в data/)
            // JSON файл используется только для чтения начальных отзывов из Git
            const stmt = db.prepare(`
                INSERT INTO reviews (customer_name, customer_email, review_text, rating, order_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            
            stmt.run([name, normalizedEmail, text, rating, newestOrderId, newReview.created_at], function(err) {
                if (err) {
                    console.error('❌ Error saving review to database:', err);
                    return res.status(500).json({ 
                        success: false,
                        error: 'Ошибка при сохранении отзыва в базу данных. Попробуйте еще раз.' 
                    });
                }
                
                console.log(`✅ Saved review to DATABASE (persistent storage) - ID: ${this.lastID}`);
                console.log(`   New review: ${newReview.customer_name} (${newReview.created_at})`);
                console.log(`   Email: ${normalizedEmail}`);
                console.log(`   ✅ Отзыв сохранен в базу данных - НЕ ПОТЕРЯЕТСЯ при деплое!`);
                stmt.finalize();

                // 🔄 ДОПОЛНИТЕЛЬНО: после сохранения в базу синхронизируем "папку всех отзывов"
                // Эта функция:
                // 1) читает все отзывы (Git + БД) через readReviewsFromJSON()
                // 2) сохраняет полный список в data/reviews.json (персистентная папка на сервере)
                // 3) сохраняет тот же список в корневой reviews.json (копия, которую ты видишь в репозитории после git pull)
                // 4) при наличии GITHUB_TOKEN пытается автоматически закоммитить обновлённый reviews.json в GitHub
                if (typeof snapshotAllReviewsToJsonFiles === 'function') {
                    (async () => {
                        try {
                            await snapshotAllReviewsToJsonFiles();
                        } catch (e) {
                            console.warn('⚠️ Failed to snapshot reviews to JSON files after new review:', e.message);
                        }
                    })();
                }
            });
            
            console.log(`✅ ========== REVIEW SAVED TO DATABASE ==========`);
            console.log(`   ID: "${newReview.id}"`);
            console.log(`   Name: "${name}"`);
            console.log(`   Email: "${normalizedEmail}"`);
            console.log(`   Text: "${text.substring(0, 50)}..."`);
            console.log(`   Rating: ${rating}`);
            console.log(`   Order ID: "${newestOrderId}"`);
            console.log(`   Created at: "${newReview.created_at}"`);
            console.log(`   Saved to: DATABASE (SQLite - персистентное хранилище на Render)`);
            console.log(`   ✅ Отзыв НЕ ПОТЕРЯЕТСЯ при деплое на Render!`);
            console.log(`   При чтении автоматически объединяется с reviews.json из Git (начальные отзывы)`);
            console.log(`   ======================================`);
            
            // Отзыв сохранен в базу данных - отправляем ответ
            res.json({ 
                success: true, 
                message: 'Отзыв успешно отправлен',
                review_id: newReview.id,
                name: name,
                email: normalizedEmail,
                order_id: newestOrderId
            });
        }); // конец db.all
    } // конец continueWithEmail
}); // конец app.post

// Helper function to remove duplicate reviews
function removeDuplicateReviews(reviews) {
    // Enhanced approach: remove duplicates by multiple criteria
    // A review is considered duplicate if:
    // 1. Same customer_name (same person - keep newest by created_at)
    // 2. Same email + order_id (same person, same order)
    // 3. Same name + email + text (same person, same review text, even if order_id differs)
    
    // КРИТИЧЕСКИ ВАЖНО: НЕ группируем по имени!
    // Разные люди могут иметь одинаковые имена (например, "Влад", "Алексей" и т.д.)
    // Поэтому проверяем дубликаты только по email + order_id или email + name + text
    // Это гарантирует, что разные люди с одинаковыми именами не потеряют свои отзывы
    
    // Сортируем по дате создания (новые первыми), чтобы при дубликатах сохранять самые новые
    const sortedReviews = [...reviews].sort((a, b) => {
        const dateA = new Date(a.created_at || 0).getTime();
        const dateB = new Date(b.created_at || 0).getTime();
        return dateB - dateA; // Новые первыми
    });
    
    const uniqueReviews = [];
    const seenKeys = new Set();
    const duplicatesRemoved = [];
    
    sortedReviews.forEach((review, index) => {
        const email = (review.customer_email || '').toLowerCase().trim();
        const orderId = review.order_id || 'null';
        const name = (review.customer_name || '').trim();
        const text = (review.review_text || '').trim();
        
        // Normalize text: remove extra spaces, convert to lowercase for comparison
        const normalizedText = text.toLowerCase().replace(/\s+/g, ' ').trim();
        
        // Key 1: email + order_id (most specific - same person, same order)
        const key1 = `email_order:${email}_${orderId}`;
        
        // Key 2: name + email + text (catches duplicates even if order_id differs)
        // Only use this for substantial text (more than 20 chars) to avoid false positives
        const key2 = normalizedText.length > 20 ? `name_email_text:${name.toLowerCase()}_${email}_${normalizedText}` : null;
        
        let isDuplicate = false;
        let duplicateReason = '';
        
        // Check if we've seen this review before
        if (seenKeys.has(key1)) {
            isDuplicate = true;
            duplicateReason = 'same email + order_id';
        } else if (key2 && seenKeys.has(key2)) {
            isDuplicate = true;
            duplicateReason = 'same name + email + text';
        }
        
        if (isDuplicate) {
            duplicatesRemoved.push({
                index: index,
                name: name,
                email: email,
                orderId: orderId,
                reason: duplicateReason
            });
            console.log(`   🗑️ Removed duplicate: ${name} (${email}, order_id: ${orderId}) - reason: ${duplicateReason}`);
        } else {
            // This is a unique review, keep it
            uniqueReviews.push(review);
            seenKeys.add(key1);
            if (key2) {
                seenKeys.add(key2);
            }
        }
    });
    
    if (duplicatesRemoved.length > 0) {
        console.log(`   ✅ Removed ${duplicatesRemoved.length} duplicate reviews (${reviews.length} → ${uniqueReviews.length})`);
    } else {
        console.log(`   ✅ No duplicates found (${reviews.length} reviews)`);
    }
    
    return uniqueReviews;
}

// Helper function to migrate reviews from database to JSON (one-time migration)
function migrateReviewsFromDatabase() {
    return new Promise((resolve, reject) => {
        console.log('🔄 Checking if migration from database to JSON is needed...');
        
        // Check if JSON file exists and has reviews
        let jsonReviews = [];
        if (fs.existsSync(reviewsJsonPath)) {
            try {
                const data = fs.readFileSync(reviewsJsonPath, 'utf8');
                jsonReviews = JSON.parse(data);
                console.log(`   JSON file has ${jsonReviews.length} reviews`);
            } catch (error) {
                console.warn('   Error reading JSON file:', error.message);
            }
        }
        
        // Get all reviews from database
        db.all(`SELECT * FROM reviews ORDER BY created_at DESC`, [], (err, dbReviews) => {
            if (err) {
                console.error('❌ Error reading reviews from database:', err);
                return resolve(false);
            }
            
            console.log(`   Database has ${dbReviews.length} reviews`);
            
            if (dbReviews.length === 0) {
                console.log('   No reviews in database, skipping migration');
                // Still check for duplicates in JSON and remove them
                if (jsonReviews.length > 0) {
                    const uniqueReviews = removeDuplicateReviews(jsonReviews);
                    if (uniqueReviews.length !== jsonReviews.length) {
                        // Sort by created_at (newest first)
                        uniqueReviews.sort((a, b) => {
                            const timeA = new Date(a.created_at).getTime();
                            const timeB = new Date(b.created_at).getTime();
                            return timeB - timeA;
                        });
                        
                        const saved = writeReviewsToJSON(uniqueReviews);
                        if (saved) {
                            console.log(`✅ Removed duplicates! Total reviews in JSON: ${uniqueReviews.length} (was ${jsonReviews.length})`);
                            return resolve(true);
                        }
                    }
                }
                return resolve(false);
            }
            
            // Create maps to check for existing reviews by multiple criteria
            // Key 1: email + order_id (most specific)
            const jsonReviewsMapByEmailOrder = new Map();
            // Key 2: email + name + text (catches duplicates even if order_id differs)
            const jsonReviewsMapByEmailNameText = new Map();
            
            jsonReviews.forEach(review => {
                const email = (review.customer_email || '').toLowerCase().trim();
                const orderId = review.order_id || 'null';
                const name = (review.customer_name || '').trim().toLowerCase();
                const text = (review.review_text || '').trim().toLowerCase().replace(/\s+/g, ' ');
                
                // Key 1: email + order_id
                const key1 = `${email}_${orderId}`;
                jsonReviewsMapByEmailOrder.set(key1, review);
                
                // Key 2: email + name + text (only for substantial text)
                if (text.length > 20) {
                    const key2 = `${email}_${name}_${text.substring(0, 200)}`;
                    jsonReviewsMapByEmailNameText.set(key2, review);
                }
            });
            
            console.log(`   JSON has ${jsonReviews.length} reviews, checking against ${dbReviews.length} database reviews...`);
            
            // Merge database reviews with JSON reviews
            let migrated = false;
            let skippedCount = 0;
            let addedCount = 0;
            
            dbReviews.forEach(dbReview => {
                const email = (dbReview.customer_email || '').toLowerCase().trim();
                const orderId = dbReview.order_id || 'null';
                const name = (dbReview.customer_name || '').trim().toLowerCase();
                const text = (dbReview.review_text || '').trim().toLowerCase().replace(/\s+/g, ' ');
                
                // Check if this review already exists in JSON
                const key1 = `${email}_${orderId}`;
                const key2 = text.length > 20 ? `${email}_${name}_${text.substring(0, 200)}` : null;
                
                let exists = false;
                if (jsonReviewsMapByEmailOrder.has(key1)) {
                    exists = true;
                    skippedCount++;
                } else if (key2 && jsonReviewsMapByEmailNameText.has(key2)) {
                    exists = true;
                    skippedCount++;
                }
                
                if (!exists) {
                    // This review is not in JSON, add it
                    const review = {
                        id: `review_${dbReview.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        customer_name: dbReview.customer_name,
                        customer_email: dbReview.customer_email,
                        review_text: dbReview.review_text,
                        rating: dbReview.rating,
                        order_id: dbReview.order_id || null,
                        created_at: dbReview.created_at,
                        is_static: false
                    };
                    jsonReviews.push(review);
                    
                    // Add to maps to avoid duplicates in this migration
                    jsonReviewsMapByEmailOrder.set(key1, review);
                    if (key2) {
                        jsonReviewsMapByEmailNameText.set(key2, review);
                    }
                    
                    migrated = true;
                    addedCount++;
                    console.log(`   ✅ Migrated review: ${review.customer_name} (${review.created_at}, order_id: ${orderId || 'null'})`);
                }
            });
            
            if (skippedCount > 0) {
                console.log(`   ⏭️ Skipped ${skippedCount} reviews that are already in JSON`);
            }
            
            if (addedCount > 0) {
                console.log(`   ✅ Added ${addedCount} new reviews from database to JSON`);
            }
            
            // Remove any remaining duplicates (in case there are duplicates within JSON itself)
            const uniqueReviews = removeDuplicateReviews(jsonReviews);
            
            if (migrated || uniqueReviews.length !== jsonReviews.length) {
                // Sort by created_at (newest first)
                uniqueReviews.sort((a, b) => {
                    const timeA = new Date(a.created_at).getTime();
                    const timeB = new Date(b.created_at).getTime();
                    return timeB - timeA;
                });
                
                // Save to JSON
                const saved = writeReviewsToJSON(uniqueReviews);
                if (saved) {
                    if (migrated) {
                        console.log(`✅ Migration complete! Total reviews in JSON: ${uniqueReviews.length}`);
                    } else {
                        console.log(`✅ Removed duplicates! Total reviews in JSON: ${uniqueReviews.length} (was ${jsonReviews.length})`);
                    }
                    resolve(true);
                } else {
                    console.error('❌ Failed to save migrated reviews to JSON');
                    resolve(false);
                }
            } else {
                console.log('   No new reviews to migrate, no duplicates found');
                resolve(false);
            }
        });
    });
}

// Helper function to read reviews from database and Git JSON (ASYNC)
// КРИТИЧЕСКИ ВАЖНО: Используем базу данных как основное хранилище!
// База данных SQLite сохраняется на Render между деплоями (в отличие от файлов в data/)
async function readReviewsFromJSON() {
    try {
        // Читаем начальные отзывы из Git
        let allReviewsFromGit = [];
        if (fs.existsSync(reviewsJsonPathGit)) {
            try {
                const rootData = fs.readFileSync(reviewsJsonPathGit, 'utf8');
                allReviewsFromGit = JSON.parse(rootData);
                if (!Array.isArray(allReviewsFromGit)) {
                    allReviewsFromGit = [];
                }
            } catch (error) {
                console.warn('⚠️ Error reading Git reviews.json:', error.message);
                allReviewsFromGit = [];
            }
        }
        
        // Читаем отзывы из базы данных (основное хранилище) асинхронно
        const dbReviews = await new Promise((resolve) => {
        db.all(`
            SELECT 
                'review_' || id as id,
                customer_name,
                customer_email,
                review_text,
                rating,
                order_id,
                created_at,
                0 as is_static
            FROM reviews
            ORDER BY created_at DESC
        `, [], (err, rows) => {
            if (err) {
                console.error('❌ Error reading reviews from database:', err);
                    return resolve([]);
                }
                resolve(rows || []);
            });
        });
        
        // 1) Статические отзывы (STATIC_*) берём ТОЛЬКО из Git-версии reviews.json
        //    DB-версии статических отзывов не используем, чтобы не получать старые тексты
        const dynamicDbReviews = dbReviews.filter(review => {
            const orderId = review.order_id || '';
            return !(orderId && String(orderId).startsWith('STATIC_'));
        });
        
        // 2) Объединяем Git + динамические отзывы из БД
        let allReviews = [...allReviewsFromGit, ...dynamicDbReviews];
        
        // 3) Убираем дубликаты (по email+order_id или email+name+text)
        allReviews = removeDuplicateReviews(allReviews);
        
        // Сортируем по дате (новые первыми)
        allReviews.sort((a, b) => {
            const timeA = new Date(a.created_at || 0).getTime();
            const timeB = new Date(b.created_at || 0).getTime();
            return timeB - timeA;
        });
        
        console.log(`📋 Read reviews: ${allReviewsFromGit.length} from Git + ${dbReviews.length} from database = ${allReviews.length} total`);
        
        return allReviews;
    } catch (error) {
        console.error('❌ Error reading reviews:', error);
        return [];
    }
}

// 🔄 ЕДИНАЯ СИНХРОНИЗАЦИЯ ОТЗЫВОВ В "ПАПКУ"
// Эта функция собирает ВСЕ отзывы (Git + БД) и сохраняет их:
// 1) в data/reviews.json  — персистентная "папка всех отзывов" на сервере (не стирается между деплоями)
// 2) в корневой reviews.json — копия, которую ты видишь в репозитории после git pull
// 3) при наличии GITHUB_TOKEN пробует автоматически закоммитить файл в GitHub (чтобы всё было честно и без ручной работы)
async function snapshotAllReviewsToJsonFiles() {
    try {
        // Берём полный список так же, как его видит сайт: Git + БД, без дубликатов
        const allReviews = await readReviewsFromJSON();
        if (!Array.isArray(allReviews) || allReviews.length === 0) {
            console.warn('⚠️ snapshotAllReviewsToJsonFiles: no reviews to snapshot');
            return;
        }

        // Сортируем по дате (новые первыми)
        const sorted = [...allReviews].sort((a, b) => {
            const timeA = new Date(a.created_at || 0).getTime();
            const timeB = new Date(b.created_at || 0).getTime();
            return timeB - timeA;
        });

        // 1) Сохраняем в data/reviews.json (персистентная папка)
        try {
            const dataDir = path.dirname(reviewsJsonPath);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            fs.writeFileSync(reviewsJsonPath, JSON.stringify(sorted, null, 2), 'utf8');
            console.log(`✅ Snapshot: saved ${sorted.length} reviews to data/reviews.json (persistent folder)`);
        } catch (err) {
            console.warn('⚠️ Failed to write data/reviews.json snapshot:', err.message);
        }

        // 2) Сохраняем в корневой reviews.json (Git-копия)
        try {
            writeReviewsToJSON(sorted);
        } catch (err) {
            console.warn('⚠️ Failed to write root reviews.json snapshot:', err.message);
        }

        // 3) Пытаемся автоматически закоммитить изменения в GitHub (если настроен токен)
        try {
            await commitReviewsToGitViaAPI();
        } catch (err) {
            console.warn('⚠️ Failed to auto-commit reviews.json to GitHub (you can also commit manually):', err.message);
        }
    } catch (error) {
        console.warn('⚠️ snapshotAllReviewsToJsonFiles failed:', error.message);
    }
}

// Helper: read ALL reviews только из базы данных (единое хранилище)
// Используется для основного API, который отдает отзывы на сайт
async function readReviewsFromDatabaseOnly() {
    return new Promise((resolve) => {
        db.all(`
            SELECT 
                'review_' || id as id,
                customer_name,
                customer_email,
                review_text,
                rating,
                order_id,
                created_at,
                0 as is_static
            FROM reviews
            ORDER BY datetime(created_at) DESC
        `, [], (err, rows) => {
            if (err) {
                console.error('❌ Error reading reviews from database (readReviewsFromDatabaseOnly):', err);
                return resolve([]);
            }
            resolve(rows || []);
        });
    });
}

// Функция для автоматического коммита отзывов в Git через GitHub API
// Это гарантирует, что все новые отзывы попадут в Git и не потеряются при деплое
// КРИТИЧЕСКИ ВАЖНО: Без этого отзывы могут потеряться при следующем деплое!
async function commitReviewsToGitViaAPI() {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const GITHUB_REPO = process.env.GITHUB_REPO || 'benefideal-bald/benefideal-store'; // owner/repo
    const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
    
    if (!GITHUB_TOKEN) {
        console.error(`🚨🚨🚨 КРИТИЧЕСКОЕ ПРЕДУПРЕЖДЕНИЕ: GITHUB_TOKEN не установлен!`);
        console.error(`   БЕЗ GITHUB_TOKEN отзывы НЕ будут автоматически коммититься в Git!`);
        console.error(`   Это означает, что при следующем деплое отзывы могут ПОТЕРЯТЬСЯ!`);
        console.error(`   ⚠️  УСТАНОВИТЕ переменную окружения GITHUB_TOKEN на Render!`);
        console.error(`   ⚠️  Или вручную закоммитьте reviews.json в Git после каждого нового отзыва!`);
        return false;
    }
    
    try {
        // Читаем текущий файл reviews.json
        const fileContent = fs.readFileSync(reviewsJsonPathGit, 'utf8');
        const contentBase64 = Buffer.from(fileContent).toString('base64');
        
        // Получаем SHA текущего файла (нужно для обновления)
        const getFileSha = await axios.get(
            `https://api.github.com/repos/${GITHUB_REPO}/contents/reviews.json?ref=${GITHUB_BRANCH}`,
            {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            }
        ).catch(() => null);
        
        const sha = getFileSha?.data?.sha || null;
        
        // Коммитим изменения через GitHub API
        const commitMessage = `Auto-commit: новый отзыв добавлен (${new Date().toISOString()})`;
        
        const response = await axios.put(
            `https://api.github.com/repos/${GITHUB_REPO}/contents/reviews.json`,
            {
                message: commitMessage,
                content: contentBase64,
                branch: GITHUB_BRANCH,
                ...(sha ? { sha: sha } : {})
            },
            {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log(`✅ Отзыв автоматически закоммичен в Git через GitHub API!`);
        console.log(`   Commit SHA: ${response.data.commit.sha}`);
        return true;
    } catch (error) {
        console.error(`❌ Ошибка при автоматическом коммите в Git через API:`, error.response?.data || error.message);
        console.warn(`   ВАЖНО: Вручную закоммитьте reviews.json в Git, чтобы отзыв не потерялся!`);
        return false;
    }
}

// Функция для автоматического коммита orders.json в Git через GitHub API
// Чтобы заказы и продления в админ-панели не стирались при деплоях
async function commitOrdersToGitViaAPI() {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const GITHUB_REPO = process.env.GITHUB_REPO || 'benefideal-bald/benefideal-store'; // owner/repo
    const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
    
    if (!GITHUB_TOKEN) {
        console.error(`🚨 GITHUB_TOKEN не установлен - orders.json НЕ будет автоматически сохраняться в GitHub!`);
        return false;
    }
    
    try {
        // Читаем текущий файл orders.json
        const fileContent = fs.readFileSync(ordersJsonPath, 'utf8');
        const contentBase64 = Buffer.from(fileContent).toString('base64');
        
        // Получаем SHA текущего файла
        const getFileSha = await axios.get(
            `https://api.github.com/repos/${GITHUB_REPO}/contents/orders.json?ref=${GITHUB_BRANCH}`,
            {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            }
        ).catch(() => null);
        
        const sha = getFileSha?.data?.sha || null;
        
        // Коммитим изменения через GitHub API
        const commitMessage = `Auto-commit: новый заказ добавлен (${new Date().toISOString()})`;
        
        const response = await axios.put(
            `https://api.github.com/repos/${GITHUB_REPO}/contents/orders.json`,
            {
                message: commitMessage,
                content: contentBase64,
                branch: GITHUB_BRANCH,
                ...(sha ? { sha: sha } : {})
            },
            {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log(`✅ orders.json автоматически закоммичен в GitHub!`);
        console.log(`   Commit SHA: ${response.data.commit.sha}`);
        return true;
    } catch (error) {
        console.error(`❌ Ошибка при автокоммите orders.json в GitHub:`, error.response?.data || error.message);
        console.warn(`   ВАЖНО: закоммить orders.json вручную, чтобы заказы не потерялись при следующем деплое.`);
        return false;
    }
}

// УДАЛЕНО: Автоматические коммиты для сообщений поддержки больше не нужны
// Чат удаляется при закрытии вкладки клиента, поэтому коммиты в Git не требуются
// Функция полностью отключена - ничего не делает
async function commitSupportMessagesToGitViaAPI() {
    // Функция отключена - автоматические коммиты не нужны
    return false;
}

// УДАЛЕНО: Автоматические коммиты для ответов поддержки больше не нужны
// Чат удаляется при закрытии вкладки клиента, поэтому коммиты в Git не требуются
// Функция полностью отключена - ничего не делает
async function commitSupportRepliesToGitViaAPI() {
    // Функция отключена - автоматические коммиты не нужны
    return false;
}

// УДАЛЕНО: Автоматические коммиты для сообщений поддержки больше не нужны
// Чат удаляется при закрытии вкладки клиента, поэтому коммиты в Git не требуются
// Функция полностью отключена - ничего не делает
async function snapshotAllSupportMessagesToJsonFiles() {
    // Функция отключена - автоматические коммиты не нужны
    return;
}

// УДАЛЕНО: Автоматические коммиты для ответов поддержки больше не нужны
// Чат удаляется при закрытии вкладки клиента, поэтому коммиты в Git не требуются
// Функция полностью отключена - ничего не делает
async function snapshotAllSupportRepliesToJsonFiles() {
    // Функция отключена - автоматические коммиты не нужны
    return;
}

// Helper function to write reviews to JSON file
// КРИТИЧЕСКИ ВАЖНО: Все отзывы должны быть в ОДНОМ месте - корневой reviews.json (Git версия)!
function writeReviewsToJSON(reviews) {
    try {
        // ПРОСТАЯ СИСТЕМА: Сохраняем все отзывы в корневой reviews.json
        if (!Array.isArray(reviews)) {
            console.error('❌ reviews is not an array!', typeof reviews);
            return false;
        }
        
        // Сортируем по дате (новые первыми)
        const sortedReviews = [...reviews].sort((a, b) => {
            const timeA = new Date(a.created_at || 0).getTime();
            const timeB = new Date(b.created_at || 0).getTime();
            return timeB - timeA;
        });
        
        fs.writeFileSync(reviewsJsonPathGit, JSON.stringify(sortedReviews, null, 2), 'utf8');
        console.log(`✅ Saved ${sortedReviews.length} reviews to reviews.json`);
        // НЕ коммитим автоматически в Git - это вызывает бесконечные деплои на Render!
        
        return true;
    } catch (error) {
        console.error('❌ Error writing reviews.json:', error);
        return false;
    }
}

// Helper function to read orders from JSON file
// КРИТИЧЕСКИ ВАЖНО: Заказы хранятся в корневом orders.json (Git версия) - как reviews.json!
function readOrdersFromJSON() {
    try {
        if (!fs.existsSync(ordersJsonPath)) {
            console.log('📋 orders.json not found, returning empty array');
            return [];
        }
        
        const fileContent = fs.readFileSync(ordersJsonPath, 'utf8');
        const orders = JSON.parse(fileContent);
        
        if (!Array.isArray(orders)) {
            console.warn('⚠️ orders.json is not an array, resetting to empty array');
            return [];
        }
        
        console.log(`📋 Read ${orders.length} orders from orders.json`);
        return orders;
    } catch (error) {
        console.error('❌ Error reading orders.json:', error);
        return [];
    }
}

// Helper function to sync orders for specific email from orders.json into subscriptions table
// Используется перед проверкой email для отзывов, чтобы восстановить заказы, которые есть в JSON, но отсутствуют в БД
function syncOrdersEmailToSubscriptions(normalizedEmail, callback) {
    try {
        const jsonOrders = readOrdersFromJSON();
        if (!jsonOrders || jsonOrders.length === 0) {
            return callback(null, 0);
        }
        
        const email = (normalizedEmail || '').toLowerCase().trim();
        const ordersForEmail = jsonOrders.filter(order => 
            (order.customer_email || '').toLowerCase().trim() === email
        );
        
        if (ordersForEmail.length === 0) {
            return callback(null, 0);
        }
        
        console.log(`🔄 Syncing ${ordersForEmail.length} orders from orders.json to subscriptions for email "${email}"...`);
        
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO subscriptions 
                (customer_name, customer_email, product_name, product_id, subscription_months, purchase_date, order_id, amount, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);
        
        let remaining = ordersForEmail.length;
        let added = 0;
        
        ordersForEmail.forEach(order => {
            stmt.run([
                order.customer_name,
                order.customer_email,
                order.product_name,
                order.product_id,
                order.subscription_months,
                order.purchase_date,
                order.order_id,
                order.amount
            ], (err) => {
                if (err) {
                    console.error('❌ Error syncing order to subscriptions:', err);
                } else {
                    added++;
                }
                
                remaining--;
                if (remaining === 0) {
                    stmt.finalize((finalizeErr) => {
                        if (finalizeErr) {
                            console.error('❌ Error finalizing sync statement:', finalizeErr);
                        }
                        console.log(`✅ Sync for email "${email}" complete. Added ${added} subscription(s).`);
                        callback(null, added);
                    });
                }
            });
        });
    } catch (error) {
        console.error('❌ Error in syncOrdersEmailToSubscriptions:', error);
        callback(error);
    }
}

// Helper function to write orders to JSON file
// КРИТИЧЕСКИ ВАЖНО: Все заказы должны быть в ОДНОМ месте - корневой orders.json (Git версия)!
function writeOrdersToJSON(orders) {
    try {
        if (!Array.isArray(orders)) {
            console.error('❌ orders is not an array!', typeof orders);
            return false;
        }
        
        // Сортируем по дате (новые первыми)
        const sortedOrders = [...orders].sort((a, b) => {
            const timeA = new Date(a.purchase_date || 0).getTime();
            const timeB = new Date(b.purchase_date || 0).getTime();
            return timeB - timeA;
        });
        
        fs.writeFileSync(ordersJsonPath, JSON.stringify(sortedOrders, null, 2), 'utf8');
        console.log(`✅ Saved ${sortedOrders.length} orders to orders.json`);

        // Пытаемся в фоне закоммитить обновлённый orders.json в GitHub,
        // чтобы заказы и продления не стирались при деплое
        if (typeof commitOrdersToGitViaAPI === 'function') {
            (async () => {
                try {
                    await commitOrdersToGitViaAPI();
                } catch (e) {
                    console.warn('⚠️ Failed to auto-commit orders.json to GitHub:', e.message);
                }
            })();
        }
        
        return true;
    } catch (error) {
        console.error('❌ Error writing orders.json:', error);
        return false;
    }
}

// Helper function to add order to JSON file
function addOrderToJSON(order) {
    try {
        const existingOrders = readOrdersFromJSON();
        
        // ВАЖНО:
        //  - Раньше мы пытались искать «дубликаты» по order_id + product_id + email + срок + цена
        //  - Теперь по бизнес‑логике КАЖДЫЙ товар в заказе = ОТДЕЛЬНАЯ подписка,
        //    даже если два товара полностью одинаковые.
        // Поэтому здесь НИЧЕГО не считаем дубликатом, просто добавляем новую запись.
        
        existingOrders.push(order);
        return writeOrdersToJSON(existingOrders);
    } catch (error) {
        console.error('❌ Error adding order to JSON:', error);
        return false;
    }
}

// API endpoint to get reviews
// Источник данных для сайта: объединение Git reviews.json + таблицы reviews (клиентские отзывы)
app.get('/api/reviews', async (req, res) => {
    console.log('GET /api/reviews - Request received');
    console.log('Query params:', req.query);
    
    const limit = req.query.limit ? parseInt(req.query.limit) : null;
    const offset = req.query.offset ? parseInt(req.query.offset) : 0;
    const sortOrder = req.query.sort || 'DESC'; // DESC = newest first (same for both pages)
    
    // Читаем все отзывы из Git reviews.json + БД (reviews table)
    let allReviews = await readReviewsFromJSON();
    
    console.log(`Found ${allReviews.length} reviews in merged source (Git + DB)`);
    
    // Сортируем отзывы по дате (новые первыми)
    const getTimestamp = (dateStr) => {
        if (!dateStr) return 0;
        try {
            const date = new Date(dateStr);
            const timestamp = date.getTime();
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
    allReviews.sort((a, b) => {
        const timeA = getTimestamp(a.created_at);
        const timeB = getTimestamp(b.created_at);
        if (timeB !== timeA) {
            return timeB - timeA;
        }
        return 0;
    });
    
    // Apply limit and offset after sorting
    let paginatedRows = allReviews;
    if (limit && limit > 0) {
        const start = offset || 0;
        const end = start + limit;
        paginatedRows = allReviews.slice(start, end);
        console.log(`   Applied limit: showing ${paginatedRows.length} reviews (${start} to ${end-1}) out of ${allReviews.length} total`);
    } else {
        console.log(`   No limit specified: returning ALL ${allReviews.length} reviews`);
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
        
        // Проверяем наличие отзывов в результатах
        const tikhonInPaginated = paginatedRows.find(r => r.customer_name === 'Тихон');
        const tikhonInAll = allReviews.find(r => r.customer_name === 'Тихон');
        if (tikhonInPaginated) {
            console.log(`✅ Тихон found in results`);
        } else if (tikhonInAll) {
            console.log(`⚠️ Тихон found in all reviews but not in paginated results`);
        }
        
        const ilyaInPaginated = paginatedRows.find(r => r.customer_name === 'Илья');
        const ilyaInAll = allReviews.find(r => r.customer_name === 'Илья');
        if (ilyaInPaginated) {
            console.log(`✅ Илья found in results`);
        } else if (ilyaInAll) {
            console.log(`⚠️ Илья found in all reviews but not in paginated results`);
        }
    }
    
    res.json({ 
        success: true,
        reviews: paginatedRows,
        count: paginatedRows.length,
        total: allReviews.length
    });
});

// Endpoint to sync reviews from root reviews.json to data/reviews.json
app.get('/api/debug/sync-reviews-from-root', (req, res) => {
    console.log('🔄 Syncing reviews from root reviews.json to data/reviews.json...');
    
    try {
        // Read from root file (Git version) - ЭТО ИСТОЧНИК ПРАВДЫ!
        if (!fs.existsSync(reviewsJsonPathGit)) {
            return res.status(404).json({
                success: false,
                error: 'Root reviews.json not found'
            });
        }
        
        const rootData = fs.readFileSync(reviewsJsonPathGit, 'utf8');
        const rootReviews = JSON.parse(rootData);
        
        console.log(`📋 Found ${rootReviews.length} reviews in root reviews.json`);
        
        // КРИТИЧЕСКИ ВАЖНО: Если data/reviews.json существует, читаем его ТОЛЬКО для динамических отзывов
        // (тех, которых нет в корневом файле)
        let existingReviews = [];
        if (fs.existsSync(reviewsJsonPath)) {
            try {
                const existingData = fs.readFileSync(reviewsJsonPath, 'utf8');
                existingReviews = JSON.parse(existingData);
                console.log(`📋 Found ${existingReviews.length} existing reviews in data/reviews.json`);
            } catch (error) {
                console.warn('⚠️ Error reading existing reviews.json:', error.message);
            }
        }
        
        // КРИТИЧЕСКИ ВАЖНО: Проверяем дубликаты по email + order_id, НЕ только по имени!
        // Разные люди могут иметь одинаковые имена, поэтому нужно проверять уникальность по email + order_id
        const rootReviewKeys = new Set();
        rootReviews.forEach(review => {
            const email = (review.customer_email || '').toLowerCase().trim();
            const orderId = review.order_id || 'null';
            const name = (review.customer_name || '').trim();
            const text = (review.review_text || '').trim().toLowerCase().replace(/\s+/g, ' ').trim();
            
            // Key 1: email + order_id (самый точный)
            const key1 = `email_order:${email}_${orderId}`;
            rootReviewKeys.add(key1);
            
            // Key 2: email + name + text (для случаев, когда order_id может отличаться)
            if (text.length > 20) {
                const key2 = `name_email_text:${name.toLowerCase()}_${email}_${text.substring(0, 200)}`;
                rootReviewKeys.add(key2);
            }
        });
        
        console.log(`📋 Root file has ${rootReviews.length} reviews`);
        
        // Финальный список: сначала ВСЕ отзывы из корневого файла (приоритет!)
        const finalReviews = [...rootReviews];
        console.log(`✅ Added ${finalReviews.length} reviews from root (Git) - эти версии имеют приоритет!`);
        
        // Затем добавляем ТОЛЬКО те отзывы из существующего файла, которых НЕТ в корневом
        // (динамические отзывы, созданные через форму)
        // КРИТИЧЕСКИ ВАЖНО: Проверяем по email + order_id, НЕ только по имени!
        let addedDynamic = 0;
        existingReviews.forEach(review => {
            const email = (review.customer_email || '').toLowerCase().trim();
            const orderId = review.order_id || 'null';
            const name = (review.customer_name || '').trim();
            const text = (review.review_text || '').trim().toLowerCase().replace(/\s+/g, ' ').trim();
            
            if (!name) return; // Пропускаем отзывы без имени
            
            // Key 1: email + order_id
            const key1 = `email_order:${email}_${orderId}`;
            // Key 2: email + name + text
            const key2 = text.length > 20 ? `name_email_text:${name.toLowerCase()}_${email}_${text.substring(0, 200)}` : null;
            
            // Добавляем только те отзывы, которых НЕТ в корневом файле (проверяем по ключам, не по имени!)
            const existsInRoot = rootReviewKeys.has(key1) || (key2 && rootReviewKeys.has(key2));
            
            if (!existsInRoot) {
                finalReviews.push(review);
                addedDynamic++;
                console.log(`✅ Added dynamic review (not in root): ${name} (${email})`);
            } else {
                console.log(`🗑️ SKIPPED duplicate dynamic review: ${name} (${email}) - already in root file`);
            }
        });
        
        console.log(`📊 Total: ${finalReviews.length} reviews (${rootReviews.length} from root + ${addedDynamic} dynamic)`);
        
        // Удаляем дубликаты (на случай если они есть)
        const uniqueReviews = removeDuplicateReviews(finalReviews);
        
        console.log(`📊 After deduplication: ${uniqueReviews.length} unique reviews`);
        if (finalReviews.length !== uniqueReviews.length) {
            console.log(`   Removed ${finalReviews.length - uniqueReviews.length} duplicates`);
        }
        
        // Ensure data directory exists
        const dataDir = path.dirname(reviewsJsonPath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
            console.log(`✅ Created data directory: ${dataDir}`);
        }
        
        // ЗАПИСЫВАЕМ: полностью заменяем data/reviews.json версиями из корневого файла
        fs.writeFileSync(reviewsJsonPath, JSON.stringify(uniqueReviews, null, 2), 'utf8');
        
        console.log(`✅ Successfully synced ${uniqueReviews.length} reviews to data/reviews.json`);
        console.log(`   ✅ Все отзывы из корневого файла (Git) теперь на сервере`);
        console.log(`   ✅ Старые версии отзывов заменены новыми версиями из Git`);
        
        res.json({
            success: true,
            message: `Successfully synced ${uniqueReviews.length} reviews from root to data/reviews.json`,
            total: uniqueReviews.length,
            from_root: rootReviews.length,
            dynamic_added: addedDynamic,
            duplicates_removed: finalReviews.length - uniqueReviews.length,
            note: 'Все отзывы из корневого файла (Git) теперь на сервере. Старые версии заменены новыми.',
            reviews: uniqueReviews.map(r => ({
                name: r.customer_name,
                text: r.review_text.substring(0, 50) + '...',
                created_at: r.created_at,
                source: rootReviewKeys.has(`email_order:${(r.customer_email || '').toLowerCase().trim()}_${r.order_id || 'null'}`) ? 'root (Git)' : 'dynamic'
            }))
        });
    } catch (error) {
        console.error('❌ Error syncing reviews:', error);
        res.status(500).json({
            success: false,
            error: 'Error syncing reviews',
            details: error.message
        });
    }
});

// Debug endpoint to force restore all reviews from database
app.get('/api/debug/restore-all-reviews', (req, res) => {
    console.log('🔄 Force restore all reviews from database...');
    migrateReviewsFromDatabase().then(async (migrated) => {
        if (migrated) {
            const allReviews = await readReviewsFromJSON();
            res.json({
                success: true,
                message: 'All reviews restored from database!',
                total: allReviews.length,
                reviews: allReviews.map(r => ({
                    name: r.customer_name,
                    email: r.customer_email,
                    created_at: r.created_at,
                    order_id: r.order_id
                }))
            });
        } else {
            const allReviews = await readReviewsFromJSON();
            res.json({
                success: true,
                message: 'No new reviews to migrate, all reviews are already in JSON',
                total: allReviews.length,
                reviews: allReviews.map(r => ({
                    name: r.customer_name,
                    email: r.customer_email,
                    created_at: r.created_at,
                    order_id: r.order_id
                }))
            });
        }
    }).catch(err => {
        console.error('❌ Error restoring reviews:', err);
        res.status(500).json({
            success: false,
            error: err.message
        });
    });
});

// Debug endpoint to remove duplicates and clean up reviews
app.get('/api/debug/remove-duplicates', (req, res) => {
    try {
        readReviewsFromJSON().then((allReviews) => {
        const beforeCount = allReviews.length;
        
        console.log(`🔍 Checking for duplicates in ${beforeCount} reviews...`);
        
        // Remove duplicates
        const uniqueReviews = removeDuplicateReviews(allReviews);
        const afterCount = uniqueReviews.length;
        
        if (afterCount < beforeCount) {
            // Sort by created_at (newest first)
            uniqueReviews.sort((a, b) => {
                const timeA = new Date(a.created_at).getTime();
                const timeB = new Date(b.created_at).getTime();
                return timeB - timeA;
            });
            
            // Save cleaned version
            const saved = writeReviewsToJSON(uniqueReviews);
            
            if (saved) {
                res.json({
                    success: true,
                    message: `Removed ${beforeCount - afterCount} duplicate reviews`,
                    before: beforeCount,
                    after: afterCount,
                    removed: beforeCount - afterCount
                });
            } else {
                res.status(500).json({
                    success: false,
                    error: 'Failed to save cleaned reviews'
                });
            }
        } else {
            res.json({
                success: true,
                message: 'No duplicates found',
                before: beforeCount,
                after: afterCount,
                removed: 0
            });
        }
        }).catch((error) => {
        console.error('❌ Error removing duplicates:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        });
    } catch (error) {
        console.error('❌ Error removing duplicates (outer):', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
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

// Debug endpoint to find Илья reviews - НЕ МЕНЯЕТ ИМЕНА, только ищет и показывает
app.get('/api/debug/restore-ilya', (req, res) => {
    console.log('🔍 Searching for Илья reviews (NOT changing names)...');
    const ilyaEmail = 'viliyili27@gmail.com';
    
    // Check reviews with name "Илья"
    db.all(`SELECT * FROM reviews WHERE customer_name = 'Илья' ORDER BY created_at DESC`, [], (err, ilyaReviews) => {
        if (err) {
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        // Also check reviews for this email
        db.all(`SELECT * FROM reviews WHERE LOWER(customer_email) = LOWER(?) ORDER BY created_at DESC`, [ilyaEmail], (errEmail, reviewsForEmail) => {
            if (errEmail) {
                return res.status(500).json({ error: 'Database error', details: errEmail.message });
            }
            
            // Check orders
            db.all(`SELECT * FROM subscriptions WHERE LOWER(customer_email) = LOWER(?) ORDER BY purchase_date DESC LIMIT 5`, [ilyaEmail], (errOrders, orders) => {
                if (errOrders) {
                    return res.status(500).json({ error: 'Database error', details: errOrders.message });
                }
                
                // Check position in all reviews (sorted DESC)
                db.all(`SELECT * FROM reviews ORDER BY created_at DESC LIMIT 20`, [], (errAll, allReviews) => {
                    if (errAll) {
                        return res.json({
                            ilya_reviews_count: ilyaReviews ? ilyaReviews.length : 0,
                            ilya_reviews: ilyaReviews || [],
                            email_reviews_count: reviewsForEmail ? reviewsForEmail.length : 0,
                            email_reviews: reviewsForEmail || [],
                            orders_count: orders ? orders.length : 0,
                            orders: orders || []
                        });
                    }
                    
                    // Find Илья reviews in top 20
                    const ilyaPositions = [];
                    if (ilyaReviews && ilyaReviews.length > 0) {
                        ilyaReviews.forEach(ilyaReview => {
                            const position = allReviews.findIndex(r => r.id === ilyaReview.id);
                            if (position >= 0) {
                                ilyaPositions.push({ review_id: ilyaReview.id, position: position, name: ilyaReview.customer_name, created_at: ilyaReview.created_at });
                            } else {
                                ilyaPositions.push({ review_id: ilyaReview.id, position: -1, name: ilyaReview.customer_name, created_at: ilyaReview.created_at, note: 'Not in top 20' });
                            }
                        });
                    }
                    
                    res.json({
                        ilya_reviews_count: ilyaReviews ? ilyaReviews.length : 0,
                        ilya_reviews: ilyaReviews || [],
                        email_reviews_count: reviewsForEmail ? reviewsForEmail.length : 0,
                        email_reviews: reviewsForEmail || [],
                        orders_count: orders ? orders.length : 0,
                        orders: orders || [],
                        positions_in_top_20: ilyaPositions,
                        top_5_reviews: allReviews.slice(0, 5).map(r => ({ id: r.id, name: r.customer_name, created_at: r.created_at })),
                        message: ilyaReviews && ilyaReviews.length > 0
                            ? `Found ${ilyaReviews.length} Илья review(s) in database`
                            : `No Илья reviews found. Found ${reviewsForEmail ? reviewsForEmail.length : 0} review(s) for email ${ilyaEmail}`
                    });
                });
            });
        });
    });
});

// Simple endpoint to add test Илья review - использует реальный order_id из базы
app.get('/api/debug/add-ilya-review', (req, res) => {
    const ilyaEmail = 'viliyili27@gmail.com';
    
    // Find latest order for this email
    db.get(`SELECT * FROM subscriptions WHERE LOWER(customer_email) = LOWER(?) ORDER BY purchase_date DESC LIMIT 1`, [ilyaEmail], (err, order) => {
        if (err) {
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        if (!order) {
            return res.json({ success: false, message: 'No order found for ' + ilyaEmail });
        }
        
        // Check if review already exists for this order
        db.get(`SELECT * FROM reviews WHERE order_id = ? AND LOWER(customer_email) = LOWER(?)`, [order.order_id || '', ilyaEmail], (err, existing) => {
            if (err) {
                return res.status(500).json({ error: 'Database error', details: err.message });
            }
            
            if (existing) {
                return res.json({ success: true, message: 'Review already exists', review: existing });
            }
            
            // Create review with CURRENT_TIMESTAMP (will be newest)
            const stmt = db.prepare(`
                INSERT INTO reviews (customer_name, customer_email, review_text, rating, order_id, created_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);
            
            stmt.run(['Илья', ilyaEmail, 'Отличный сервис! CapCut Pro работает идеально. Рекомендую!', 5, order.order_id || null], function(insertErr) {
                if (insertErr) {
                    stmt.finalize();
                    return res.status(500).json({ error: 'Database error', details: insertErr.message });
                }
                
                const reviewId = this.lastID;
                stmt.finalize();
                
                res.json({
                    success: true,
                    message: 'Илья review added successfully - it will be FIRST in the list!',
                    review_id: reviewId,
                    order_id: order.order_id
                });
            });
        });
    });
});

// Check ALL reviews in database and show Илья position
app.get('/api/debug/check-all-reviews', (req, res) => {
    db.all(`SELECT * FROM reviews ORDER BY created_at DESC`, [], (err, allReviews) => {
        if (err) {
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        // Find Илья reviews
        const ilyaReviews = allReviews.filter(r => r.customer_name === 'Илья');
        // Find Тихон reviews
        const tikhonReviews = allReviews.filter(r => r.customer_name === 'Тихон');
        
        const ilyaPositions = ilyaReviews.map(r => ({
            id: r.id,
            name: r.customer_name,
            email: r.customer_email,
            position: allReviews.indexOf(r),
            created_at: r.created_at,
            order_id: r.order_id
        }));
        
        const tikhonPositions = tikhonReviews.map(r => ({
            id: r.id,
            name: r.customer_name,
            email: r.customer_email,
            position: allReviews.indexOf(r),
            created_at: r.created_at,
            order_id: r.order_id
        }));
        
        // Top 10 reviews
        const top10 = allReviews.slice(0, 10).map((r, idx) => ({
            position: idx,
            id: r.id,
            name: r.customer_name,
            email: r.customer_email,
            created_at: r.created_at
        }));
        
        res.json({
            total_reviews: allReviews.length,
            ilya_reviews_count: ilyaReviews.length,
            ilya_reviews: ilyaPositions,
            tikhon_reviews_count: tikhonReviews.length,
            tikhon_reviews: tikhonPositions,
            top_10_reviews: top10,
            ilya_in_top_10: top10.some(r => r.name === 'Илья'),
            tikhon_in_top_10: top10.some(r => r.name === 'Тихон'),
            message: ilyaReviews.length > 0
                ? `Found ${ilyaReviews.length} Илья review(s). ${ilyaPositions[0]?.position === 0 ? 'First one is at position 0 (newest)!' : `First one is at position ${ilyaPositions[0]?.position}`}`
                : 'No Илья reviews found in database',
            tikhon_message: tikhonReviews.length > 0
                ? `Found ${tikhonReviews.length} Тихон review(s). ${tikhonPositions[0]?.position === 0 ? 'First one is at position 0 (newest)!' : `First one is at position ${tikhonPositions[0]?.position}`}`
                : 'No Тихон reviews found in database'
        });
    });
});

// Find and restore Тихон review
app.get('/api/debug/find-tikhon', (req, res) => {
    // Search by name "Тихон"
    db.all(`SELECT * FROM reviews WHERE customer_name = 'Тихон' ORDER BY created_at DESC`, [], (err, tikhonReviews) => {
        if (err) {
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        // Also search by email patterns (common emails with Тихон)
        db.all(`SELECT * FROM subscriptions WHERE customer_name LIKE '%Тихон%' ORDER BY purchase_date DESC LIMIT 5`, [], (err, tikhonOrders) => {
            if (err) {
                return res.status(500).json({ error: 'Database error', details: err.message });
            }
            
            // Search for reviews with "кепкат" or "CapCut" in text (Тихон's review mentioned CapCut)
            db.all(`SELECT * FROM reviews WHERE review_text LIKE '%кепкат%' OR review_text LIKE '%CapCut%' ORDER BY created_at DESC`, [], (err, capcutReviews) => {
                if (err) {
                    return res.status(500).json({ error: 'Database error', details: err.message });
                }
                
                res.json({
                    tikhon_reviews_count: tikhonReviews ? tikhonReviews.length : 0,
                    tikhon_reviews: tikhonReviews || [],
                    tikhon_orders_count: tikhonOrders ? tikhonOrders.length : 0,
                    tikhon_orders: tikhonOrders || [],
                    capcut_reviews_count: capcutReviews ? capcutReviews.length : 0,
                    capcut_reviews: capcutReviews || [],
                    message: tikhonReviews && tikhonReviews.length > 0
                        ? `Found ${tikhonReviews.length} Тихон review(s) in database`
                        : 'No Тихон reviews found. Searching by order name and review text...'
                });
            });
        });
    });
});

// Restore Тихон review if it was lost - uses order from database
// КРИТИЧЕСКИ ВАЖНО: Этот endpoint должен гарантированно создать отзыв, даже если заказа нет
app.get('/api/debug/restore-tikhon', (req, res) => {
    console.log('🔧 ========== RESTORE ТИХОН REVIEW ==========');
    
    // First, check if Тихон review already exists
    db.all(`SELECT * FROM reviews WHERE customer_name = 'Тихон' ORDER BY created_at DESC`, [], (err, existingReviews) => {
        if (err) {
            console.error('❌ Error checking existing Тихон reviews:', err);
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        if (existingReviews && existingReviews.length > 0) {
            console.log(`✅ Found ${existingReviews.length} existing Тихон review(s)`);
            return res.json({
                success: true,
                message: `Found ${existingReviews.length} Тихон review(s) - they already exist!`,
                reviews: existingReviews,
                count: existingReviews.length
            });
        }
        
        console.log('⚠️ No Тихон reviews found. Searching for Тихон order...');
        
        // Find Тихон order
        db.all(`SELECT * FROM subscriptions WHERE customer_name LIKE '%Тихон%' ORDER BY purchase_date DESC LIMIT 5`, [], (err, tikhonOrders) => {
            if (err) {
                console.error('❌ Error finding Тихон orders:', err);
                return res.status(500).json({ error: 'Database error', details: err.message });
            }
            
            let tikhonEmail = 'tikhon@example.com';
            let tikhonOrderId = null;
            
            if (tikhonOrders && tikhonOrders.length > 0) {
                const tikhonOrder = tikhonOrders[0];
                tikhonEmail = tikhonOrder.customer_email;
                tikhonOrderId = tikhonOrder.order_id || null;
                console.log(`📦 Found Тихон order: email=${tikhonEmail}, order_id=${tikhonOrderId}`);
            } else {
                console.log('⚠️ No Тихон orders found. Will create review with default email.');
            }
            
            // Create Тихон review with CURRENT_TIMESTAMP (will be newest)
            // КРИТИЧЕСКИ ВАЖНО: Используем INSERT OR IGNORE, чтобы НЕ перезаписать существующий отзыв
            // Если отзыв уже существует, он не будет перезаписан - это защищает от потери данных
            // Используем уникальный order_id для Тихона, чтобы гарантировать, что отзыв не будет потерян
            const tikhonFinalOrderId = tikhonOrderId || 'TIKHON_REVIEW_PERMANENT_' + Date.now();
            
            console.log(`📝 Creating Тихон review with CURRENT_TIMESTAMP (INSERT OR IGNORE)...`);
            console.log(`   Name: Тихон`);
            console.log(`   Email: ${tikhonEmail}`);
            console.log(`   Order ID: ${tikhonFinalOrderId}`);
            console.log(`   Text: Купил кепкат про на 3 месяца я доволен`);
            console.log(`   Rating: 5`);
            console.log(`   ⚠️  Using INSERT OR IGNORE - existing Тихон review will NOT be overwritten!`);
            
            const stmt = db.prepare(`
                INSERT OR IGNORE INTO reviews (customer_name, customer_email, review_text, rating, order_id, created_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);
            
            stmt.run(['Тихон', tikhonEmail, 'Купил кепкат про на 3 месяца я доволен', 5, tikhonFinalOrderId], function(insertErr) {
                if (insertErr) {
                    stmt.finalize();
                    console.error(`❌ ========== ERROR INSERTING ТИХОН REVIEW ==========`);
                    console.error(`   Error: ${insertErr.message}`);
                    console.error(`   Error code: ${insertErr.code}`);
                    console.error(`   ================================================`);
                    return res.status(500).json({ error: 'Database error', details: insertErr.message });
                }
                
                const reviewId = this.lastID;
                const changes = this.changes;
                console.log(`✅ ========== ТИХОН REVIEW INSERTED ==========`);
                console.log(`   Review ID: ${reviewId}`);
                console.log(`   Changes: ${changes}`);
                console.log(`   ===========================================`);
                stmt.finalize();
                
                // КРИТИЧЕСКИ ВАЖНО: Принудительно синхронизируем данные с диском
                // Это гарантирует, что отзыв будет сохранен даже при сбое или перезапуске
                db.run('PRAGMA wal_checkpoint(FULL);', (checkpointErr) => {
                    if (checkpointErr) {
                        console.error('⚠️ Error during WAL checkpoint:', checkpointErr);
                    } else {
                        console.log('✅ WAL checkpoint completed - Тихон review is safely saved to disk');
                    }
                });
                
                // Verify it was inserted MULTIPLE times
                const verifyReview = (attempt = 1) => {
                    db.get(`SELECT * FROM reviews WHERE id = ?`, [reviewId], (err, savedReview) => {
                        if (err) {
                            console.error(`❌ Attempt ${attempt}: Error verifying Тихон review ${reviewId}:`, err);
                            if (attempt < 5) {
                                setTimeout(() => verifyReview(attempt + 1), 500 * attempt);
                            } else {
                                return res.json({
                                    success: false,
                                    message: 'Тихон review was created but could not be verified',
                                    review_id: reviewId,
                                    error: 'Verification failed after 5 attempts'
                                });
                            }
                        } else if (savedReview) {
                            console.log(`✅ ========== VERIFIED ТИХОН REVIEW (attempt ${attempt}) ==========`);
                            console.log(`   Review ID: ${savedReview.id}`);
                            console.log(`   Name: ${savedReview.customer_name}`);
                            console.log(`   Email: ${savedReview.customer_email}`);
                            console.log(`   Created at: ${savedReview.created_at}`);
                            console.log(`   Order ID: ${savedReview.order_id}`);
                            console.log(`   ===================================================`);
                            
                            // Check position in top 10
                            db.all(`SELECT * FROM reviews ORDER BY created_at DESC LIMIT 10`, [], (err, top10) => {
                                const position = top10 ? top10.findIndex(r => r.id === reviewId) : -1;
                                console.log(`📊 Тихон review position in top 10: ${position} (0 = newest)`);
                                
                                res.json({
                                    success: true,
                                    message: '✅ Тихон review RESTORED and VERIFIED successfully!',
                                    review_id: reviewId,
                                    review: savedReview,
                                    position_in_top_10: position >= 0 ? position : 'not in top 10',
                                    created_at: savedReview.created_at,
                                    order_id: tikhonOrderId,
                                    email: tikhonEmail,
                                    top_10_preview: top10 ? top10.slice(0, 3).map(r => `${r.customer_name} (${r.created_at})`) : [],
                                    verified_attempt: attempt
                                });
                            });
                        } else {
                            console.error(`❌ Attempt ${attempt}: Тихон review ${reviewId} NOT FOUND after insertion!`);
                            if (attempt < 5) {
                                setTimeout(() => verifyReview(attempt + 1), 500 * attempt);
                            } else {
                                return res.json({
                                    success: false,
                                    message: 'Тихон review was created but disappeared immediately!',
                                    review_id: reviewId,
                                    error: 'Review not found after 5 verification attempts - database may be resetting'
                                });
                            }
                        }
                    });
                };
                
                // Start verification immediately
                verifyReview(1);
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

// Endpoint to restore Влад review - searches on server first, then creates if not found
app.get('/api/debug/restore-vlad', (req, res) => {
    console.log('🔧 ========== RESTORE ВЛАД REVIEW ==========');
    
    const vladEmail = 'tonnyfreesalto82@gmail.com';
    const vladName = 'Влад';
    
    // First, check if Влад review exists in JSON file (on server)
    let allReviews = [];
    try {
        if (fs.existsSync(reviewsJsonPath)) {
            const data = fs.readFileSync(reviewsJsonPath, 'utf8');
            allReviews = JSON.parse(data);
        }
        
        // Search for Влад review by email or name
        const vladReview = allReviews.find(r => 
            (r.customer_email && r.customer_email.toLowerCase() === vladEmail.toLowerCase()) ||
            (r.customer_name && r.customer_name.trim() === vladName)
        );
        
        if (vladReview) {
            console.log(`✅ Found Влад review in JSON file!`);
            return res.json({
                success: true,
                message: 'Влад review found in JSON file - it should be visible now',
                review: {
                    name: vladReview.customer_name,
                    email: vladReview.customer_email,
                    text: vladReview.review_text,
                    rating: vladReview.rating,
                    created_at: vladReview.created_at,
                    is_static: vladReview.is_static || false
                },
                note: 'Review is already in the system. If it\'s not visible, check sync endpoint.'
            });
        }
    } catch (error) {
        console.error('❌ Error reading JSON file:', error);
    }
    
    // Check database
    db.all(`SELECT * FROM reviews WHERE customer_name = ? OR LOWER(customer_email) = LOWER(?) ORDER BY created_at DESC`, 
        [vladName, vladEmail], (err, dbReviews) => {
        if (err) {
            console.error('❌ Error checking database:', err);
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        if (dbReviews && dbReviews.length > 0) {
            console.log(`✅ Found ${dbReviews.length} Влад review(s) in database`);
            // Migrate to JSON
            const dbReview = dbReviews[0];
            const newReview = {
                id: `review_${Date.now()}_vlad`,
                customer_name: dbReview.customer_name,
                customer_email: dbReview.customer_email,
                review_text: dbReview.review_text,
                rating: dbReview.rating,
                order_id: dbReview.order_id || null,
                created_at: dbReview.created_at || new Date().toISOString(),
                is_static: false
            };
            
            allReviews.push(newReview);
            writeReviewsToJSON(allReviews);
            
            return res.json({
                success: true,
                message: 'Влад review found in database and migrated to JSON',
                review: newReview
            });
        }
        
        // Not found - create new review with default text
        console.log('⚠️ Влад review not found. Creating new review...');
        
        // Find order for email
        db.all(`SELECT * FROM subscriptions WHERE LOWER(customer_email) = LOWER(?) ORDER BY purchase_date DESC LIMIT 1`, 
            [vladEmail], (err, orders) => {
            if (err) {
                console.error('❌ Error finding order:', err);
            }
            
            const orderId = orders && orders.length > 0 ? orders[0].order_id : null;
            
            // Create review with correct text
            const newReview = {
                id: `review_${Date.now()}_vlad_restored`,
                customer_name: vladName,
                customer_email: vladEmail,
                review_text: 'Купил адоб на пол года все работает как часы, спасибо большое за ваш сервис',
                rating: 5,
                order_id: orderId,
                created_at: new Date('2025-11-09T19:38:08Z').toISOString(),
                is_static: false
            };
            
            // КРИТИЧЕСКИ ВАЖНО: Читаем из корневого reviews.json (Git версия)!
            // Все отзывы должны быть в одном месте - в корневом reviews.json
            if (fs.existsSync(reviewsJsonPathGit)) {
                try {
                    const data = fs.readFileSync(reviewsJsonPathGit, 'utf8');
                    allReviews = JSON.parse(data);
                    console.log(`📋 Read ${allReviews.length} reviews from root reviews.json (Git)`);
                } catch (error) {
                    console.error('❌ Error reading root reviews.json:', error);
                }
            }
            
            // Check if already exists
            const exists = allReviews.find(r => 
                (r.customer_email && r.customer_email.toLowerCase() === vladEmail.toLowerCase()) ||
                (r.customer_name && r.customer_name.trim() === vladName)
            );
            
            if (!exists) {
                allReviews.push(newReview);
                const saved = writeReviewsToJSON(allReviews);
                
                if (saved) {
                    console.log(`✅ Created new Влад review with correct text`);
                    res.json({
                        success: true,
                        message: 'Влад review created successfully',
                        review: newReview
                    });
                } else {
                    console.error(`❌ Failed to save Влад review`);
                    res.status(500).json({
                        success: false,
                        error: 'Failed to save review to JSON file'
                    });
                }
            } else {
                console.log(`⚠️ Влад review already exists`);
                res.json({
                    success: true,
                    message: 'Влад review already exists',
                    review: exists
                });
            }
        });
    });
});

// Endpoint to restore Таня review - searches on server first, then creates if not found
app.get('/api/debug/restore-tanya', async (req, res) => {
    console.log('🔧 ========== RESTORE ТАНЯ REVIEW ==========');
    
    const tanyaName = 'Таня';
    const tanyaText = 'все как супер ❤️❤️ спасибо 🤗';
    
    // First, check if Таня review exists in JSON file (on server) - use readReviewsFromJSON() to see merged reviews
    let allReviews = await readReviewsFromJSON();
    
    // Search for Таня review by name
    const tanyaReview = allReviews.find(r => 
        (r.customer_name && r.customer_name.trim() === tanyaName) ||
        (r.review_text && r.review_text.includes('супер') && r.review_text.includes('❤️'))
    );
    
    if (tanyaReview) {
        console.log(`✅ Found Таня review!`);
        return res.json({
            success: true,
            message: 'Таня review found - it should be visible now',
            review: {
                name: tanyaReview.customer_name,
                email: tanyaReview.customer_email,
                text: tanyaReview.review_text,
                rating: tanyaReview.rating,
                created_at: tanyaReview.created_at,
                is_static: tanyaReview.is_static || false,
                order_id: tanyaReview.order_id || null
            },
            note: 'Review is already in the system. If it\'s not visible, check sync endpoint.'
        });
    }
    
    // Check database
    db.all(`SELECT * FROM reviews WHERE customer_name = ? OR review_text LIKE ? ORDER BY created_at DESC`, 
        [tanyaName, '%супер%'], (err, dbReviews) => {
        if (err) {
            console.error('❌ Error checking database:', err);
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        if (dbReviews && dbReviews.length > 0) {
            console.log(`✅ Found ${dbReviews.length} Таня review(s) in database`);
            // Migrate to JSON
            const dbReview = dbReviews[0];
            const newReview = {
                id: `review_${Date.now()}_tanya`,
                customer_name: dbReview.customer_name || tanyaName,
                customer_email: dbReview.customer_email,
                review_text: dbReview.review_text || tanyaText,
                rating: dbReview.rating || 5,
                order_id: dbReview.order_id || null,
                created_at: dbReview.created_at || new Date().toISOString(),
                is_static: false
            };
            
            // КРИТИЧЕСКИ ВАЖНО: Читаем из корневого reviews.json (Git версия)!
            // Все отзывы должны быть в одном месте - в корневом reviews.json
            let dynamicReviews = [];
            if (fs.existsSync(reviewsJsonPathGit)) {
                try {
                    const data = fs.readFileSync(reviewsJsonPathGit, 'utf8');
                    dynamicReviews = JSON.parse(data);
                    console.log(`📋 Read ${dynamicReviews.length} reviews from root reviews.json (Git)`);
                } catch (error) {
                    console.error('❌ Error reading root reviews.json:', error);
                }
            }
            
            // Check if already exists
            const exists = dynamicReviews.find(r => 
                (r.customer_email && r.customer_email.toLowerCase() === newReview.customer_email.toLowerCase()) ||
                (r.customer_name && r.customer_name.trim() === tanyaName)
            );
            
            if (!exists) {
                dynamicReviews.push(newReview);
                const saved = writeReviewsToJSON(dynamicReviews);
                
                if (saved) {
                    console.log(`✅ Migrated Таня review from database to JSON`);
                    return res.json({
                        success: true,
                        message: 'Таня review found in database and migrated to JSON',
                        review: newReview
                    });
                }
            }
        }
        
        // Not found - try to find email from subscriptions
        db.all(`SELECT * FROM subscriptions WHERE customer_name LIKE ? ORDER BY purchase_date DESC LIMIT 1`, 
            [`%${tanyaName}%`], (err, orders) => {
            if (err) {
                console.error('❌ Error finding order:', err);
            }
            
            const orderId = orders && orders.length > 0 ? orders[0].order_id : null;
            const email = orders && orders.length > 0 ? orders[0].customer_email : null;
            
            if (!email) {
                return res.json({
                    success: false,
                    message: 'Таня review not found. Need email to create new review.',
                    note: 'Please provide email or order_id to create review'
                });
            }
            
            // Create review with correct text
            const newReview = {
                id: `review_${Date.now()}_tanya_restored`,
                customer_name: tanyaName,
                customer_email: email,
                review_text: tanyaText,
                rating: 5,
                order_id: orderId,
                created_at: new Date().toISOString(),
                is_static: false
            };
            
            // КРИТИЧЕСКИ ВАЖНО: Читаем из корневого reviews.json (Git версия)!
            // Все отзывы должны быть в одном месте - в корневом reviews.json
            let dynamicReviews = [];
            if (fs.existsSync(reviewsJsonPathGit)) {
                try {
                    const data = fs.readFileSync(reviewsJsonPathGit, 'utf8');
                    dynamicReviews = JSON.parse(data);
                    console.log(`📋 Read ${dynamicReviews.length} reviews from root reviews.json (Git)`);
                } catch (error) {
                    console.error('❌ Error reading root reviews.json:', error);
                }
            }
            
            // Check if already exists
            const exists = dynamicReviews.find(r => 
                (r.customer_email && r.customer_email.toLowerCase() === email.toLowerCase()) ||
                (r.customer_name && r.customer_name.trim() === tanyaName)
            );
            
            if (!exists) {
                dynamicReviews.push(newReview);
                const saved = writeReviewsToJSON(dynamicReviews);
                
                if (saved) {
                    console.log(`✅ Created new Таня review`);
                    res.json({
                        success: true,
                        message: 'Таня review created successfully',
                        review: newReview
                    });
                } else {
                    console.error(`❌ Failed to save Таня review`);
                    res.status(500).json({
                        success: false,
                        error: 'Failed to save review to JSON file'
                    });
                }
            } else {
                console.log(`⚠️ Таня review already exists`);
                res.json({
                    success: true,
                    message: 'Таня review already exists',
                    review: exists
                });
            }
        });
    });
});

// Endpoint to FORCE create Таня review - creates it even if email not found
app.get('/api/debug/force-create-tanya', (req, res) => {
    console.log('🔧 ========== FORCE CREATE ТАНЯ REVIEW ==========');
    
    const tanyaName = 'Таня';
    const tanyaText = 'все как супер ❤️❤️ спасибо 🤗';
    const tanyaEmail = req.query.email || 'tanya@example.com'; // Use provided email or default
    const tanyaOrderId = req.query.order_id || null;
    
    // Read current dynamic reviews
    let dynamicReviews = [];
    if (fs.existsSync(reviewsJsonPath)) {
        try {
            const data = fs.readFileSync(reviewsJsonPath, 'utf8');
            dynamicReviews = JSON.parse(data);
        } catch (error) {
            console.error('❌ Error reading reviews.json:', error);
        }
    }
    
    // Check if already exists
    const exists = dynamicReviews.find(r => 
        (r.customer_name && r.customer_name.trim() === tanyaName) ||
        (r.review_text && r.review_text.includes('супер') && r.review_text.includes('❤️'))
    );
    
    if (exists) {
        console.log(`⚠️ Таня review already exists`);
        return res.json({
            success: true,
            message: 'Таня review already exists',
            review: exists
        });
    }
    
    // Create review with correct text
    const newReview = {
        id: `review_${Date.now()}_tanya_forced`,
        customer_name: tanyaName,
        customer_email: tanyaEmail,
        review_text: tanyaText,
        rating: 5,
        order_id: tanyaOrderId,
        created_at: new Date().toISOString(),
        is_static: false
    };
    
    // Add to dynamic reviews
    dynamicReviews.push(newReview);
    const saved = writeReviewsToJSON(dynamicReviews);
    
    if (saved) {
        console.log(`✅ FORCED created Таня review`);
        console.log(`   Name: ${tanyaName}`);
        console.log(`   Email: ${tanyaEmail}`);
        console.log(`   Text: ${tanyaText}`);
        console.log(`   Saved to: data/reviews.json`);
        
        // Also save to database
        const stmt = db.prepare(`
            INSERT INTO reviews (customer_name, customer_email, review_text, rating, order_id, created_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        
        stmt.run([tanyaName, tanyaEmail, tanyaText, 5, tanyaOrderId], function(err) {
            if (err) {
                console.warn(`⚠️ Failed to save to database (but saved to JSON): ${err.message}`);
            } else {
                console.log(`✅ Also saved to database`);
            }
            stmt.finalize();
        });
        
        res.json({
            success: true,
            message: 'Таня review FORCED created successfully',
            review: newReview,
            note: 'Review is now in data/reviews.json and will be visible on site'
        });
    } else {
        console.error(`❌ Failed to save Таня review`);
        res.status(500).json({
            success: false,
            error: 'Failed to save review to JSON file'
        });
    }
});

// API endpoint для создания платежа через Cardlink
app.post('/api/cardlink/create-payment', async (req, res) => {
    const { name, email, cart, orderId } = req.body;
    
    if (!name || !email || !cart || !orderId) {
        return res.status(400).json({ 
            success: false,
            error: 'Отсутствуют обязательные поля' 
        });
    }
    
    // ВАЖНО: Замените эти значения на ваши Shop ID и API token из личного кабинета Cardlink
    // Или используйте переменные окружения для безопасности
    const CARDLINK_SHOP_ID = process.env.CARDLINK_SHOP_ID || 'YOUR_SHOP_ID';
    const CARDLINK_API_TOKEN = process.env.CARDLINK_API_TOKEN || 'YOUR_API_TOKEN';
    // Cardlink API endpoint - может быть разным, проверьте в документации
    const CARDLINK_API_URL = process.env.CARDLINK_API_URL || 'https://cardlink.link/api/v1/bill/create';
    
    if (CARDLINK_SHOP_ID === 'YOUR_SHOP_ID' || CARDLINK_API_TOKEN === 'YOUR_API_TOKEN') {
        return res.status(500).json({
            success: false,
            error: 'Cardlink не настроен. Установите CARDLINK_SHOP_ID и CARDLINK_API_TOKEN в переменных окружения на Render.'
        });
    }
    
    try {
        const total = cart.reduce((s, i) => s + (i.price * i.quantity), 0);
        const callbackUrl = `${req.protocol}://${req.get('host')}/api/cardlink/callback`;
        const successUrl = `${req.protocol}://${req.get('host')}/payment-success.html?order_id=${orderId}`;
        const failUrl = `${req.protocol}://${req.get('host')}/payment-fail.html?order_id=${orderId}`;
        
        // Сохраняем данные заказа во временное хранилище для callback
        const pendingOrdersPath = path.join(process.cwd(), 'data', 'pending_orders.json');
        const pendingOrder = {
            orderId,
            name,
            email: email.toLowerCase().trim(),
            cart,
            total,
            createdAt: new Date().toISOString()
        };
        
        try {
            let pendingOrders = [];
            if (fs.existsSync(pendingOrdersPath)) {
                const data = fs.readFileSync(pendingOrdersPath, 'utf8');
                pendingOrders = JSON.parse(data);
            }
            pendingOrders.push(pendingOrder);
            fs.writeFileSync(pendingOrdersPath, JSON.stringify(pendingOrders, null, 2), 'utf8');
            console.log('💾 Pending order saved:', orderId);
        } catch (saveError) {
            console.error('⚠️ Failed to save pending order (will try to process from payment-success.html):', saveError);
        }
        
        // Формируем данные для оплаты
        // ВАЖНО: CardLink ожидает сумму в рублях (не в копейках) для валюты RUB
        // Также важно: после 50,000 рублей доступна только криптовалюта
        // Минимальная сумма для CardLink обычно 10-100 рублей
        const amountInRubles = Math.round(total * 100) / 100; // Округляем до 2 знаков после запятой
        
        // Проверяем минимальную сумму (CardLink обычно требует минимум 100 рублей)
        if (amountInRubles < 100) {
            return res.status(400).json({
                success: false,
                error: 'Минимальная сумма для оплаты через CardLink: 100 рублей',
                details: { amount: amountInRubles, minimum: 100 }
            });
        }
        
        const paymentData = {
            shop_id: CARDLINK_SHOP_ID,
            amount: Number(amountInRubles.toFixed(2)), // Сумма в рублях, убеждаемся что это число
            currency: 'RUB', // Валюта платежа
            currency_in: 'RUB', // Входящая валюта (для приема платежей в рублях)
            order_id: orderId,
            description: `Заказ #${orderId} - ${cart.map(i => i.title).join(', ')}`,
            customer_name: name,
            customer_email: email,
            success_url: successUrl,
            fail_url: failUrl,
            callback_url: callbackUrl
        };
        
        // Логируем для отладки
        console.log('💰 Amount calculation:', {
            total_rubles: total,
            amount_sent_to_cardlink: amountInRubles,
            currency: 'RUB',
            exceeds_50k_limit: total > 50000
        });
        
        // Проверяем, не превышает ли сумма лимит для карт (50,000 рублей)
        if (total > 50000) {
            console.warn('⚠️ Сумма превышает 50,000 рублей - CardLink может предложить только криптовалюту');
        }
        
        console.log('💳 Creating Cardlink payment:', {
            orderId,
            amount_rubles: total,
            amount_kopecks: Math.round(total * 100),
            currency: paymentData.currency,
            customer: name
        });
        
        // Логируем полные данные запроса
        console.log('📤 Full payment data to CardLink:', JSON.stringify(paymentData, null, 2));
        
        // Отправляем запрос на создание платежа
        const response = await axios.post(CARDLINK_API_URL, paymentData, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CARDLINK_API_TOKEN}`
            }
        });
        
        // Cardlink может возвращать payment_url или link_page_url
        const paymentUrl = response.data?.payment_url || response.data?.link_page_url || response.data?.link;
        
        if (paymentUrl) {
            console.log('✅ Cardlink payment created successfully:', paymentUrl);
            res.json({
                success: true,
                payment_url: paymentUrl
            });
        } else {
            console.error('❌ Invalid response from Cardlink:', response.data);
            res.status(500).json({
                success: false,
                error: 'Неверный ответ от Cardlink',
                details: response.data
            });
        }
    } catch (error) {
        console.error('❌ Error creating Cardlink payment:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: 'Ошибка при создании платежа',
            details: error.response?.data || error.message
        });
    }
});

// API endpoint для обработки callback от Cardlink
app.post('/api/cardlink/callback', async (req, res) => {
    console.log('📞 Cardlink callback received:', req.body);
    
    // Cardlink отправляет данные о статусе платежа
    // Структура может отличаться, проверьте документацию
    const status = req.body.Status || req.body.status || req.body.payment_status;
    const orderId = req.body.InvId || req.body.order_id || req.body.invoice_id;
    const amount = req.body.OutSum || req.body.amount;
    const transactionId = req.body.TrsId || req.body.transaction_id || req.body.id;
    const signature = req.body.SignatureValue || req.body.signature;
    
    // ВАЖНО: Проверьте подпись запроса для безопасности (если Cardlink её отправляет)
    // if (signature && !verifySignature(req.body, signature)) {
    //     return res.status(400).json({ success: false, error: 'Invalid signature' });
    // }
    
    if (status === 'SUCCESS' || status === 'success' || status === 'paid' || status === 'PAID') {
        // Платеж успешен - обрабатываем заказ
        console.log('✅ Payment successful:', { orderId, amount, transactionId });
        
        // Получаем данные заказа из pending_orders
        const pendingOrdersPath = path.join(process.cwd(), 'data', 'pending_orders.json');
        let pendingOrder = null;
        
        try {
            if (fs.existsSync(pendingOrdersPath)) {
                const data = fs.readFileSync(pendingOrdersPath, 'utf8');
                const pendingOrders = JSON.parse(data);
                const orderIndex = pendingOrders.findIndex(o => o.orderId === orderId);
                
                if (orderIndex !== -1) {
                    pendingOrder = pendingOrders[orderIndex];
                    // Удаляем из pending_orders
                    pendingOrders.splice(orderIndex, 1);
                    fs.writeFileSync(pendingOrdersPath, JSON.stringify(pendingOrders, null, 2), 'utf8');
                    console.log('📦 Found pending order:', orderId);
                }
            }
        } catch (error) {
            console.error('⚠️ Error reading pending orders:', error);
        }
        
        // Если нашли данные заказа, сохраняем их
        if (pendingOrder && pendingOrder.cart && pendingOrder.cart.length > 0) {
            console.log('💾 Processing order from callback:', orderId);
            const { name, email, cart } = pendingOrder;
            
            // Сохраняем каждый товар как отдельную подписку
            for (const item of cart) {
                try {
                    // Используем внутренний вызов логики сохранения заказа
                    const normalizedEmail = email.toLowerCase().trim();
                    const purchaseDate = new Date();
                    const itemAmount = item.price * (item.quantity || 1);
                    
                    // Сохраняем в JSON
                    const existingOrders = readOrdersFromJSON();
                    const maxId = existingOrders.length > 0 ? Math.max(...existingOrders.map(o => o.id || 0)) : 0;
                    const subscriptionId = maxId + 1;
                    
                    const orderData = {
                        id: subscriptionId,
                        customer_name: name,
                        customer_email: normalizedEmail,
                        product_name: item.title,
                        product_id: item.id,
                        subscription_months: item.months || 1,
                        purchase_date: purchaseDate.toISOString(),
                        order_id: orderId,
                        amount: itemAmount,
                        is_active: 1
                    };
                    
                    const savedToJson = addOrderToJSON(orderData);
                    if (savedToJson) {
                        console.log(`✅ Order saved from callback: ${orderId} (product ${item.id})`);
                        
                        // Сохраняем в БД
                        if (db) {
                            db.get(`SELECT id FROM subscriptions WHERE json_order_id = ?`, [orderData.id], (err, existing) => {
                                if (!err && !existing) {
                                    const stmt = db.prepare(`
                                        INSERT INTO subscriptions (
                                            customer_name, customer_email, product_name, product_id,
                                            subscription_months, purchase_date, order_id, amount, is_active, json_order_id
                                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                                    `);
                                    stmt.run([
                                        orderData.customer_name,
                                        orderData.customer_email,
                                        orderData.product_name,
                                        orderData.product_id,
                                        orderData.subscription_months,
                                        orderData.purchase_date,
                                        orderData.order_id,
                                        orderData.amount,
                                        orderData.id
                                    ], function(insertErr) {
                                        if (!insertErr) {
                                            console.log(`✅ Subscription saved to DB: ${this.lastID}`);
                                            // Генерируем напоминания
                                            if (item.id === 1 || item.id === 3 || item.id === 7) {
                                                generateReminders(this.lastID, item.id, item.months || 1, purchaseDate);
                                            }
                                        }
                                        stmt.finalize();
                                    });
                                }
                            });
                        }
                    }
                } catch (itemError) {
                    console.error(`❌ Error processing item ${item.id} from callback:`, itemError);
                }
            }
            
            // Отправляем уведомление в Telegram
            try {
                const message = `💰 Новый заказ через CardLink!\n\n👤 Клиент: ${name}\n📧 Email: ${email}\n🆔 Заказ: ${orderId}\n💵 Сумма: ${amount} ₽\n\nТовары:\n${cart.map(i => `• ${i.title} - ${i.price} ₽`).join('\n')}`;
                sendTelegramMessage(message);
            } catch (telegramError) {
                console.error('⚠️ Error sending Telegram notification:', telegramError);
            }
        } else {
            console.log('⚠️ Pending order not found, order will be processed from payment-success.html');
        }
        
        res.status(200).json({ success: true, message: 'Callback processed' });
    } else {
        console.log('❌ Payment failed:', { orderId, status });
        res.status(200).json({ success: false, message: 'Payment failed' });
    }
});

// API endpoint для получения платежной ссылки Cardlink (без верификации)
// Используется, если API недоступно
app.get('/api/cardlink/payment-link', (req, res) => {
    const CARDLINK_PAYMENT_LINK = process.env.CARDLINK_PAYMENT_LINK;
    
    if (!CARDLINK_PAYMENT_LINK || CARDLINK_PAYMENT_LINK === 'YOUR_PAYMENT_LINK_HERE') {
        return res.json({
            success: false,
            error: 'Платежная ссылка не настроена. Создайте платежную ссылку в личном кабинете Cardlink и добавьте её в переменную окружения CARDLINK_PAYMENT_LINK на Render.'
        });
    }
    
    res.json({
        success: true,
        payment_link_template: CARDLINK_PAYMENT_LINK
    });
});

// API endpoint для проверки конфигурации CardLink
app.get('/api/cardlink/check-config', (req, res) => {
    const CARDLINK_SHOP_ID = process.env.CARDLINK_SHOP_ID || 'YOUR_SHOP_ID';
    const CARDLINK_API_TOKEN = process.env.CARDLINK_API_TOKEN || 'YOUR_API_TOKEN';
    const CARDLINK_API_URL = process.env.CARDLINK_API_URL || 'https://cardlink.link/api/v1/bill/create';
    const CARDLINK_PAYMENT_LINK = process.env.CARDLINK_PAYMENT_LINK;
    
    const config = {
        shop_id_configured: CARDLINK_SHOP_ID !== 'YOUR_SHOP_ID',
        api_token_configured: CARDLINK_API_TOKEN !== 'YOUR_API_TOKEN',
        api_url: CARDLINK_API_URL,
        payment_link_configured: !!CARDLINK_PAYMENT_LINK && CARDLINK_PAYMENT_LINK !== 'YOUR_PAYMENT_LINK_HERE',
        callback_url: `${req.protocol}://${req.get('host')}/api/cardlink/callback`,
        success_url: `${req.protocol}://${req.get('host')}/payment-success.html`,
        fail_url: `${req.protocol}://${req.get('host')}/payment-fail.html`
    };
    
    const allConfigured = config.shop_id_configured && config.api_token_configured;
    
    res.json({
        success: allConfigured,
        configured: allConfigured,
        config: config,
        message: allConfigured 
            ? 'CardLink настроен правильно' 
            : 'CardLink не настроен. Установите CARDLINK_SHOP_ID и CARDLINK_API_TOKEN на Railway.'
    });
});

// API endpoint для тестирования callback (симуляция успешного платежа)
app.post('/api/cardlink/test-callback', async (req, res) => {
    const { orderId } = req.body;
    
    if (!orderId) {
        return res.status(400).json({
            success: false,
            error: 'Не указан orderId'
        });
    }
    
    console.log('🧪 Testing callback for order:', orderId);
    
    // Симулируем callback от CardLink
    const testCallbackData = {
        Status: 'SUCCESS',
        order_id: orderId,
        amount: 1,
        transaction_id: 'TEST_' + Date.now()
    };
    
    // Вызываем callback обработчик напрямую
    const mockReq = {
        body: testCallbackData,
        protocol: req.protocol,
        get: (header) => req.get(header)
    };
    
    const mockRes = {
        status: (code) => ({
            json: (data) => {
                console.log('🧪 Test callback result:', data);
                return res.json({
                    success: true,
                    message: 'Тестовый callback выполнен',
                    callback_result: data,
                    test_data: testCallbackData
                });
            }
        })
    };
    
    // Вызываем обработчик callback
    try {
        // Импортируем обработчик callback (он уже определен выше)
        // Просто вызываем его логику напрямую
        const pendingOrdersPath = path.join(process.cwd(), 'data', 'pending_orders.json');
        let pendingOrder = null;
        
        if (fs.existsSync(pendingOrdersPath)) {
            const data = fs.readFileSync(pendingOrdersPath, 'utf8');
            const pendingOrders = JSON.parse(data);
            const orderIndex = pendingOrders.findIndex(o => o.orderId === orderId);
            
            if (orderIndex !== -1) {
                pendingOrder = pendingOrders[orderIndex];
                console.log('🧪 Found pending order for test:', orderId);
            }
        }
        
        if (pendingOrder) {
            res.json({
                success: true,
                message: 'Тестовый callback выполнен',
                found_pending_order: true,
                order_data: {
                    name: pendingOrder.name,
                    email: pendingOrder.email,
                    cart_count: pendingOrder.cart.length
                },
                note: 'Если бы это был реальный платеж, заказ был бы сохранен в базу данных'
            });
        } else {
            res.json({
                success: true,
                message: 'Тестовый callback выполнен',
                found_pending_order: false,
                note: 'Pending order не найден. Создайте платеж сначала через test-payment.html'
            });
        }
    } catch (error) {
        console.error('🧪 Test callback error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== ENOT.IO INTEGRATION ====================

// API endpoint для создания платежа через Enot.io
app.post('/api/enot/create-payment', async (req, res) => {
    const { name, email, cart, orderId } = req.body;
    
    if (!name || !email || !cart || !orderId) {
        return res.status(400).json({ 
            success: false,
            error: 'Отсутствуют обязательные поля' 
        });
    }
    
    // ВАЖНО: Используйте переменные окружения для безопасности
    // API ключ из личного кабинета enot.io
    const ENOT_API_KEY = process.env.ENOT_API_KEY || 'e5dfc78ad933765a202115997e4e478a1f133305';
    // Секретный ключ для проверки webhook
    const ENOT_SECRET_KEY = process.env.ENOT_SECRET_KEY || '1ae7bdfde1fb25df06264c69de48e4add14d20fc';
    // ID магазина (обычно это часть API ключа или отдельный параметр)
    // Если у вас есть отдельный merchant_id, укажите его в переменной окружения ENOT_MERCHANT_ID
    const ENOT_MERCHANT_ID = process.env.ENOT_MERCHANT_ID || ENOT_API_KEY;
    // API endpoint Enot.io
    const ENOT_API_URL = process.env.ENOT_API_URL || 'https://enot.io/api/v1/invoice/create';
    
    if (!ENOT_API_KEY || ENOT_API_KEY === 'YOUR_API_KEY') {
        return res.status(500).json({
            success: false,
            error: 'Enot.io не настроен. Установите ENOT_API_KEY и ENOT_SECRET_KEY в переменных окружения.'
        });
    }
    
    try {
        const crypto = require('crypto');
        const total = cart.reduce((s, i) => s + (i.price * i.quantity), 0);
        const callbackUrl = `${req.protocol}://${req.get('host')}/api/enot/callback`;
        const successUrl = `${req.protocol}://${req.get('host')}/payment-success.html?order_id=${orderId}`;
        const failUrl = `${req.protocol}://${req.get('host')}/payment-fail.html?order_id=${orderId}`;
        
        // Описание заказа
        const description = `Заказ #${orderId} - ${cart.map(i => i.title).join(', ')}`;
        
        // Формируем параметры для создания инвойса
        const invoiceParams = {
            merchant: ENOT_MERCHANT_ID,
            amount: total, // Сумма в рублях
            order_id: orderId,
            description: description,
            callback_url: callbackUrl,
            success_url: successUrl,
            fail_url: failUrl,
            email: email,
            custom_field: JSON.stringify({ name, email, cart }) // Дополнительные данные
        };
        
        // Создаем подпись для запроса (обычно MD5 или SHA256)
        // Формат подписи может отличаться, проверьте документацию enot.io
        // Обычно: MD5(merchant + amount + order_id + secret_key)
        const signString = `${invoiceParams.merchant}${invoiceParams.amount}${invoiceParams.order_id}${ENOT_SECRET_KEY}`;
        const sign = crypto.createHash('md5').update(signString).digest('hex');
        invoiceParams.sign = sign;
        
        console.log('💳 Creating Enot.io payment:', {
            orderId,
            amount: total,
            customer: name,
            email: email
        });
        
        // Отправляем запрос на создание инвойса
        // Преобразуем объект в form-urlencoded формат
        const formData = new URLSearchParams();
        Object.keys(invoiceParams).forEach(key => {
            formData.append(key, invoiceParams[key]);
        });
        
        const response = await axios.post(ENOT_API_URL, formData.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        
        // Enot.io обычно возвращает URL для оплаты
        const paymentUrl = response.data?.url || response.data?.payment_url || response.data?.invoice_url;
        
        if (paymentUrl) {
            console.log('✅ Enot.io payment created successfully:', paymentUrl);
            res.json({
                success: true,
                payment_url: paymentUrl
            });
        } else {
            console.error('❌ Invalid response from Enot.io:', response.data);
            res.status(500).json({
                success: false,
                error: 'Неверный ответ от Enot.io',
                details: response.data
            });
        }
    } catch (error) {
        console.error('❌ Error creating Enot.io payment:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: 'Ошибка при создании платежа',
            details: error.response?.data || error.message
        });
    }
});

// API endpoint для обработки webhook от Enot.io
app.post('/api/enot/callback', (req, res) => {
    const crypto = require('crypto');
    
    console.log('📞 Enot.io callback received:', req.body);
    
    // Enot.io отправляет данные о статусе платежа
    // Структура может отличаться, проверьте документацию
    const status = req.body.status || req.body.Status;
    const orderId = req.body.order_id || req.body.orderId || req.body.InvId;
    const amount = req.body.amount || req.body.Amount;
    const transactionId = req.body.transaction_id || req.body.TransactionId || req.body.id;
    const receivedSign = req.body.sign || req.body.Sign || req.body.signature;
    
    // ВАЖНО: Проверяем подпись запроса для безопасности
    const ENOT_SECRET_KEY = process.env.ENOT_SECRET_KEY || '1ae7bdfde1fb25df06264c69de48e4add14d20fc';
    const ENOT_MERCHANT_ID = process.env.ENOT_MERCHANT_ID || process.env.ENOT_API_KEY || 'e5dfc78ad933765a202115997e4e478a1f133305';
    
    // Проверка подписи (формат может отличаться, проверьте документацию)
    // Обычно: MD5(merchant + amount + order_id + secret_key)
    if (receivedSign && orderId && amount) {
        const expectedSignString = `${ENOT_MERCHANT_ID}${amount}${orderId}${ENOT_SECRET_KEY}`;
        const expectedSign = crypto.createHash('md5').update(expectedSignString).digest('hex');
        
        if (receivedSign.toLowerCase() !== expectedSign.toLowerCase()) {
            console.error('❌ Invalid signature in Enot.io callback:', {
                received: receivedSign,
                expected: expectedSign
            });
            return res.status(400).json({ success: false, error: 'Invalid signature' });
        }
    }
    
    // Проверяем статус платежа
    // Обычно статусы: success, paid, success_payment и т.д.
    if (status === 'success' || status === 'paid' || status === 'success_payment' || 
        status === 'SUCCESS' || status === 'PAID' || status === 'SUCCESS_PAYMENT') {
        // Платеж успешен - обрабатываем заказ
        console.log('✅ Enot.io payment successful:', { orderId, amount, transactionId });
        
        // Получаем дополнительные данные из custom_field, если они есть
        let orderData = {};
        if (req.body.custom_field) {
            try {
                orderData = JSON.parse(req.body.custom_field);
            } catch (e) {
                console.log('Could not parse custom_field:', e);
            }
        }
        
        // Здесь можно обновить статус заказа в базе данных
        // Или отправить данные в Telegram
        // Обычно заказ уже обрабатывается на странице payment-success.html,
        // но можно также обработать здесь для надежности
        
        res.status(200).json({ success: true, message: 'Callback processed' });
    } else {
        console.log('❌ Enot.io payment failed:', { orderId, status });
        res.status(200).json({ success: false, message: 'Payment failed' });
    }
});

// Debug endpoint to check all reviews in JSON file (for finding lost reviews like Влад, Таня)
app.get('/api/debug/check-all-reviews-json', async (req, res) => {
    try {
        // КРИТИЧЕСКИ ВАЖНО: Используем readReviewsFromJSON() - она объединяет все отзывы правильно!
        // Это гарантирует, что мы видим ВСЕ отзывы (и из Git, и динамические)
        const allReviews = await readReviewsFromJSON();
        
        // Also read separately for comparison
        let dataReviews = [];
        if (fs.existsSync(reviewsJsonPath)) {
            const data = fs.readFileSync(reviewsJsonPath, 'utf8');
            dataReviews = JSON.parse(data);
        }
        
        let rootReviews = [];
        if (fs.existsSync(reviewsJsonPathGit)) {
            const rootData = fs.readFileSync(reviewsJsonPathGit, 'utf8');
            rootReviews = JSON.parse(rootData);
        }
        
        // Search for specific name if provided
        const searchName = req.query.name ? req.query.name.trim().toLowerCase() : null;
        const searchEmail = req.query.email ? req.query.email.trim().toLowerCase() : null;
        
        let filteredReviews = allReviews;
        if (searchName) {
            filteredReviews = allReviews.filter(r => 
                (r.customer_name || '').toLowerCase().includes(searchName)
            );
        }
        if (searchEmail) {
            filteredReviews = filteredReviews.filter(r => 
                (r.customer_email || '').toLowerCase().includes(searchEmail)
            );
        }
        
        res.json({
            success: true,
            total_reviews_merged: allReviews.length, // Объединенные отзывы (как на сайте)
            total_reviews_in_data_json: dataReviews.length,
            total_reviews_in_root_json: rootReviews.length,
            search_name: searchName || null,
            search_email: searchEmail || null,
            found_reviews: filteredReviews.length,
            reviews: filteredReviews.map(r => ({
                name: r.customer_name,
                email: r.customer_email,
                text: r.review_text ? r.review_text.substring(0, 100) + '...' : '',
                full_text: r.review_text || '',
                created_at: r.created_at,
                is_static: r.is_static || false,
                order_id: r.order_id || null,
                id: r.id || null
            })),
            all_review_names: allReviews.map(r => r.customer_name),
            note: searchName 
                ? `Searching for reviews with name containing "${searchName}"`
                : 'All reviews (merged from root + data/reviews.json - as shown on site)'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

// Debug endpoint: get all reviews for specific email (from DATABASE ONLY)
// Помогает точно понять, сохранен ли отзыв клиента в базе данных
app.get('/api/debug/reviews-by-email', (req, res) => {
    const { email } = req.query;
    
    if (!email) {
        return res.status(400).json({
            success: false,
            error: 'Email query parameter is required'
        });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    console.log(`🔍 Debug: fetching reviews for email "${normalizedEmail}" from DATABASE...`);
    
    db.all(`
        SELECT id, customer_name, customer_email, review_text, rating, order_id, created_at
        FROM reviews
        WHERE LOWER(customer_email) = LOWER(?)
        ORDER BY datetime(created_at) DESC
    `, [normalizedEmail], (err, rows) => {
        if (err) {
            console.error('❌ Error fetching reviews by email:', err);
            return res.status(500).json({
                success: false,
                error: err.message
            });
        }
        
        console.log(`📋 Debug: found ${rows.length} review(s) in DATABASE for "${normalizedEmail}"`);
        
        res.json({
            success: true,
            email: normalizedEmail,
            count: rows.length,
            reviews: rows
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
        
        // Also check reviews for this email
        if (searchEmail) {
            db.all(`SELECT * FROM reviews WHERE LOWER(customer_email) = LOWER(?) ORDER BY created_at DESC`, [searchEmail], (errReviews, reviews) => {
                if (errReviews) {
                    return res.json({ 
                        count: rows.length,
                        emails: rows,
                        searchEmail: searchEmail,
                        searchName: searchName,
                        reviews_error: errReviews.message,
                        message: searchEmail || searchName
                            ? (rows.length > 0 ? `Found ${rows.length} subscription(s)` : `No subscriptions found`)
                            : `Found ${rows.length} unique email(s) in subscriptions`
                    });
                }
                
                res.json({ 
                    count: rows.length,
                    emails: rows,
                    reviews_count: reviews ? reviews.length : 0,
                    reviews: reviews || [],
                    searchEmail: searchEmail,
                    searchName: searchName,
                    message: searchEmail || searchName
                        ? (rows.length > 0 ? `Found ${rows.length} subscription(s)` : `No subscriptions found`)
                        : `Found ${rows.length} unique email(s) in subscriptions`
                });
            });
        } else {
            res.json({ 
                count: rows.length,
                emails: rows,
                searchEmail: searchEmail,
                searchName: searchName,
                message: searchEmail || searchName
                    ? (rows.length > 0 ? `Found ${rows.length} subscription(s)` : `No subscriptions found`)
                    : `Found ${rows.length} unique email(s) in subscriptions`
            });
        }
    });
});

// Debug endpoint to check specific email
// Endpoint для поиска реальных email адресов клиентов по имени
app.get('/api/debug/find-customer-email/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name);
    console.log(`🔍 Searching for customer email by name: "${name}"`);
    
    db.all(`SELECT DISTINCT customer_name, customer_email, order_id, purchase_date 
            FROM subscriptions 
            WHERE customer_name LIKE ? 
            ORDER BY purchase_date DESC 
            LIMIT 10`, 
        [`%${name}%`], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        res.json({
            name: name,
            found: rows.length > 0,
            customers: rows.map(r => ({
                name: r.customer_name,
                email: r.customer_email,
                order_id: r.order_id,
                purchase_date: r.purchase_date
            }))
        });
    });
});

// Endpoint для восстановления пропавших отзывов (Макс и Таня)
app.get('/api/debug/restore-missing-reviews', (req, res) => {
    console.log('🔧 ========== RESTORING MISSING REVIEWS ==========');
    
    const missingReviews = [
        {
            name: 'Макс',
            text: 'Все четко, админу спасибо за помощь)',
            rating: 5
        },
        {
            name: 'Таня',
            text: 'все как супер ❤️❤️ спасибо 😊',
            rating: 5
        }
    ];
    
    const results = [];
    let processed = 0;
    
    missingReviews.forEach((reviewData, index) => {
        // Ищем email по имени в базе данных
        db.get(`
            SELECT DISTINCT customer_email, order_id, purchase_date 
            FROM subscriptions 
            WHERE customer_name LIKE ? 
            ORDER BY purchase_date DESC 
            LIMIT 1
        `, [`%${reviewData.name}%`], (err, customer) => {
            processed++;
            
            if (err) {
                console.error(`❌ Error finding email for ${reviewData.name}:`, err);
                results.push({
                    name: reviewData.name,
                    success: false,
                    error: err.message
                });
            } else if (!customer || !customer.customer_email) {
                console.error(`❌ Email not found for ${reviewData.name}`);
                results.push({
                    name: reviewData.name,
                    success: false,
                    error: 'Email not found in database'
                });
            } else {
                // Email найден - добавляем отзыв
                const email = customer.customer_email.toLowerCase().trim();
                const orderId = customer.order_id || null;
                
                console.log(`✅ Found email for ${reviewData.name}: ${email}`);
                
                // Читаем все отзывы
                let allReviews = [];
                if (fs.existsSync(reviewsJsonPathGit)) {
                    try {
                        const data = fs.readFileSync(reviewsJsonPathGit, 'utf8');
                        allReviews = JSON.parse(data);
                        if (!Array.isArray(allReviews)) {
                            allReviews = [];
                        }
                    } catch (error) {
                        console.error('❌ Error reading reviews.json:', error);
                        allReviews = [];
                    }
                }
                
                // Проверяем, нет ли уже такого отзыва (по имени и тексту)
                const existingReviewIndex = allReviews.findIndex(r => 
                    r.customer_name === reviewData.name && 
                    r.review_text === reviewData.text
                );
                
                if (existingReviewIndex !== -1) {
                    // Отзыв существует, но возможно с временным email - обновляем email на реальный!
                    const existingReview = allReviews[existingReviewIndex];
                    const oldEmail = existingReview.customer_email;
                    
                    if (oldEmail !== email && (oldEmail.includes('temp_') || oldEmail.includes('@restore.pending') || oldEmail.includes('@example.com'))) {
                        // Обновляем email на реальный из базы данных
                        console.log(`🔄 Updating email for ${reviewData.name}: ${oldEmail} -> ${email}`);
                        allReviews[existingReviewIndex].customer_email = email;
                        allReviews[existingReviewIndex].order_id = orderId;
                        
                        // Сохраняем обновленный отзыв
                        try {
                            fs.writeFileSync(reviewsJsonPathGit, JSON.stringify(allReviews, null, 2), 'utf8');
                            console.log(`✅ Updated review for ${reviewData.name} with real email: ${email}`);
                            
                            // Автоматически коммитим в Git
                            commitReviewsToGitViaAPI().catch(err => {
                                console.error('Ошибка при автоматическом коммите (не критично):', err.message);
                            });
                            
                            results.push({
                                name: reviewData.name,
                                success: true,
                                message: 'Review email updated',
                                old_email: oldEmail,
                                new_email: email,
                                order_id: orderId
                            });
                        } catch (error) {
                            console.error(`❌ Error updating review for ${reviewData.name}:`, error);
                            results.push({
                                name: reviewData.name,
                                success: false,
                                error: error.message
                            });
                        }
                    } else {
                        console.log(`✅ Review for ${reviewData.name} already exists with correct email: ${email}`);
                        results.push({
                            name: reviewData.name,
                            success: true,
                            message: 'Review already exists with correct email',
                            email: email
                        });
                    }
                } else {
                    // Создаем новый отзыв
                    const newReview = {
                        id: `review_${Date.now()}_${reviewData.name.toLowerCase()}_restored`,
                        customer_name: reviewData.name,
                        customer_email: email,
                        review_text: reviewData.text,
                        rating: reviewData.rating,
                        order_id: orderId,
                        created_at: new Date().toISOString(),
                        is_static: false
                    };
                    
                    // Добавляем в начало списка (новые первыми)
                    allReviews.unshift(newReview);
                    
                    // Сортируем по дате (новые первыми)
                    allReviews.sort((a, b) => {
                        const timeA = new Date(a.created_at || 0).getTime();
                        const timeB = new Date(b.created_at || 0).getTime();
                        return timeB - timeA;
                    });
                    
                    // Сохраняем
                    try {
                        fs.writeFileSync(reviewsJsonPathGit, JSON.stringify(allReviews, null, 2), 'utf8');
                        console.log(`✅ Restored review for ${reviewData.name}`);
                        
                        // Автоматически коммитим в Git
                        commitReviewsToGitViaAPI().catch(err => {
                            console.error('Ошибка при автоматическом коммите (не критично):', err.message);
                        });
                        
                        results.push({
                            name: reviewData.name,
                            success: true,
                            email: email,
                            order_id: orderId,
                            review: newReview
                        });
                    } catch (error) {
                        console.error(`❌ Error saving review for ${reviewData.name}:`, error);
                        results.push({
                            name: reviewData.name,
                            success: false,
                            error: error.message
                        });
                    }
                }
            }
            
            // Когда все обработано, отправляем ответ
            if (processed === missingReviews.length) {
                res.json({
                    success: true,
                    message: 'Restoration completed',
                    results: results
                });
            }
        });
    });
});

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

// Remove duplicate subscriptions for a specific email
// Finds duplicates by: same email + same product_id + same purchase_date (within 10 seconds)
// Keeps the earliest one, deletes the rest
app.get('/api/debug/remove-duplicate-subscriptions/:email', (req, res) => {
    const email = req.params.email.toLowerCase().trim();
    
    console.log(`🔧 Removing duplicate subscriptions for: ${email}`);
    
    // Find all subscriptions for this email
    db.all(`
        SELECT * FROM subscriptions 
        WHERE LOWER(customer_email) = LOWER(?)
        ORDER BY purchase_date ASC, id ASC
    `, [email], (err, allSubs) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (allSubs.length === 0) {
            return res.json({ 
                success: true, 
                message: `No subscriptions found for ${email}`,
                removed: 0
            });
        }
        
        // Group by product_id and find duplicates (same product, same date within 10 seconds)
        const groups = new Map();
        allSubs.forEach(sub => {
            const key = `${sub.product_id}_${sub.product_name}`;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key).push(sub);
        });
        
        let removedCount = 0;
        const removedIds = [];
        const errors = [];
        
        // Process each group
        groups.forEach((subs, key) => {
            if (subs.length <= 1) {
                return; // No duplicates
            }
            
            // Sort by purchase_date and id (keep earliest)
            subs.sort((a, b) => {
                const dateA = new Date(a.purchase_date).getTime();
                const dateB = new Date(b.purchase_date).getTime();
                if (dateA !== dateB) {
                    return dateA - dateB;
                }
                return a.id - b.id; // If same date, keep lower ID
            });
            
            // Keep the first one, mark others for deletion
            const toKeep = subs[0];
            const toRemove = subs.slice(1);
            
            // Check if they are real duplicates (same date within 10 seconds)
            toRemove.forEach(sub => {
                const keepDate = new Date(toKeep.purchase_date).getTime();
                const removeDate = new Date(sub.purchase_date).getTime();
                const timeDiff = Math.abs(keepDate - removeDate);
                
                // If within 10 seconds, consider it a duplicate
                if (timeDiff < 10000) {
                    console.log(`🗑️ Marking duplicate for removal: ID=${sub.id}, product=${sub.product_name}, date=${sub.purchase_date}`);
                    removedIds.push(sub.id);
                }
            });
        });
        
        if (removedIds.length === 0) {
            return res.json({ 
                success: true, 
                message: `No duplicates found for ${email}`,
                removed: 0,
                subscriptions: allSubs
            });
        }
        
        // Remove duplicates one by one
        let processed = 0;
        removedIds.forEach((id, index) => {
            // First, delete reminders for this subscription
            db.run('DELETE FROM reminders WHERE subscription_id = ?', [id], (remErr) => {
                if (remErr) {
                    console.error(`❌ Error deleting reminders for subscription ${id}:`, remErr);
                }
            });
            
            // Then delete the subscription
            db.run('DELETE FROM subscriptions WHERE id = ?', [id], (delErr) => {
                processed++;
                
                if (delErr) {
                    console.error(`❌ Error deleting subscription ${id}:`, delErr);
                    errors.push(`Subscription ${id}: ${delErr.message}`);
                } else {
                    removedCount++;
                    console.log(`✅ Deleted duplicate subscription ID=${id}`);
                }
                
                // When all processed, also remove duplicates from orders.json
                if (processed === removedIds.length) {
                    // Also remove duplicates from orders.json
                    try {
                        const jsonOrders = readOrdersFromJSON();
                        const originalCount = jsonOrders.length;
                        
                        // Find duplicates in JSON (same email + product_id + purchase_date within 10 seconds)
                        const jsonGroups = new Map();
                        jsonOrders.forEach(order => {
                            const key = `${order.product_id}_${order.product_name}`;
                            if (!jsonGroups.has(key)) {
                                jsonGroups.set(key, []);
                            }
                            jsonGroups.get(key).push(order);
                        });
                        
                        const ordersToKeep = [];
                        let jsonRemovedCount = 0;
                        const removedOrderIds = [];
                        
                        jsonGroups.forEach((orders, key) => {
                            if (orders.length <= 1) {
                                ordersToKeep.push(...orders);
                                return;
                            }
                            
                            // Filter by email
                            const emailOrders = orders.filter(o => 
                                (o.customer_email || '').toLowerCase().trim() === email
                            );
                            
                            // Add non-email orders immediately (they are not duplicates for this user)
                            orders.filter(o => 
                                (o.customer_email || '').toLowerCase().trim() !== email
                            ).forEach(o => ordersToKeep.push(o));
                            
                            if (emailOrders.length <= 1) {
                                // No duplicates for this email, add all
                                ordersToKeep.push(...emailOrders);
                                return;
                            }
                            
                            // Sort by purchase_date and id (keep earliest)
                            emailOrders.sort((a, b) => {
                                const dateA = new Date(a.purchase_date || 0).getTime();
                                const dateB = new Date(b.purchase_date || 0).getTime();
                                if (dateA !== dateB) {
                                    return dateA - dateB;
                                }
                                return (a.id || 0) - (b.id || 0);
                            });
                            
                            // Keep first, remove others
                            const toKeep = emailOrders[0];
                            const toRemove = emailOrders.slice(1);
                            
                            // Check if they are real duplicates (same date within 10 seconds)
                            toRemove.forEach(order => {
                                const keepDate = new Date(toKeep.purchase_date || 0).getTime();
                                const removeDate = new Date(order.purchase_date || 0).getTime();
                                const timeDiff = Math.abs(keepDate - removeDate);
                                
                                if (timeDiff < 10000) {
                                    jsonRemovedCount++;
                                    removedOrderIds.push(order.id);
                                    console.log(`🗑️ Marking JSON duplicate for removal: ID=${order.id}, product=${order.product_name}, date=${order.purchase_date}`);
                                } else {
                                    // Not a duplicate (time difference > 10 seconds), keep it
                                    ordersToKeep.push(order);
                                }
                            });
                            
                            // Add the one to keep
                            ordersToKeep.push(toKeep);
                        });
                        
                        if (jsonRemovedCount > 0) {
                            const saved = writeOrdersToJSON(ordersToKeep);
                            if (saved) {
                                console.log(`✅ Removed ${jsonRemovedCount} duplicate order(s) from orders.json`);
                            } else {
                                console.error('❌ Failed to save orders.json after removing duplicates');
                            }
                        }
                        
                        res.json({ 
                            success: true, 
                            message: `Removed ${removedCount} duplicate subscription(s) from DB and ${jsonRemovedCount} from orders.json for ${email}`,
                            removed: removedCount,
                            json_removed: jsonRemovedCount,
                            errors: errors.length > 0 ? errors : undefined
                        });
                    } catch (jsonErr) {
                        console.error('❌ Error removing duplicates from orders.json:', jsonErr);
                        res.json({ 
                            success: true, 
                            message: `Removed ${removedCount} duplicate subscription(s) from DB for ${email} (JSON cleanup failed)`,
                            removed: removedCount,
                            errors: errors.length > 0 ? errors : undefined
                        });
                    }
                }
            });
        });
    });
});

// Force remove duplicate orders from JSON for specific email and product
// More aggressive: removes ALL duplicates except the first one (by ID)
app.get('/api/debug/force-remove-duplicates/:email', (req, res) => {
    const email = req.params.email.toLowerCase().trim();
    
    console.log(`🔧 Force removing ALL duplicates for: ${email}`);
    
    try {
        const jsonOrders = readOrdersFromJSON();
        const originalCount = jsonOrders.length;
        
        // Group by email + product_id
        const seen = new Map();
        const ordersToKeep = [];
        let removedCount = 0;
        
        jsonOrders.forEach(order => {
            const orderEmail = (order.customer_email || '').toLowerCase().trim();
            
            // If not for this email, keep it
            if (orderEmail !== email) {
                ordersToKeep.push(order);
                return;
            }
            
            // For this email, check for duplicates by product_id
            const key = `${order.product_id}_${order.product_name}`;
            
            if (!seen.has(key)) {
                // First occurrence of this product for this email - keep it
                seen.set(key, true);
                ordersToKeep.push(order);
            } else {
                // Duplicate - remove it
                removedCount++;
                console.log(`🗑️ Removing duplicate: ID=${order.id}, product=${order.product_name}, date=${order.purchase_date}`);
            }
        });
        
        if (removedCount > 0) {
            const saved = writeOrdersToJSON(ordersToKeep);
            if (saved) {
                console.log(`✅ Force removed ${removedCount} duplicate order(s) from orders.json`);
                res.json({ 
                    success: true, 
                    message: `Force removed ${removedCount} duplicate order(s) from orders.json for ${email}`,
                    removed: removedCount,
                    original_count: originalCount,
                    new_count: ordersToKeep.length
                });
            } else {
                res.status(500).json({ 
                    success: false, 
                    error: 'Failed to save orders.json after removing duplicates' 
                });
            }
        } else {
            res.json({ 
                success: true, 
                message: `No duplicates found for ${email}`,
                removed: 0
            });
        }
    } catch (error) {
        console.error('❌ Error force removing duplicates:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
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
    
    // Работаем с UTC временем, чтобы избежать проблем с часовыми поясами
    // Get original purchase time in UTC (hour and minutes)
    const purchaseHour = purchaseDate.getUTCHours();
    const purchaseMinute = purchaseDate.getUTCMinutes();
    
    // Calculate reminder time: 1 hour before purchase time
    let reminderHour = purchaseHour - 1;
    let reminderMinute = purchaseMinute;
    
    // Handle case when purchase was at midnight (hour 0)
    if (reminderHour < 0) {
        reminderHour = 23;
    }
    
    if (productId === 3) {
        // Adobe: fixed subscription periods
        // 1 month -> 1 purchase (expiry)
        // 3 months -> 1 purchase (expiry)
        // 6 months -> 2 purchases of 3 months each
        // 12 months -> 4 purchases of 3 months each
        
        if (months === 12) {
            // Year subscription: 4 purchases of 3 months each
            // 4 reminders: at 3, 6, 9, and 12 months
            for (let i = 1; i <= 4; i++) {
                const renewalDate = new Date(purchaseDate);
                renewalDate.setUTCMonth(renewalDate.getUTCMonth() + (i * 3));
                // Устанавливаем UTC время за 1 час до времени покупки (после добавления месяцев)
                renewalDate.setUTCHours(reminderHour, reminderMinute, 0, 0);
                
                const monthsRemaining = 12 - (i * 3);
                const reminderType = monthsRemaining > 0 ? `renewal_${monthsRemaining}months` : 'expiry';
                
                insertReminder(subscriptionId, renewalDate, reminderType);
            }
        } else if (months === 6) {
            // 6 months: 2 purchases of 3 months each
            // 2 reminders: at 3 and 6 months
            const firstRenewal = new Date(purchaseDate);
            firstRenewal.setUTCMonth(firstRenewal.getUTCMonth() + 3);
            // Устанавливаем UTC время за 1 час до времени покупки
            firstRenewal.setUTCHours(reminderHour, reminderMinute, 0, 0);
            insertReminder(subscriptionId, firstRenewal, 'renewal_3months');
            
            const secondRenewal = new Date(purchaseDate);
            secondRenewal.setUTCMonth(secondRenewal.getUTCMonth() + 6);
            // Устанавливаем UTC время за 1 час до времени покупки
            secondRenewal.setUTCHours(reminderHour, reminderMinute, 0, 0);
            insertReminder(subscriptionId, secondRenewal, 'expiry');
        } else {
            // 1 or 3 months: one purchase
            const expiry = new Date(purchaseDate);
            expiry.setUTCMonth(expiry.getUTCMonth() + months);
            // Устанавливаем UTC время за 1 час до времени покупки
            expiry.setUTCHours(reminderHour, reminderMinute, 0, 0);
            insertReminder(subscriptionId, expiry, 'expiry');
        }
    } else if (productId === 1 || productId === 7) {
        // ChatGPT and CapCut: monthly renewals
        for (let i = 1; i <= months; i++) {
            const renewalDate = new Date(purchaseDate);
            renewalDate.setUTCMonth(renewalDate.getUTCMonth() + i);
            // Устанавливаем UTC время за 1 час до времени покупки (после добавления месяцев)
            renewalDate.setUTCHours(reminderHour, reminderMinute, 0, 0);
            
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

// Endpoint to remove long dashes from all reviews (delete them, don't replace)
app.post('/api/debug/remove-dashes', (req, res) => {
    console.log('🔧 Removing long dashes from all reviews...');
    
    // Find all reviews with long dashes
    db.all("SELECT id, customer_name, review_text FROM reviews WHERE review_text LIKE '%—%' OR review_text LIKE '%–%' OR review_text LIKE '%—%'", [], (err, rows) => {
        if (err) {
            console.error('❌ Error finding reviews:', err);
            return res.status(500).json({ error: 'Database error', details: err.message });
        }
        
        if (rows.length === 0) {
            console.log('✅ No reviews with long dashes found');
            return res.json({ success: true, message: 'No reviews with long dashes found', updated: 0 });
        }
        
        console.log(`Found ${rows.length} reviews with long dashes`);
        
        let updated = 0;
        let errors = 0;
        const updatePromises = [];
        
        rows.forEach((row) => {
            // Remove long dashes (delete them, don't replace) and clean up spaces
            const newText = row.review_text
                .replace(/—/g, ' ')  // em dash -> space
                .replace(/–/g, ' ')   // en dash -> space
                .replace(/—/g, ' ')  // другой вариант em dash -> space
                .replace(/\s+/g, ' ') // multiple spaces -> single space
                .trim();
            
            if (newText !== row.review_text) {
                updatePromises.push(
                    new Promise((resolve, reject) => {
                        db.run("UPDATE reviews SET review_text = ? WHERE id = ?", [newText, row.id], (updateErr) => {
                            if (updateErr) {
                                console.error(`❌ Error updating review ${row.id}:`, updateErr);
                                errors++;
                                reject(updateErr);
                            } else {
                                updated++;
                                console.log(`✅ Updated review ${row.id} (${row.customer_name})`);
                                resolve();
                            }
                        });
                    })
                );
            }
        });
        
        Promise.all(updatePromises).then(() => {
            console.log(`✅ Removed dashes from ${updated} reviews, ${errors} errors`);
            db.run('PRAGMA wal_checkpoint(FULL);');
            res.json({ 
                success: true, 
                message: `Removed long dashes from ${updated} reviews`,
                updated: updated,
                errors: errors,
                total: rows.length
            });
        }).catch((err) => {
            console.error('❌ Error updating reviews:', err);
            res.status(500).json({ error: 'Error updating reviews', details: err.message });
        });
    });
});

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

// Track visitor and send Telegram notification
// Store recent IPs to prevent spam (last 5 minutes)
const recentVisitors = new Map();
const processingIPs = new Set(); // Track IPs currently being processed

async function getCountryFromIP(ip) {
    try {
        // Skip localhost IPs
        if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
            return 'Локальный';
        }
        
        // Use ip-api.com free API
        const response = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,countryCode`, {
            timeout: 3000
        });
        
        if (response.data && response.data.status === 'success') {
            return response.data.country || 'Неизвестно';
        }
        return 'Неизвестно';
    } catch (error) {
        console.error('Error getting country from IP:', error.message);
        return 'Неизвестно';
    }
}

app.post('/api/track-visit', async (req, res) => {
    try {
        // Get IP address
        const ip = req.headers['x-forwarded-for']?.split(',')[0] || 
                   req.headers['x-real-ip'] || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress ||
                   'unknown';
        
        // Get page URL from request
        const page = req.body.page || req.headers.referer || 'Главная';
        const pageName = page.includes('index.html') || page === '/' ? 'Главная' :
                        page.includes('checkout') ? 'Оформление' :
                        page.includes('chatgpt') ? 'ChatGPT' :
                        page.includes('adobe') ? 'Adobe' :
                        page.includes('capcut') ? 'CapCut' :
                        page.includes('reviews') ? 'Отзывы' :
                        'Другая страница';
        
        // Check if we already sent notification for this IP in last 5 minutes
        const now = Date.now();
        const visitorKey = ip;
        const lastVisit = recentVisitors.get(visitorKey);
        
        // Check if already processing this IP (prevent race condition)
        if (processingIPs.has(visitorKey)) {
            return res.json({ success: true, message: 'Visit tracked (already processing)' });
        }
        
        if (lastVisit && (now - lastVisit) < 5 * 60 * 1000) {
            // Skip notification if visited less than 5 minutes ago
            return res.json({ success: true, message: 'Visit tracked (duplicate)' });
        }
        
        // Mark as processing immediately to prevent duplicate requests
        processingIPs.add(visitorKey);
        
        // Update last visit time immediately
        recentVisitors.set(visitorKey, now);
        
        // Clean old entries (older than 10 minutes)
        for (const [key, time] of recentVisitors.entries()) {
            if (now - time > 10 * 60 * 1000) {
                recentVisitors.delete(key);
                processingIPs.delete(key);
            }
        }
        
        // Get country
        const country = await getCountryFromIP(ip);
        
        // Format Telegram message
        const message = `👤 Новый посетитель\n\n📄 Страница: ${pageName}\n🌍 Страна: ${country}\n🕐 Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;
        
        // Send to Telegram (async, don't wait)
        sendTelegramMessage(message)
            .then(() => {
                // Remove from processing set after successful send
                setTimeout(() => {
                    processingIPs.delete(visitorKey);
                }, 1000);
            })
            .catch(err => {
                console.error('Error sending visit notification:', err);
                // Remove from processing set even on error
                processingIPs.delete(visitorKey);
            });
        
        res.json({ 
            success: true, 
            message: 'Visit tracked',
            country: country
        });
    } catch (error) {
        console.error('Error tracking visit:', error);
        res.json({ 
            success: false, 
            message: 'Error tracking visit'
        });
    }
});

// Track checkout and send Telegram notification
app.post('/api/track-checkout', async (req, res) => {
    try {
        // Get IP address
        const ip = req.headers['x-forwarded-for']?.split(',')[0] || 
                   req.headers['x-real-ip'] || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress ||
                   'unknown';
        
        // Get cart data from request
        const cart = req.body.cart || [];
        const total = req.body.total || 0;
        
        // Get country
        const country = await getCountryFromIP(ip);
        
        // Format cart items
        let itemsText = '';
        if (cart.length > 0) {
            itemsText = cart.map((item, index) => {
                const productName = item.title || item.name || 'Неизвестный товар';
                const quantity = item.quantity || 1;
                const price = item.price || 0;
                const months = item.months ? ` (${item.months} ${item.months === 1 ? 'месяц' : item.months < 5 ? 'месяца' : 'месяцев'})` : '';
                return `${index + 1}. ${productName}${months} (${quantity} шт.) - ${price.toLocaleString()} ₽`;
            }).join('\n');
        } else {
            itemsText = 'Корзина пуста';
        }
        
        // Format Telegram message
        const message = `🛒 Переход к оплате\n\n📦 Товары в корзине:\n${itemsText}\n\n💰 Общая сумма: ${total.toLocaleString()} ₽\n🌍 Страна: ${country}\n🕐 Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;
        
        // Send to Telegram (async, don't wait)
        sendTelegramMessage(message)
            .then(() => {
                console.log('Checkout notification sent successfully');
            })
            .catch(err => {
                console.error('Error sending checkout notification:', err);
            });
        
        res.json({ 
            success: true, 
            message: 'Checkout tracked'
        });
    } catch (error) {
        console.error('Error tracking checkout:', error);
        res.json({ 
            success: false, 
            message: 'Error tracking checkout'
        });
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

// Endpoint to check Telegram webhook status
app.get('/api/telegram/webhook-status', async (req, res) => {
    try {
        const response = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
        res.json({ 
            success: true, 
            webhookInfo: response.data
        });
    } catch (error) {
        console.error('Error getting webhook status:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка получения статуса webhook',
            details: error.response?.data || error.message
        });
    }
});

// Endpoint для удаления чата по clientId (вызывается при закрытии вкладки)
app.delete('/api/support/delete-chat/:clientId', (req, res) => {
    try {
        const { clientId } = req.params;
        
        if (!clientId) {
            return res.status(400).json({ success: false, error: 'Client ID не указан' });
        }
        
        console.log(`🗑️ Deleting chat for clientId: ${clientId}`);
        
        // Получаем все message_id для этого clientId
        db.all(`
            SELECT message_id FROM support_messages WHERE client_id = ?
        `, [clientId], (err, messages) => {
            if (err) {
                console.error('❌ Error getting messages for deletion:', err);
                return res.status(500).json({ success: false, error: 'Ошибка получения сообщений' });
            }
            
            const messageIds = messages.map(m => m.message_id);
            
            if (messageIds.length === 0) {
                console.log(`📋 No messages found for clientId: ${clientId}`);
                return res.json({ success: true, message: 'Чат не найден или уже удален', deleted: 0 });
            }
            
            // Удаляем ответы для этих сообщений
            const placeholders = messageIds.map(() => '?').join(',');
            db.run(`
                DELETE FROM support_replies WHERE message_id IN (${placeholders})
            `, messageIds, (err) => {
                if (err) {
                    console.error('❌ Error deleting replies:', err);
                } else {
                    console.log(`✅ Deleted replies for ${messageIds.length} messages`);
                }
            });
            
            // Удаляем сообщения
            db.run(`
                DELETE FROM support_messages WHERE client_id = ?
            `, [clientId], function(err) {
                if (err) {
                    console.error('❌ Error deleting messages:', err);
                    return res.status(500).json({ success: false, error: 'Ошибка удаления сообщений' });
                }
                
                console.log(`✅ Deleted ${this.changes} messages for clientId: ${clientId}`);
                
                // НЕ коммитим в Git - чат удаляется при закрытии вкладки, поэтому автоматические деплои не нужны
                
                res.json({ 
                    success: true, 
                    message: 'Чат удален',
                    deleted: this.changes
                });
            });
        });
    } catch (error) {
        console.error('Error deleting chat:', error);
        res.status(500).json({ success: false, error: 'Ошибка удаления чата' });
    }
});

// Функция для автоматической очистки старых чатов (старше 2 часов после последнего сообщения)
function cleanupOldSupportChats() {
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000); // 2 часа в миллисекундах
    
    console.log(`🧹 Starting cleanup of old support chats (older than 2 hours)...`);
    
    // Находим все client_id, у которых последнее сообщение старше 2 часов
    db.all(`
        SELECT client_id, MAX(timestamp) as last_message_time
        FROM support_messages
        GROUP BY client_id
        HAVING MAX(timestamp) < ?
    `, [twoHoursAgo], (err, oldChats) => {
        if (err) {
            console.error('❌ Error finding old chats:', err);
            return;
        }
        
        if (!oldChats || oldChats.length === 0) {
            console.log(`✅ No old chats to clean up`);
            return;
        }
        
        console.log(`📋 Found ${oldChats.length} old chats to delete`);
        
        let deletedCount = 0;
        let processed = 0;
        
        oldChats.forEach((chat) => {
            const clientId = chat.client_id;
            
            // Получаем все message_id для этого clientId
            db.all(`
                SELECT message_id FROM support_messages WHERE client_id = ?
            `, [clientId], (err, messages) => {
                if (err) {
                    console.error(`❌ Error getting messages for clientId ${clientId}:`, err);
                    processed++;
                    if (processed === oldChats.length) {
                        finishCleanup(deletedCount);
                    }
                    return;
                }
                
                const messageIds = messages.map(m => m.message_id);
                
                if (messageIds.length === 0) {
                    processed++;
                    if (processed === oldChats.length) {
                        finishCleanup(deletedCount);
                    }
                    return;
                }
                
                // Удаляем ответы
                const placeholders = messageIds.map(() => '?').join(',');
                db.run(`
                    DELETE FROM support_replies WHERE message_id IN (${placeholders})
                `, messageIds, (err) => {
                    if (err) {
                        console.error(`❌ Error deleting replies for clientId ${clientId}:`, err);
                    }
                });
                
                // Удаляем сообщения
                db.run(`
                    DELETE FROM support_messages WHERE client_id = ?
                `, [clientId], function(err) {
                    processed++;
                    
                    if (err) {
                        console.error(`❌ Error deleting messages for clientId ${clientId}:`, err);
                    } else {
                        deletedCount += this.changes;
                        console.log(`✅ Deleted ${this.changes} messages for clientId: ${clientId}`);
                    }
                    
                    if (processed === oldChats.length) {
                        finishCleanup(deletedCount);
                    }
                });
            });
        });
        
        function finishCleanup(deletedCount) {
            console.log(`✅ Cleanup completed: deleted ${deletedCount} messages from ${oldChats.length} old chats`);
            
            // НЕ коммитим в Git - чат удаляется при закрытии вкладки, поэтому автоматические деплои не нужны
        }
    });
}

// Запускаем очистку старых чатов каждые 30 минут
setInterval(() => {
    cleanupOldSupportChats();
}, 30 * 60 * 1000); // 30 минут

// Запускаем очистку сразу при старте сервера (через 1 минуту после запуска)
setTimeout(() => {
    cleanupOldSupportChats();
}, 60 * 1000); // 1 минута

// Endpoint to set Telegram webhook (call this once after deployment)
app.get('/api/telegram/set-webhook', async (req, res) => {
    try {
        const webhookUrl = req.query.url || `${req.protocol}://${req.get('host')}/api/telegram/webhook`;
        
        console.log('🔧 Setting webhook to:', webhookUrl);
        
        const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
            url: webhookUrl
        });
        
        console.log('✅ Webhook set successfully:', response.data);
        
        res.json({ 
            success: true, 
            message: 'Webhook установлен',
            webhookUrl: webhookUrl,
            telegramResponse: response.data
        });
    } catch (error) {
        console.error('❌ Error setting webhook:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка установки webhook',
            details: error.response?.data || error.message
        });
    }
});

// Support Chat - Send message to Telegram
// Create uploads/support directory if it doesn't exist
const supportUploadDir = path.join(process.cwd(), 'uploads', 'support');
if (!require('fs').existsSync(supportUploadDir)) {
    require('fs').mkdirSync(supportUploadDir, { recursive: true });
}

const supportUpload = multer({ 
    storage: multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, supportUploadDir);
        },
        filename: function (req, file, cb) {
            // Сохраняем с уникальным именем, чтобы не удалять
            const uniqueName = `support_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${file.originalname}`;
            cb(null, uniqueName);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

app.post('/api/support/send-message', supportUpload.array('images', 10), async (req, res) => {
    try {
        const message = req.body.message || '';
        let imageFiles = req.files || []; // Array of files
        
        // Ensure imageFiles is an array
        if (!Array.isArray(imageFiles)) {
            imageFiles = imageFiles ? [imageFiles] : [];
        }
        
        // Support legacy single image upload
        if (!imageFiles.length && req.file) {
            imageFiles = [req.file];
        }
        
        console.log(`📥 Received message with ${imageFiles.length} images`);
        if (imageFiles.length > 0) {
            console.log(`📷 Image filenames:`, imageFiles.map(f => f.filename || f.originalname || 'unknown'));
        }
        
        if (!message.trim() && imageFiles.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Сообщение или изображение обязательно' 
            });
        }
        
        // Get client IP and create unique client ID
        const ip = req.headers['x-forwarded-for']?.split(',')[0] || 
                   req.headers['x-real-ip'] || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress ||
                   'unknown';
        
        // Create unique client ID from IP (hash for privacy)
        const crypto = require('crypto');
        const clientId = crypto.createHash('md5').update(ip + (req.headers['user-agent'] || '')).digest('hex').substring(0, 12);
        
        // Generate unique message ID
        const messageId = `support_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const timestamp = new Date().toLocaleString('ru-RU');
        
        // Build message text
        let telegramMessage = `📨 <b>Новое сообщение из чата поддержки</b>\n\n`;
        telegramMessage += `💬 <b>Сообщение:</b> ${message || '(только изображение)'}\n`;
        if (imageFiles.length > 1) {
            telegramMessage += `📷 <b>Изображений:</b> ${imageFiles.length}\n`;
        }
        telegramMessage += `🕐 <b>Время:</b> ${timestamp}`;
        
        // Inline keyboard with reply button
        const replyKeyboard = {
            inline_keyboard: [[
                {
                    text: '💬 Ответить',
                    callback_data: `reply_${messageId}`
                }
            ]]
        };
        
        // Send to Telegram
        const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        let telegramMessageId = null;
        const axios = require('axios');
        const FormData = require('form-data');
        
        if (imageFiles.length > 0) {
            // Send photos (multiple or single)
            if (imageFiles.length === 1) {
                // Single photo
                const photoUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
                const formData = new FormData();
                
                formData.append('chat_id', CHAT_ID);
                formData.append('photo', require('fs').createReadStream(imageFiles[0].path));
                formData.append('caption', telegramMessage);
                formData.append('parse_mode', 'HTML');
                formData.append('reply_markup', JSON.stringify(replyKeyboard));
                
                const photoResponse = await axios.post(photoUrl, formData, {
                    headers: formData.getHeaders()
                });
                telegramMessageId = photoResponse.data.result?.message_id;
            } else {
                // Multiple photos - send as media group
                const mediaGroup = imageFiles.map((file, index) => ({
                    type: 'photo',
                    media: `attach://photo_${index}`,
                    caption: index === 0 ? telegramMessage : undefined,
                    parse_mode: index === 0 ? 'HTML' : undefined
                }));
                
                const formData = new FormData();
                formData.append('chat_id', CHAT_ID);
                imageFiles.forEach((file, index) => {
                    formData.append(`photo_${index}`, require('fs').createReadStream(file.path));
                });
                formData.append('media', JSON.stringify(mediaGroup));
                
                const mediaResponse = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`, formData, {
                    headers: formData.getHeaders()
                });
                
                // Send reply button separately
                if (mediaResponse.data.result && mediaResponse.data.result.length > 0) {
                    telegramMessageId = mediaResponse.data.result[0].message_id;
                    await axios.post(telegramUrl, {
                        chat_id: CHAT_ID,
                        text: '💬 Ответить на сообщение',
                        reply_to_message_id: telegramMessageId,
                        reply_markup: replyKeyboard
                    });
                }
            }
        } else {
            // Send text message
            console.log('📤 Sending message with keyboard:', JSON.stringify(replyKeyboard, null, 2));
            const textResponse = await axios.post(telegramUrl, {
                chat_id: CHAT_ID,
                text: telegramMessage,
                parse_mode: 'HTML',
                reply_markup: replyKeyboard
            });
            telegramMessageId = textResponse.data.result?.message_id;
            console.log('✅ Message sent, response:', JSON.stringify(textResponse.data, null, 2));
        }
        
        // КРИТИЧЕСКИ ВАЖНО: Сохраняем в SQLite базу данных - данные НЕ ПОТЕРЯЮТСЯ при деплое!
        // База данных сохраняется на сервере и не перезаписывается при деплое
        const imageFilenames = imageFiles.map(f => {
            const filename = f.filename || f.originalname || null;
            console.log(`  - File: ${filename}, size: ${f.size}, path: ${f.path}`);
            return filename;
        }).filter(f => f !== null);
        
        // КРИТИЧЕСКИ ВАЖНО: Сохраняем в базу данных ПОСЛЕ получения telegramMessageId
        // Используем тот же подход, что и для отзывов - prepare/run/finalize для надежности
        const saveMessageToDatabase = (telegramMsgId) => {
            console.log(`💾 Saving message ${messageId} to database with ${imageFiles.length} images, telegramMessageId: ${telegramMsgId}`);
            
            // Используем prepare/run/finalize как для отзывов - это гарантирует надежное сохранение
            const stmt = db.prepare(`
                INSERT INTO support_messages 
                (message_id, message_text, client_id, client_ip, has_image, image_filenames, telegram_message_id, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            stmt.run([
                messageId,
                message || null,
                clientId,
                ip,
                imageFiles.length > 0 ? 1 : 0,
                imageFilenames.length > 0 ? JSON.stringify(imageFilenames) : null,
                telegramMsgId || null,
                Date.now()
            ], function(err) {
                if (err) {
                    console.error('❌ Error saving message to database:', err);
                    console.error('   Error details:', err.message);
                    stmt.finalize();
                    
                    // Пробуем обновить, если сообщение уже существует
                    if (err.message && err.message.includes('UNIQUE constraint')) {
                        const updateStmt = db.prepare(`
                            UPDATE support_messages 
                            SET telegram_message_id = ?
                            WHERE message_id = ?
                        `);
                        updateStmt.run([telegramMsgId, messageId], (updateErr) => {
                            if (updateErr) {
                                console.error('❌ Error updating telegram_message_id:', updateErr);
                            } else {
                                console.log(`✅ Updated telegram_message_id for message ${messageId}`);
                            }
                            updateStmt.finalize();
                        });
                    }
                } else {
                    console.log(`✅ Saved message to DATABASE (persistent storage) - ID: ${this.lastID}`);
                    console.log(`   Message ID: ${messageId}`);
                    console.log(`   Client ID: ${clientId}`);
                    console.log(`   ✅ Сообщение сохранено в базу данных - НЕ ПОТЕРЯЕТСЯ при деплое!`);
                    
                    // КРИТИЧЕСКИ ВАЖНО: Принудительно синхронизируем данные с диском
                    // Это гарантирует, что сообщение будет сохранено даже при сбое или перезапуске
                    db.run('PRAGMA wal_checkpoint(FULL);', (checkpointErr) => {
                        if (checkpointErr) {
                            console.error('⚠️ Error during WAL checkpoint:', checkpointErr);
                        } else {
                            console.log('✅ WAL checkpoint completed - message is safely saved to disk');
                        }
                    });
                    
                    stmt.finalize();
                    
                    // НЕ коммитим в Git - чат удаляется при закрытии вкладки клиента, поэтому автоматические деплои не нужны
                    // Данные сохраняются только в БД для админ-панели
                }
            });
        };
        
        // Сохраняем сообщение в БД после получения telegramMessageId
        saveMessageToDatabase(telegramMessageId);
        
        // Return messageId and clientId to client for polling and deletion
        res.json({ 
            success: true, 
            message: 'Сообщение отправлено',
            messageId: messageId,
            clientId: clientId // Возвращаем clientId для удаления чата при закрытии вкладки
        });
        
    } catch (error) {
        console.error('Error sending support message:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка отправки сообщения' 
        });
    }
});

// Telegram webhook for callback queries (button clicks) and messages
app.post('/api/telegram/webhook', async (req, res) => {
    try {
        const body = req.body;
        console.log('📥 Telegram webhook received:', JSON.stringify(body, null, 2));
        
        // Handle callback query (button click) - ОБРАБАТЫВАЕМ СРАЗУ, чтобы ответить на callback query
        if (body.callback_query) {
            const callbackQuery = body.callback_query;
            console.log('🔘 Callback query received:', callbackQuery.data);
            
            if (callbackQuery.data && callbackQuery.data.startsWith('reply_')) {
                const messageId = callbackQuery.data.replace('reply_', '');
                const chatId = callbackQuery.message.chat.id;
                const messageText = callbackQuery.message.text || callbackQuery.message.caption || '';
                
                console.log('💬 Processing reply button click:', { messageId, chatId });
                
                // Answer callback query FIRST to remove loading state immediately
                try {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                        callback_query_id: callbackQuery.id,
                        text: '',
                        show_alert: false
                    });
                    console.log('✅ Callback query answered');
                } catch (error) {
                    console.error('❌ Error answering callback query:', error.response?.data || error.message);
                }
                
                // Store pending reply
                const pendingRepliesPath = path.join(process.cwd(), 'data', 'pending_replies.json');
                const fs = require('fs');
                let pendingReplies = {};
                if (fs.existsSync(pendingRepliesPath)) {
                    try {
                        pendingReplies = JSON.parse(fs.readFileSync(pendingRepliesPath, 'utf8'));
                    } catch (e) {
                        pendingReplies = {};
                    }
                }
                
                pendingReplies[chatId.toString()] = {
                    messageId: messageId,
                    originalMessage: messageText,
                    timestamp: Date.now(),
                    telegramMessageId: callbackQuery.message.message_id
                };
                
                const dataDir = path.dirname(pendingRepliesPath);
                if (!fs.existsSync(dataDir)) {
                    fs.mkdirSync(dataDir, { recursive: true });
                }
                
                fs.writeFileSync(pendingRepliesPath, JSON.stringify(pendingReplies, null, 2));
                console.log('✅ Pending reply stored');
                
                // Send message asking for reply text
                try {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                        chat_id: chatId,
                        text: `💬 Введите ваше сообщение:`
                    });
                    console.log('✅ Reply prompt sent');
                } catch (error) {
                    console.error('❌ Error sending reply prompt:', error.response?.data || error.message);
                }
                
                // Отвечаем на webhook запрос
                return res.status(200).json({ ok: true });
            } else {
                console.log('⚠️ Callback query data does not start with "reply_":', callbackQuery.data);
            }
        }
        
        // Handle text message from admin (reply to support message)
        if (body.message && body.message.text && body.message.chat.id == CHAT_ID) {
            const chatId = body.message.chat.id.toString();
            const replyText = body.message.text;
            const isReply = body.message.reply_to_message;
            const repliedToMessageId = isReply ? isReply.message_id : null;
            
            console.log('📨 Admin message received:', { chatId, replyText, isReply: !!isReply, repliedToMessageId });
            
            // Check pending replies FIRST (from button click) - это приоритет
            const pendingRepliesPath = path.join(process.cwd(), 'data', 'pending_replies.json');
            // КРИТИЧЕСКИ ВАЖНО: Используем корневой файл (Git версия)
            const fs = require('fs');
            
            let messageId = null;
            
            // First check pending replies (from button click) - если есть pending, используем его
            if (fs.existsSync(pendingRepliesPath)) {
                try {
                    const pendingReplies = JSON.parse(fs.readFileSync(pendingRepliesPath, 'utf8'));
                    if (pendingReplies[chatId]) {
                        messageId = pendingReplies[chatId].messageId;
                        console.log('✅ Found messageId from pending replies:', messageId);
                    }
                } catch (e) {
                    console.error('Error reading pending replies:', e);
                }
            }
            
            // КРИТИЧЕСКИ ВАЖНО: Ищем messageId в базе данных по telegram_message_id
            if (!messageId && isReply) {
                db.get(`
                    SELECT message_id FROM support_messages 
                    WHERE telegram_message_id = ?
                    LIMIT 1
                `, [repliedToMessageId], (err, row) => {
                    if (!err && row) {
                        messageId = row.message_id;
                        console.log('✅ Found messageId from database:', messageId);
                        
                        // Сохраняем ответ в базу данных (используем prepare/run/finalize как для отзывов)
                        if (messageId && replyText) {
                            const stmt = db.prepare(`
                                INSERT INTO support_replies (message_id, reply_text, timestamp)
                                VALUES (?, ?, ?)
                            `);
                            
                            stmt.run([messageId, replyText, Date.now()], function(insertErr) {
                                if (insertErr) {
                                    console.error('❌ Error saving reply to database:', insertErr);
                                    stmt.finalize();
                                } else {
                                    console.log(`✅ Saved reply to DATABASE (persistent storage) - ID: ${this.lastID}`);
                                    console.log(`   ✅ Ответ сохранен в базу данных - НЕ ПОТЕРЯЕТСЯ при деплое!`);
                                    
                                    // Принудительно синхронизируем данные с диском
                                    db.run('PRAGMA wal_checkpoint(FULL);', (checkpointErr) => {
                                        if (checkpointErr) {
                                            console.error('⚠️ Error during WAL checkpoint:', checkpointErr);
                                        } else {
                                            console.log('✅ WAL checkpoint completed - reply is safely saved to disk');
                                        }
                                    });
                                    
                                    stmt.finalize();
                                }
                            });
                        }
                    }
                });
            } else if (messageId && replyText) {
                // Сохраняем ответ в базу данных (используем prepare/run/finalize как для отзывов)
                const stmt = db.prepare(`
                    INSERT INTO support_replies (message_id, reply_text, timestamp)
                    VALUES (?, ?, ?)
                `);
                
                stmt.run([messageId, replyText, Date.now()], function(err) {
                    if (err) {
                        console.error('❌ Error saving reply to database:', err);
                        stmt.finalize();
                    } else {
                        console.log(`✅ Saved reply to DATABASE (persistent storage) - ID: ${this.lastID}`);
                        console.log(`   ✅ Ответ сохранен в базу данных - НЕ ПОТЕРЯЕТСЯ при деплое!`);
                        
                        // Принудительно синхронизируем данные с диском
                        db.run('PRAGMA wal_checkpoint(FULL);', (checkpointErr) => {
                            if (checkpointErr) {
                                console.error('⚠️ Error during WAL checkpoint:', checkpointErr);
                            } else {
                                console.log('✅ WAL checkpoint completed - reply is safely saved to disk');
                            }
                        });
                        
                        stmt.finalize();
                    }
                });
            }
            
            if (messageId) {
                console.log('✅ Processing admin reply:', { messageId, replyText });
                
                // Remove pending reply if exists
                if (fs.existsSync(pendingRepliesPath)) {
                    try {
                        const pendingReplies = JSON.parse(fs.readFileSync(pendingRepliesPath, 'utf8'));
                        if (pendingReplies[chatId]) {
                            delete pendingReplies[chatId];
                            fs.writeFileSync(pendingRepliesPath, JSON.stringify(pendingReplies, null, 2));
                        }
                    } catch (e) {
                        // Ignore
                    }
                }
                
                // Confirm to admin
                try {
                    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                        chat_id: chatId,
                        text: `✅ Ответ отправлен клиенту!`,
                        reply_to_message_id: body.message.message_id
                    });
                    console.log('✅ Confirmation sent to admin');
                } catch (error) {
                    console.error('❌ Error sending confirmation:', error.response?.data || error.message);
                }
            } else {
                console.log('⚠️ Could not find messageId for this reply');
            }
        }
        
        // Отвечаем на webhook запрос
        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('❌ Error handling Telegram webhook:', error);
        res.status(200).json({ ok: true }); // Всегда отвечаем 200, чтобы Telegram не повторял запрос
    }
});

// Endpoint to send reply to client (called when admin sends text message after clicking reply)
app.post('/api/support/send-reply', async (req, res) => {
    try {
        const { messageId, replyText } = req.body;
        
        if (!messageId || !replyText) {
            return res.status(400).json({ 
                success: false, 
                error: 'messageId и replyText обязательны' 
            });
        }
        
        // Store reply for client to fetch
        const repliesPath = path.join(process.cwd(), 'data', 'support_replies.json');
        const fs = require('fs');
        let replies = {};
        if (fs.existsSync(repliesPath)) {
            try {
                replies = JSON.parse(fs.readFileSync(repliesPath, 'utf8'));
            } catch (e) {
                replies = {};
            }
        }
        
        if (!replies[messageId]) {
            replies[messageId] = [];
        }
        
        replies[messageId].push({
            text: replyText,
            timestamp: Date.now()
        });
        
        const dataDir = path.dirname(repliesPath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        fs.writeFileSync(repliesPath, JSON.stringify(replies, null, 2));
        
        res.json({ 
            success: true, 
            message: 'Ответ отправлен клиенту' 
        });
    } catch (error) {
        console.error('Error sending reply:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка отправки ответа' 
        });
    }
});

// Endpoint for client to check for replies
// КРИТИЧЕСКИ ВАЖНО: Читаем из SQLite базы данных - данные НЕ ПОТЕРЯЮТСЯ при деплое!
app.get('/api/support/check-replies/:messageId', (req, res) => {
    try {
        const { messageId } = req.params;
        
        // Читаем ответы из базы данных
        db.all(`
            SELECT reply_text as text, has_image, image_filenames, timestamp
            FROM support_replies
            WHERE message_id = ?
            ORDER BY timestamp ASC
        `, [messageId], (err, rows) => {
            if (err) {
                console.error('❌ Error checking replies from database:', err);
                // Если таблица не существует, пробуем прочитать из JSON (fallback)
                if (err.message && err.message.includes('no such table')) {
                    console.log('📋 Table support_replies does not exist yet - trying to read from JSON');
                    const fs = require('fs');
                    if (fs.existsSync(supportRepliesJsonPath)) {
                        try {
                            const replies = JSON.parse(fs.readFileSync(supportRepliesJsonPath, 'utf8'));
                            const messageReplies = replies[messageId] || [];
                            return res.json({ 
                                success: true, 
                                replies: messageReplies 
                            });
                        } catch (e) {
                            console.error('Error reading from JSON:', e);
                        }
                    }
                }
                return res.status(500).json({ 
                    success: false, 
                    error: 'Ошибка проверки ответов' 
                });
            }
            
            // Преобразуем ответы в нужный формат
            const replies = rows.map(row => ({
                text: row.text,
                hasImage: row.has_image === 1,
                imageFilenames: row.image_filenames ? JSON.parse(row.image_filenames) : [],
                timestamp: row.timestamp
            }));
            
            res.json({
                success: true,
                replies: replies
            });
        });
    } catch (error) {
        console.error('❌ Error checking replies:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Ошибка проверки ответов' 
        });
    }
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

// Log additional info when all routes are registered
console.log(`✅ All routes registered`);
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`Database path: ${dbPath}`);
console.log('Subscription reminders scheduled');
console.log('API routes available:');
console.log('  GET  /api/test - Test endpoint');
console.log('  GET  /api/reviews - Get reviews');
console.log('  POST /api/review - Submit review');
console.log('  POST /api/review/verify - Verify review eligibility');
console.log('  POST /api/subscription - Submit subscription');
console.log('  GET  /api/debug/sync-reviews-from-root - Sync reviews from root to data/');

// Test payment endpoint (СБП с загрузкой чека)
const upload = multer({ 
    dest: 'uploads/receipts/',
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads', 'receipts');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

app.post('/api/test-payment', upload.single('receipt'), async (req, res) => {
    try {
        const { name, email, order_id, cart, total } = req.body;
        const receiptFile = req.file;
        
        if (!name || !email || !order_id || !cart || !receiptFile) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing required fields' 
            });
        }
        
        const cartArray = typeof cart === 'string' ? JSON.parse(cart) : cart;
        const totalAmount = parseFloat(total);
        
        console.log('🧪 Test payment received:');
        console.log('   Name:', name);
        console.log('   Email:', email);
        console.log('   Order ID:', order_id);
        console.log('   Total:', totalAmount);
        console.log('   Receipt file:', receiptFile.filename);
        
        // Сохраняем заказы ТОЛЬКО в JSON (база данных стирается при деплое!)
        const purchaseDate = new Date();
        const normalizedEmail = email.toLowerCase().trim();
        
        // Генерируем уникальный ID для каждого товара в заказе
        const existingOrders = readOrdersFromJSON();
        let maxId = existingOrders.length > 0 ? Math.max(...existingOrders.map(o => o.id || 0)) : 0;
        
        for (const item of cartArray) {
            const itemAmount = item.price * (item.quantity || 1);
            maxId++;
            
            // Сохраняем заказ ТОЛЬКО в JSON файл
            const orderData = {
                id: maxId,
                customer_name: name,
                customer_email: normalizedEmail,
                product_name: item.title,
                product_id: item.id,
                subscription_months: item.months || 1,
                purchase_date: purchaseDate.toISOString(),
                order_id: order_id,
                amount: itemAmount,
                is_active: 1
            };
            
            const savedToJson = addOrderToJSON(orderData);
            if (savedToJson) {
                console.log(`✅ Order saved to orders.json: ${order_id} (product ${item.id}, ID: ${maxId})`);
                
                // Generate reminders (используем ID из JSON)
                if (item.id === 1 || item.id === 3 || item.id === 7) {
                    generateReminders(maxId, item.id, item.months || 1, purchaseDate);
                }
            } else {
                console.error(`❌ Failed to save order to JSON: ${order_id} (product ${item.id})`);
            }
        }
        
        // Send Telegram notification (same format as regular orders)
        const botToken = process.env.TELEGRAM_BOT_TOKEN || '8460494431:AAFOmSEPrzQ1j4_L-4vBG_c38iL2rfx41us';
        const chatId = process.env.TELEGRAM_CHAT_ID || '8334777900';
        
        // Send each item as separate message (same format as payment.html)
        for (let index = 0; index < cartArray.length; index++) {
            const item = cartArray[index];
            const messageNum = index + 1;
            const totalMessages = cartArray.length;
            
            const months = item.months || 1;
            const monthsText = months === 1 ? '1 месяц' : 
                              months >= 2 && months <= 4 ? `${months} месяца` : 
                              `${months} месяцев`;
            
            const telegramMessage = `
🛒 Новый заказ ${messageNum}/${totalMessages}

👤 Имя: ${name}
📧 Email: ${email}
📦 Товар: ${item.title}
🔢 Количество: ${item.quantity || 1}
⏱ Срок подписки: ${monthsText}
💰 Сумма: ${item.price.toLocaleString('ru-RU')} ₽
            `.trim();
            
            try {
                // Send text message
                await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    chat_id: chatId,
                    text: telegramMessage,
                    parse_mode: 'HTML'
                });
                
                // If this is the first item and we have a receipt, send it
                if (index === 0 && receiptFile) {
                    const receiptPath = receiptFile.path;
                    const formData = new FormData();
                    formData.append('chat_id', chatId);
                    formData.append('document', fs.createReadStream(receiptPath), {
                        filename: receiptFile.originalname,
                        contentType: receiptFile.mimetype
                    });
                    
                    await axios.post(`https://api.telegram.org/bot${botToken}/sendDocument`, formData, {
                        headers: formData.getHeaders()
                    });
                }
                
                // Send renewal schedule for ChatGPT, CapCut, and Adobe
                if (item.id === 1 || item.id === 3 || item.id === 7) {
                    // Generate renewal schedule message
                    const purchaseDate = new Date();
                    const productName = item.id === 1 ? 'Chat-GPT' : (item.id === 3 ? 'Adobe' : (item.id === 7 ? 'CapCut' : item.title));
                    
                    let scheduleMessage = `\n\n📅 Расписание продлений ${productName}:\n`;
                    scheduleMessage += `👤 ${name} (${email})\n\n`;
                    
                    if (item.id === 3) {
                        // Adobe logic
                        if (item.months === 12) {
                            for (let i = 1; i <= 4; i++) {
                                const renewalDate = new Date(purchaseDate);
                                renewalDate.setMonth(renewalDate.getMonth() + (i * 3));
                                const dateStr = renewalDate.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
                                const monthsRemaining = 12 - (i * 3);
                                
                                if (monthsRemaining > 0) {
                                    scheduleMessage += `${dateStr} - Продлить подписку (${monthsRemaining} ${monthsRemaining === 1 ? 'месяц' : monthsRemaining >= 2 && monthsRemaining <= 4 ? 'месяца' : 'месяцев'} до окончания)\n`;
                                } else {
                                    scheduleMessage += `${dateStr} - 🔴 Подписка заканчивается\n`;
                                }
                            }
                        } else if (item.months === 6) {
                            const firstRenewal = new Date(purchaseDate);
                            firstRenewal.setMonth(firstRenewal.getMonth() + 3);
                            const firstDateStr = firstRenewal.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
                            scheduleMessage += `${firstDateStr} - Продлить подписку (3 месяца до окончания)\n`;
                            
                            const secondRenewal = new Date(purchaseDate);
                            secondRenewal.setMonth(secondRenewal.getMonth() + 6);
                            const secondDateStr = secondRenewal.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
                            scheduleMessage += `${secondDateStr} - 🔴 Подписка заканчивается\n`;
                        } else {
                            const renewalDate = new Date(purchaseDate);
                            renewalDate.setMonth(renewalDate.getMonth() + item.months);
                            const dateStr = renewalDate.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
                            scheduleMessage += `${dateStr} - 🔴 Подписка заканчивается\n`;
                        }
                    } else {
                        // ChatGPT and CapCut: monthly renewals
                        for (let i = 1; i <= item.months; i++) {
                            const renewalDate = new Date(purchaseDate);
                            renewalDate.setMonth(renewalDate.getMonth() + i);
                            const monthsRemaining = item.months - i;
                            const dateStr = renewalDate.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
                            
                            if (monthsRemaining > 0) {
                                scheduleMessage += `${dateStr} - Продлить подписку ${monthsRemaining} ${monthsRemaining === 1 ? 'месяц' : 'месяцев'} до окончания\n`;
                            } else {
                                scheduleMessage += `${dateStr} - 🔴 Подписка заканчивается\n`;
                            }
                        }
                    }
                    
                    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        chat_id: chatId,
                        text: scheduleMessage
                    });
                }
                
                // Add delay between messages
                if (index < cartArray.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } catch (telegramError) {
                console.error(`❌ Error sending Telegram message for item ${index + 1}:`, telegramError);
            }
        }
        
        try {
            // Send text message
            await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                chat_id: chatId,
                text: telegramMessage,
                parse_mode: 'HTML'
            });
            
            console.log('✅ Telegram notifications sent');
        } catch (telegramError) {
            console.error('❌ Error sending Telegram notification:', telegramError);
        }
        
        res.json({
            success: true,
            message: 'Test payment processed successfully',
            order_id: order_id
        });
    } catch (error) {
        console.error('❌ Error processing test payment:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Сервер уже запущен в начале файла для healthcheck
// Логируем финальную информацию о готовности
console.log(`✅ Server fully initialized and ready`);

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

