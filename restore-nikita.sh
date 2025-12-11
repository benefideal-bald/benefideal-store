#!/bin/bash

# Скрипт для автоматического восстановления заказа Никиты
# Использование: ./restore-nikita.sh [PASSWORD]

PASSWORD=${1:-admin123}
URL="https://benefideal-store-production.up.railway.app/api/admin/auto-restore-nikita?password=${PASSWORD}"

echo "🔧 Восстанавливаю заказ Никиты..."
echo "URL: ${URL}"

response=$(curl -s -X POST "${URL}")

echo ""
echo "Ответ сервера:"
echo "${response}" | python3 -m json.tool 2>/dev/null || echo "${response}"

echo ""
if echo "${response}" | grep -q '"success":true'; then
    echo "✅ Заказ успешно восстановлен!"
else
    echo "❌ Ошибка при восстановлении заказа"
    echo "Проверьте логи сервера"
fi

