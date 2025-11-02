# Инструкция по деплою на Render

Этот гайд поможет вам разместить сервер в облаке, чтобы он работал 24/7 без вашего компьютера.

## Шаг 1: Загрузите проект на GitHub

1. Откройте терминал в папке проекта:
```bash
cd /Users/william/benefideal-store
```

2. Инициализируйте Git (если еще не сделано):
```bash
git init
```

3. Добавьте все файлы:
```bash
git add .
```

4. Создайте первый коммит:
```bash
git commit -m "Initial commit"
```

5. Создайте репозиторий на GitHub:
   - Зайдите на https://github.com/new
   - Назовите репозиторий (например, `benefideal-store`)
   - НЕ добавляйте README, .gitignore или лицензию (они уже есть)
   - Нажмите "Create repository"

6. Подключите локальный репозиторий к GitHub:
```bash
git remote add origin https://github.com/ВАШ_НИКНЕЙМ/benefideal-store.git
git branch -M main
git push -u origin main
```

Замените `ВАШ_НИКНЕЙМ` на ваш GitHub никнейм.

## Шаг 2: Создайте аккаунт на Render

1. Перейдите на https://render.com
2. Нажмите "Get Started for Free"
3. Зарегистрируйтесь через GitHub (проще всего)

## Шаг 3: Создайте новый Web Service

1. В панели Render нажмите "New +" → "Web Service"
2. Подключите ваш GitHub репозиторий `benefideal-store`
3. Настройки:
   - **Name**: `benefideal-store`
   - **Region**: выберите ближайший (например, Frankfurt)
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: `Free` (бесплатный план)

4. Нажмите "Create Web Service"

## Шаг 4: Дождитесь деплоя

Render начнет устанавливать зависимости и запускать сервер. Это займет 2-3 минуты.

Вы увидите:
- ✅ Build successful
- ✅ Live at https://your-app.onrender.com

## Шаг 5: Проверьте работу

1. Откройте ваш сайт: `https://your-app.onrender.com`
2. Попробуйте совершить тестовую покупку
3. Проверьте Telegram - должно прийти уведомление

## Важные заметки

- **Free план**: Сервер "засыпает" после 15 минут бездействия, но автоматически просыпается при запросе
- **База данных**: SQLite файл хранится на сервере. При перезапуске данные сохраняются
- **Логи**: Можно просматривать в панели Render
- **Обновления**: При каждом push в GitHub сервер автоматически обновляется

## Альтернатива: Railway

Если Render не подойдет, можно использовать Railway:

1. Зайдите на https://railway.app
2. "New Project" → "Deploy from GitHub repo"
3. Выберите ваш репозиторий
4. Railway автоматически определит Node.js проект и запустит его

## Проблемы?

Если что-то не работает:
1. Проверьте логи в панели Render
2. Убедитесь, что все файлы загружены на GitHub
3. Проверьте, что `package.json` и `server.js` есть в репозитории

