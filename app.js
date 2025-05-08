import express from 'express';
import multer from 'multer';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream, readFileSync } from 'fs';
import { readdirSync } from 'fs';
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
host: process.env.DB\_HOST,
user: process.env.DB\_USER,
password: process.env.DB\_PASSWORD,
database: process.env.DB\_NAME,
port: process.env.DB\_PORT
});

const s3 = new S3Client({
region: process.env.AWS\_REGION,
credentials: {
accessKeyId: process.env.AWS\_ACCESS\_KEY\_ID,
secretAccessKey: process.env.AWS\_SECRET\_ACCESS\_KEY,
sessionToken: process.env.AWS\_SESSION\_TOKEN
}
});

async function initializeDatabase() {
await pool.query(`CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255),
    catalog ENUM('furniture', 'electronic', 'food', 'fashion'),
    price DECIMAL(10,2),
    image_url TEXT
  )`);

const \[rows] = await pool.query('SELECT COUNT(\*) AS count FROM products');
if (rows\[0].count === 0) {
const dummyNames = \['Kursi Kayu', 'TV LED', 'Nasi Kotak', 'Kaos Polos', 'Meja Kantor'];
const dummyCatalogs = \['furniture', 'electronic', 'food', 'fashion', 'furniture'];
const dummyPrices = \[250000, 1200000, 15000, 50000, 700000];
const dummyImages = \['dummy1.jpg', 'dummy2.jpg', 'dummy3.jpg', 'dummy4.jpg', 'dummy5.jpg'];

```
for (let i = 0; i < 5; i++) {
  const fileStream = createReadStream(`public/dummy/${dummyImages[i]}`);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: `products/${Date.now()}-${dummyImages[i]}`,
    Body: fileStream
  }));
  const imageUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/products/${Date.now()}-${dummyImages[i]}`;
  await pool.query('INSERT INTO products (name, catalog, price, image_url) VALUES (?, ?, ?, ?)', [
    dummyNames[i], dummyCatalogs[i], dummyPrices[i], imageUrl
  ]);
}
console.log('Dummy data inserted.');
```

}
}

app.get('/', async (req, res) => {
const \[rows] = await pool.query('SELECT \* FROM products');
const ip = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address;
res.render('index', { data: rows, msg: req.query.msg || '', ip });
});

app.post('/create', upload.single('image'), async (req, res) => {
const { name, catalog, price } = req.body;
if (!req.file) return res.redirect('/?msg=Gambar wajib diupload');

const original = req.file.originalname;
const shortName = original.split('.').slice(0, -1).join('').substring(0, 30);
const ext = original.split('.').pop();
const filename = `${Date.now()}-${shortName}.${ext}`;

const fileStream = createReadStream(req.file.path);
await s3.send(new PutObjectCommand({
Bucket: process.env.S3\_BUCKET\_NAME,
Key: `products/${filename}`,
Body: fileStream
}));
const imageUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/products/${filename}`;
await pool.query('INSERT INTO products (name, catalog, price, image\_url) VALUES (?, ?, ?, ?)', \[name, catalog, price, imageUrl]);
res.redirect('/?msg=Sukses menambahkan data');
});

app.post('/update/\:id', upload.single('image'), async (req, res) => {
const { name, catalog, price } = req.body;
const { id } = req.params;
let imageUrl;
if (req.file) {
const original = req.file.originalname;
const shortName = original.split('.').slice(0, -1).join('').substring(0, 30);
const ext = original.split('.').pop();
const filename = `${Date.now()}-${shortName}.${ext}`;

```
const fileStream = createReadStream(req.file.path);
await s3.send(new PutObjectCommand({
  Bucket: process.env.S3_BUCKET_NAME,
  Key: `products/${filename}`,
  Body: fileStream
}));
imageUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/products/${filename}`;
```

}

if (imageUrl) {
await pool.query('UPDATE products SET name=?, catalog=?, price=?, image\_url=? WHERE id=?', \[name, catalog, price, imageUrl, id]);
} else {
await pool.query('UPDATE products SET name=?, catalog=?, price=? WHERE id=?', \[name, catalog, price, id]);
}
res.redirect('/?msg=Data berhasil diupdate');
});

app.get('/delete/\:id', async (req, res) => {
await pool.query('DELETE FROM products WHERE id=?', \[req.params.id]);
res.redirect('/?msg=Data dihapus');
});

app.get('/export', async (req, res) => {
const \[rows] = await pool.query('SELECT \* FROM products');
const worksheet = xlsx.utils.json\_to\_sheet(rows);
const workbook = xlsx.utils.book\_new();
xlsx.utils.book\_append\_sheet(workbook, worksheet, 'Products');
const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
res.setHeader('Content-Disposition', 'attachment; filename=products.xlsx');
res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
res.send(buffer);
});

initializeDatabase().then(() => {
app.listen(process.env.PORT || 3000, () => console.log('App running...'));
});
