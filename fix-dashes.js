// Скрипт для замены длинных тире на обычные дефисы в отзывах
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(process.cwd(), 'data', 'subscriptions.db');
if (!fs.existsSync(dbPath)) {
    console.error('Database not found at:', dbPath);
    process.exit(1);
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
    
    console.log('✅ Database opened');
    
    // Находим все отзывы с длинными тире
    db.all("SELECT id, customer_name, review_text FROM reviews WHERE review_text LIKE '%—%' OR review_text LIKE '%–%' OR review_text LIKE '%—%'", [], (err, rows) => {
        if (err) {
            console.error('Error finding reviews:', err);
            db.close();
            return;
        }
        
        if (rows.length === 0) {
            console.log('✅ No reviews with long dashes found');
            db.close();
            return;
        }
        
        console.log(`Found ${rows.length} reviews with long dashes:`);
        rows.forEach(r => {
            console.log(`  - ${r.customer_name} (ID: ${r.id})`);
        });
        
        // Заменяем длинные тире на обычные дефисы
        let updated = 0;
        rows.forEach((row) => {
            const newText = row.review_text
                .replace(/—/g, '-')  // em dash
                .replace(/–/g, '-')   // en dash
                .replace(/—/g, '-');  // другой вариант em dash
            
            if (newText !== row.review_text) {
                db.run("UPDATE reviews SET review_text = ? WHERE id = ?", [newText, row.id], (err) => {
                    if (err) {
                        console.error(`Error updating review ${row.id}:`, err);
                    } else {
                        updated++;
                        console.log(`✅ Updated review ${row.id} (${row.customer_name})`);
                    }
                    
                    if (updated === rows.length) {
                        console.log(`\n✅ All ${updated} reviews updated successfully!`);
                        db.close();
                    }
                });
            }
        });
    });
});

