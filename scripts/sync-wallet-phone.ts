import Database from 'better-sqlite3';

const db = new Database('./data/pas2me.sqlite');
db.prepare(
  `UPDATE wallets SET phone = '2348134481508' WHERE user_id = 'usr_No1_QccOGHVxY7xgLC3Yj'`
).run();
console.log('users', db.prepare('SELECT phone FROM users').all());
console.log('wallets', db.prepare('SELECT phone FROM wallets').all());
db.close();
