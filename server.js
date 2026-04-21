const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ─── Multer (memory storage, upload to S3) ───────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only JPG, PNG, WEBP allowed'));
  }
});

// ─── S3 Client ───────────────────────────────────────────────
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'ap-southeast-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  }
});

// ─── MySQL Pool (tanpa database dulu, untuk bisa CREATE DATABASE) ────────────
const poolNoDB = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 5,
});

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// ─── Init DB: buat database & tabel jika belum ada ───────────────────────────
async function initDB() {
  // Buat database perpustakaan jika belum ada
  const connNoDB = await poolNoDB.getConnection();
  const dbName = process.env.DB_NAME || 'perpustakaan';
  await connNoDB.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  connNoDB.release();
  console.log(`✅ Database '${dbName}' siap`);

  // Buat tabel books jika belum ada
  const conn = await pool.getConnection();
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS books (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      author VARCHAR(255) NOT NULL,
      isbn VARCHAR(50),
      category VARCHAR(100),
      year INT,
      description TEXT,
      cover_url VARCHAR(500),
      cover_key VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  conn.release();
  console.log('✅ Tabel books siap');
}

// ─── Server Info ──────────────────────────────────────────────
function getServerInfo() {
  const interfaces = os.networkInterfaces();
  let ip = '127.0.0.1';
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        ip = alias.address;
        break;
      }
    }
  }
  return { hostname: os.hostname(), ip };
}

// ─── S3 Upload Helper ─────────────────────────────────────────
async function uploadToS3(file) {
  const ext = path.extname(file.originalname);
  const key = `books/${uuidv4()}${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  }));
  const url = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION || 'ap-southeast-1'}.amazonaws.com/${key}`;
  return { key, url };
}

async function deleteFromS3(key) {
  if (!key) return;
  await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
}

// ─── API Routes ───────────────────────────────────────────────

// GET server info
app.get('/api/server-info', (req, res) => {
  res.json(getServerInfo());
});

// GET db status
app.get('/api/db-status', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const [[row]] = await conn.execute('SELECT VERSION() AS version, NOW() AS now');
    const [[tbl]] = await conn.execute('SELECT COUNT(*) AS total FROM books');
    conn.release();
    res.json({ status: 'connected', version: row.version, time: row.now, total_books: tbl.total });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// GET all books
app.get('/api/books', async (req, res) => {
  try {
    const { search, category } = req.query;
    let query = 'SELECT * FROM books WHERE 1=1';
    const params = [];
    if (search) {
      query += ' AND (title LIKE ? OR author LIKE ? OR isbn LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }
    query += ' ORDER BY created_at DESC';
    const [rows] = await pool.execute(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET single book
app.get('/api/books/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM books WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Book not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST create book
app.post('/api/books', upload.single('cover'), async (req, res) => {
  try {
    const { title, author, isbn, category, year, description } = req.body;
    if (!title || !author) return res.status(400).json({ success: false, message: 'Title and author required' });

    let cover_url = null, cover_key = null;
    if (req.file) {
      const s3Result = await uploadToS3(req.file);
      cover_url = s3Result.url;
      cover_key = s3Result.key;
    }

    const [result] = await pool.execute(
      'INSERT INTO books (title, author, isbn, category, year, description, cover_url, cover_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [title, author, isbn || null, category || null, year || null, description || null, cover_url, cover_key]
    );
    const [rows] = await pool.execute('SELECT * FROM books WHERE id = ?', [result.insertId]);
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT update book
app.put('/api/books/:id', upload.single('cover'), async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM books WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ success: false, message: 'Book not found' });

    const { title, author, isbn, category, year, description } = req.body;
    let { cover_url, cover_key } = existing[0];

    if (req.file) {
      await deleteFromS3(cover_key);
      const s3Result = await uploadToS3(req.file);
      cover_url = s3Result.url;
      cover_key = s3Result.key;
    }

    await pool.execute(
      'UPDATE books SET title=?, author=?, isbn=?, category=?, year=?, description=?, cover_url=?, cover_key=? WHERE id=?',
      [title, author, isbn || null, category || null, year || null, description || null, cover_url, cover_key, req.params.id]
    );
    const [rows] = await pool.execute('SELECT * FROM books WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE book
app.delete('/api/books/:id', async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM books WHERE id = ?', [req.params.id]);
    if (!existing.length) return res.status(404).json({ success: false, message: 'Book not found' });
    await deleteFromS3(existing[0].cover_key);
    await pool.execute('DELETE FROM books WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Book deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET categories
app.get('/api/categories', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT DISTINCT category FROM books WHERE category IS NOT NULL ORDER BY category');
    res.json({ success: true, data: rows.map(r => r.category) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    const { hostname, ip } = getServerInfo();
    console.log(`🚀 Server running on http://${ip}:${PORT}`);
    console.log(`📦 Hostname: ${hostname}`);
  });
}).catch(err => {
  console.error('❌ DB init failed:', err.message);
  process.exit(1);
});
