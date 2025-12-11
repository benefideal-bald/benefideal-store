# Откуда таблица берет данные заказов

## Источники данных

Таблица в админ-панели (`admin.html`) получает данные через API endpoint `/api/admin/orders`.

### 1. Фронтенд (admin.html)
```javascript
// Строка 547
const apiUrl = `/api/admin/orders?password=${adminPassword}`;
fetch(apiUrl)  // Запрашивает данные с сервера
```

### 2. Бэкенд (server.js) - эндпоинт `/api/admin/orders`

Эндпоинт читает данные из **ДВУХ источников**:

#### Источник 1: База данных SQLite
```javascript
// Строка 513-527
db.all(`
    SELECT * FROM subscriptions
    ORDER BY purchase_date DESC
`, ...)
```
- Таблица: `subscriptions`
- Файл: `data/subscriptions.db`
- ⚠️ **Проблема**: База данных стирается при каждом деплое на Railway!

#### Источник 2: JSON файл (orders.json)
```javascript
// Строка 509
const jsonOrders = readOrdersFromJSON();
// Читает из: orders.json (в корне проекта, в Git)
```
- Файл: `orders.json` (в корне проекта)
- ✅ **Преимущество**: Файл в Git, не стирается при деплое!

### 3. Объединение данных

Эндпоинт объединяет данные из обоих источников:
```javascript
// Строка 556-574
// 1. Сначала добавляет заказы из базы данных
// 2. Затем добавляет заказы из JSON (если их нет в базе)
// 3. Убирает дубликаты (по order_id + product_id + email)
```

## Проблема

Если база данных пустая (стирается при деплое), но в `orders.json` есть заказы - они должны отображаться.

## Решение

Все новые заказы теперь сохраняются в **оба места**:
1. В базу данных (для быстрого доступа)
2. В `orders.json` (для сохранения при деплое)

## Проверка

Проверьте, что API возвращает заказы:
```bash
curl "https://benefideal-store-production.up.railway.app/api/admin/orders?password=2728276"
```

Если API возвращает заказы, но таблица их не показывает - проблема в `admin.html` (JavaScript).

