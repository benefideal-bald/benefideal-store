# Настройка домена benefideal.ru на Railway

## Проблема:
Домен `benefideal.ru` все еще указывает на старый Render сервер, а не на Railway.

## Решение: Настроить кастомный домен на Railway

### Шаг 1: Добавить домен в Railway
1. Откройте Railway Dashboard: https://railway.app
2. Выберите проект `benefideal-store`
3. Выберите сервис (production)
4. Перейдите в раздел **"Settings"** → **"Domains"**
5. Нажмите **"Add Domain"**
6. Введите: `benefideal.ru`
7. Railway покажет DNS записи, которые нужно настроить

### Шаг 2: Настроить DNS записи
Railway покажет что-то вроде:
```
Type: CNAME
Name: @ (или benefideal.ru)
Value: benefideal-store-production.up.railway.app
```

**Вариант A (CNAME):**
- В настройках DNS вашего домена (где вы покупали benefideal.ru)
- Добавьте CNAME запись:
  - Name: `@` или `benefideal.ru`
  - Value: `benefideal-store-production.up.railway.app`
  - TTL: 3600 (или Auto)

**Вариант B (A record):**
- Если CNAME не поддерживается, используйте A record:
  - Railway покажет IP адрес
  - Добавьте A record с этим IP

### Шаг 3: Дождаться обновления DNS
- Обычно занимает 5-30 минут
- Проверить можно командой:
  ```bash
  dig benefideal.ru CNAME
  ```
  Должен вернуть Railway домен

### Шаг 4: Проверить SSL сертификат
Railway автоматически выдаст SSL сертификат через Let's Encrypt.
Подождите несколько минут после настройки DNS.

### Шаг 5: Проверить работу
После настройки:
```bash
curl https://benefideal.ru/api/admin/orders?password=2728276
```
Должен вернуть заказы (как на Railway).

## Важно:
- После настройки DNS старый Render сервер больше не будет использоваться
- Все запросы будут идти на Railway
- Заказы будут показываться из orders.json

