// app.js
import express from 'express';
import multer from 'multer';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'; // [MODIFIED]
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'; // [ADDED]
import { createReadStream, readFileSync } from 'fs'; // [MODIFIED]
import { join } from 'path';
import ejs from 'ejs';
import os from 'os';
import xlsx from 'xlsx';

dotenv.config();

const app = express();
const upload = multer({ dest: 'uploads/' });
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

app.set('views', './views');
app.engine('ejs', (path, data, cb) => {
  const template = readFileSync(path, 'utf8');
  const html = ejs.render(template, data);
  cb(null, html);
});
app.set('view engine', 'ejs');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
});

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN
  }
});

// [ADDED] - Helper untuk membuat signed URL
async function getSignedImageUrl(filename) {
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: `products/${filename}`
  });
  return await getSignedUrl(s3, command, { expiresIn: 3600 }); // URL berlaku 1 jam
}

async function initializeDatabase() {
  await pool.query(`CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255),
    catalog ENUM('furniture', 'electronic', 'food', 'fashion'),
    price DECIMAL(10,2),
    image_url TEXT
  )`);

  const [rows] = await pool.query('SELECT COUNT(*) AS count FROM products');
  if (rows[0].count === 0) {
    const dummyNames = ['Kursi Kayu', 'TV LED', 'Nasi Kotak', 'Kaos Polos', 'Meja Kantor'];
    const dummyCatalogs = ['furniture', 'electronic', 'food', 'fashion', 'furniture'];
    const dummyPrices = [250000, 1200000, 15000, 50000, 700000];
    const dummyImages = ['dummy1.jpg', 'dummy2.jpg', 'dummy3.jpg', 'dummy4.jpg', 'dummy5.jpg'];

    for (let i = 0; i < 5; i++) {
      const fileStream = createReadStream(`public/dummy/${dummyImages[i]}`);
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `products/${dummyImages[i]}`,
        Body: fileStream,
        ServerSideEncryption: 'aws:kms' // [OPTIONAL] hanya jika perlu KMS
      }));
      const signedUrl = await getSignedImageUrl(dummyImages[i]); // [MODIFIED]
      await pool.query('INSERT INTO products (name, catalog, price, image_url) VALUES (?, ?, ?, ?)', [
        dummyNames[i], dummyCatalogs[i], dummyPrices[i], signedUrl
      ]);
    }
    console.log('Dummy data inserted.');
  }
}

app.get('/', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM products');
  const data = await Promise.all(rows.map(async row => {
    const filename = row.image_url.split('/').pop();
    const signedUrl = await getSignedImageUrl(`products/${filename}`);
    return { ...row, image_url: signedUrl };
  })); // [MODIFIED]
  const ip = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address;
  res.render('index', { data, msg: req.query.msg || '', ip });
});

app.post('/create', upload.single('image'), async (req, res) => {
  const { name, catalog, price } = req.body;
  if (!req.file) return res.redirect('/?msg=Gambar wajib diupload');
  const filename = Date.now() + '-' + req.file.originalname;
  const fileStream = createReadStream(req.file.path);

  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: `products/${filename}`,
    Body: fileStream,
    ServerSideEncryption: 'aws:kms' // [ADDED]
  }));
  const signedUrl = await getSignedImageUrl(`products/${filename}`); // [MODIFIED]
  await pool.query('INSERT INTO products (name, catalog, price, image_url) VALUES (?, ?, ?, ?)', [name, catalog, price, signedUrl]);
  res.redirect('/?msg=Sukses menambahkan data');
});

app.post('/update/:id', upload.single('image'), async (req, res) => {
  const { name, catalog, price } = req.body;
  const { id } = req.params;
  let imageUrl;
  if (req.file) {
    const filename = Date.now() + '-' + req.file.originalname;
    const fileStream = createReadStream(req.file.path);
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: `products/${filename}`,
      Body: fileStream,
      ServerSideEncryption: 'aws:kms' // [ADDED]
    }));
    imageUrl = await getSignedImageUrl(`products/${filename}`); // [MODIFIED]
  }
  if (imageUrl) {
    await pool.query('UPDATE products SET name=?, catalog=?, price=?, image_url=? WHERE id=?', [name, catalog, price, imageUrl, id]);
  } else {
    await pool.query('UPDATE products SET name=?, catalog=?, price=? WHERE id=?', [name, catalog, price, id]);
  }
  res.redirect('/?msg=Data berhasil diupdate');
});

app.get('/delete/:id', async (req, res) => {
  await pool.query('DELETE FROM products WHERE id=?', [req.params.id]);
  res.redirect('/?msg=Data dihapus');
});

app.get('/export', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM products');
  const worksheet = xlsx.utils.json_to_sheet(rows);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Products');
  const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=products.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

initializeDatabase().then(() => {
  app.listen(process.env.PORT || 3000, () => console.log('App running...'));
});
