import Database from 'better-sqlite3';

const db = new Database('./data/pas2me.sqlite');
console.log('products:', db.prepare(`SELECT sql FROM sqlite_master WHERE name='products'`).get());
console.log('inventory:', db.prepare(`SELECT sql FROM sqlite_master WHERE name='inventory'`).get());
const cols = db.prepare(`PRAGMA table_info(products)`).all();
console.log('cols', cols);
const sample = db.prepare(`SELECT * FROM products LIMIT 1`).get();
console.log('sample', sample);
