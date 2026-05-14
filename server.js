const http = require('http');
const url = require('url');
const mysql = require('mysql2/promise');
const https = require('https');

const BOT_TOKEN = '8736314412:AAHP7xilcBoSoBi8Y5OUiBRRlsFgkI75Lhs';
const CHANNEL = 'thelevelai';
const TRIAL_DAYS = 3;
const PORT = process.env.PORT || 8080;

let db;

async function initDB() {
  try {
    const mysqlUrl = process.env.MYSQL_URL || process.env.MYSQL_PUBLIC_URL;
    
    if (mysqlUrl) {
      // Parse mysql://user:pass@host:port/db
      const parsed = new URL(mysqlUrl);
      db = await mysql.createPool({
        host: parsed.hostname,
        user: parsed.username,
        password: parsed.password,
        database: parsed.pathname.slice(1),
        port: parseInt(parsed.port || '3306'),
        waitForConnections: true,
        connectionLimit: 5,
        ssl: { rejectUnauthorized: false }
      });
    } else {
      db = await mysql.createPool({
        host: process.env.MYSQLHOST || 'localhost',
        user: process.env.MYSQLUSER || 'root',
        password: process.env.MYSQLPASSWORD || '',
        database: process.env.MYSQLDATABASE || 'railway',
        port: parseInt(process.env.MYSQLPORT || '3306'),
        waitForConnections: true,
        connectionLimit: 5,
        ssl: { rejectUnauthorized: false }
      });
    }

    // Test connection
    await db.execute('SELECT 1');
    console.log('DB connected successfully!');

    await db.execute(`CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(50) PRIMARY KEY,
      username VARCHAR(100),
      ref_by VARCHAR(50) DEFAULT '',
      join_date DATETIME DEFAULT NOW(),
      plan VARCHAR(50) DEFAULT 'Level Try',
      trial_start DATETIME DEFAULT NOW(),
      paid_until DATETIME NULL
    )`);
    await db.execute(`CREATE TABLE IF NOT EXISTS payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(50),
      amount INT,
      plan VARCHAR(50),
      payment_method VARCHAR(50),
      status VARCHAR(20) DEFAULT 'pending',
      created_at DATETIME DEFAULT NOW()
    )`);
    console.log('Tables ready!');
  } catch(e) {
    console.error('DB error:', e.code, e.message);
    db = null;
  }
}

function httpsGet(reqUrl) {
  return new Promise((resolve, reject) => {
    https.get(reqUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
    }).on('error', reject);
  });
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  const parsed = url.parse(req.url, true);
  const action = parsed.query.action || '';
  const q = parsed.query;

  try {
    switch(action) {
      case 'ping':
        sendJSON(res, {ok: true, message: 'The Level backend is running!', db: !!db});
        break;

      case 'register': {
        const { userId, userName, refBy = '' } = q;
        if (!userId) { sendJSON(res, {ok: false}); return; }
        if (db) {
          const [rows] = await db.execute('SELECT id FROM users WHERE id = ?', [userId]);
          if (rows.length === 0) {
            await db.execute('INSERT INTO users (id, username, ref_by, trial_start) VALUES (?, ?, ?, NOW())', [userId, userName || 'Unknown', refBy]);
          }
        }
        sendJSON(res, {ok: true});
        break;
      }

      case 'checkSub': {
        const { userId } = q;
        if (!userId) { sendJSON(res, {subscribed: false}); return; }
        try {
          const data = await httpsGet(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${CHANNEL}&user_id=${userId}`);
          const status = data?.result?.status || '';
          sendJSON(res, {subscribed: ['member','administrator','creator'].includes(status)});
        } catch(e) { sendJSON(res, {subscribed: true}); }
        break;
      }

      case 'checkTrial': {
        const { userId } = q;
        if (!userId || !db) { sendJSON(res, {allowed: true, daysLeft: 3, plan: 'Level Try'}); return; }
        const [rows] = await db.execute('SELECT trial_start, plan FROM users WHERE id = ?', [userId]);
        if (rows.length === 0) { sendJSON(res, {allowed: true, daysLeft: 3, plan: 'Level Try'}); return; }
        const user = rows[0];
        if (user.plan !== 'Level Try') { sendJSON(res, {allowed: true, daysLeft: 999, plan: user.plan}); return; }
        const diff = Math.floor((new Date() - new Date(user.trial_start)) / 86400000);
        const daysLeft = Math.max(0, TRIAL_DAYS - diff);
        sendJSON(res, {allowed: daysLeft > 0, daysLeft, plan: user.plan});
        break;
      }

      case 'getRefs': {
        const { userId } = q;
        if (!userId || !db) { sendJSON(res, {count: 0}); return; }
        const [rows] = await db.execute('SELECT COUNT(*) as cnt FROM users WHERE ref_by = ?', ['ref_' + userId]);
        sendJSON(res, {count: parseInt(rows[0].cnt) || 0});
        break;
      }

      case 'getAll': {
        if (!db) { sendJSON(res, []); return; }
        const [rows] = await db.execute("SELECT id as userId, username as userName, ref_by as refBy, DATE_FORMAT(join_date, '%d.%m.%Y') as joinDate, plan FROM users ORDER BY join_date DESC");
        sendJSON(res, rows);
        break;
      }

      case 'updatePlan': {
        const { userId, plan, method = 'manual' } = q;
        if (!userId || !plan || !db) { sendJSON(res, {ok: false}); return; }
        const paidUntil = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
        await db.execute('UPDATE users SET plan = ?, paid_until = ? WHERE id = ?', [plan, paidUntil, userId]);
        const amount = plan === 'The Level' ? 199 : 699;
        await db.execute('INSERT INTO payments (user_id, amount, plan, payment_method, status) VALUES (?, ?, ?, ?, ?)', [userId, amount, plan, method, 'completed']);
        sendJSON(res, {ok: true});
        break;
      }

      default:
        sendJSON(res, {ok: false, error: 'Unknown action'});
    }
  } catch(e) {
    console.error('Request error:', e.message);
    sendJSON(res, {ok: false, error: e.message});
  }
});

initDB().then(() => {
  server.listen(PORT, () => console.log(`Server on port ${PORT}, DB: ${!!db}`));
});
