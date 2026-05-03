## Nginx load balancer dengan database MySQL dan S3
## 📚 Perpustakaan Digital - CRUD App

Aplikasi manajemen perpustakaan berbasis Node.js + MySQL + AWS S3, dengan loadbalancer Nginx

---
![Infra](/image/dark-nginx_loadbalancer_mysql_s3-libraryapp.drawio.png)

---

## A. Infrastruktur

1. VPC
````
Nama : kantor
IP : 172.16.0.0/24
````

2. Subnet : 4 buah 
````
kantor-private-1 : 172.16.0.0/25
kantor-private-2 : 172.16.0.128/26
kantor-private-3 : 172.16.0.192/27
kantor-public : 172.16.0.224/28
````

3. Instance EC2 : 4 buah
````
srv-kantor-private-1 : ubuntu + node.js : di subnet kantor-private-1
srv-kantor-private-2 : ubuntu + node.js : di subnet kantor-private-2
db-kantor-private-3 : ubuntu + mysql : di subnet kantor-private-3 untuk database MySQL
lb-kantor-public : ubuntu + Nginx : di subnet kantor-public untuk load balancer
````

4. SG : 1 buah
````
kantor-sg:
allow inbound 22(SSH), 80(HTTP), 443(HTTPS), 3306(MySQL), TCP/3000(Node.js), dan ICMP(ping)
from 0.0.0.0/0
````

5. IGW : 1 buah
````
kantor-igw attach ke VPC kantor 
````


6. Route table : 2 buah
````
kantor-public-rt:
subnet-associations ke kantor-public
0.0.0.0/0 via IGW kantor-igw
````

Kemudian buat dulu instance EC2 lb-kantor-public, baru buat routing table berikut ini:
````
kantor-private-rt:
subnet-associations ke kantor-private-1, kantor-private-2, kantor-private-3
0.0.0.0/0 via NAT instance lb-kantor-public
````


## B. Fitur
- ✅ CRUD buku (Create, Read, Update, Delete)
- ✅ Upload cover buku ke AWS S3
- ✅ Tampil hostname & IP server di header
- ✅ Search & filter berdasarkan kategori
- ✅ Responsive UI
- ❌ Server masih monolitik : FrontEnd, API, dan BackEnd dalam 1 server

## C. Struktur File
```
library-app/
├── server.js          # Backend Express API
├── package.json
├── .env.example       # Template environment variables
└── public/
    └── index.html     # Frontend SPA
```

## D. Cara Install & Jalankan

### 1. Install dependencies
```bash
npm install
```

### 2. Buat file .env
```bash
cp .env.example .env
# Edit .env sesuaikan dengan konfigurasi kamu
```

### 3. Isi .env
```env
PORT=3000
DB_HOST=your-mysql-host
DB_USER=admin
DB_PASSWORD=admin123
DB_NAME=perpustakaan
AWS_REGION=us-east-1
S3_BUCKET=your-bucket-name
```

### 4. Buat server Database MySQL (db-kantor-private-3)

Buat server database MySQL db-kantor-private-3 yang ada di subnet kantor-private-3.

Berikut adalah UserData untuk membuat server mysql tersebut:

username : admin / password : admin123

```sql
#!/bin/bash

# Update package list
apt-get update -y

# Install MySQL Server
apt-get install mysql-server -y

# Start dan enable MySQL
systemctl start mysql
systemctl enable mysql

# Set root password dan konfigurasi keamanan
mysql -u root <<EOF
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'P4ssw0rd';
DELETE FROM mysql.user WHERE User='';
DELETE FROM mysql.user WHERE User='root' AND Host NOT IN ('localhost', '127.0.0.1', '::1');
DROP DATABASE IF EXISTS test;
DELETE FROM mysql.db WHERE Db='test' OR Db='test\\_%';
FLUSH PRIVILEGES;
EOF

# Ganti '@localhost' jadi '@%' agar bisa remote
mysql -u root -p'P4ssw0rd' <<EOF
CREATE USER 'admin'@'%' IDENTIFIED BY 'admin123';
GRANT ALL PRIVILEGES ON *.* TO 'admin'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
EOF

# Ubah bind-address ke 0.0.0.0
sed -i 's/^bind-address\s*=.*/bind-address = 0.0.0.0/' /etc/mysql/mysql.conf.d/mysqld.cnf
grep -q "^bind-address" /etc/mysql/mysql.conf.d/mysqld.cnf || \
  echo "bind-address = 0.0.0.0" >> /etc/mysql/mysql.conf.d/mysqld.cnf

# Restart MySQL agar config berlaku
systemctl restart mysql

# Log selesai
echo "MySQL installation completed" >> /var/log/user-data.log
```

> Database `perpustakaan` dan Tabel `books` akan dibuat otomatis saat server pertama kali dijalankan.

### 5. Konfigurasi S3 Bucket
- Buat S3 bucket di AWS Console
- Nonaktifkan "Block all public access" agar gambar bisa diakses publik
- Tambahkan bucket policy berikut:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::your-bucket-name/*"
  }]
}
```

### 6. Jalankan server
```bash
# Production
npm start

# Development (auto-restart)
npm run dev
```

Buka browser: `http://localhost:3000`

## E. API Endpoints

| Method | Endpoint | Keterangan |
|--------|----------|------------|
| GET | /api/server-info | Info hostname & IP |
| GET | /api/books | Ambil semua buku |
| GET | /api/books/:id | Ambil satu buku |
| POST | /api/books | Tambah buku baru |
| PUT | /api/books/:id | Edit buku |
| DELETE | /api/books/:id | Hapus buku |
| GET | /api/categories | List kategori |

## F. User Data AWS (EC2) untuk srv-kantor-private-1 dan srv-kantor-private-2

Untuk deploy otomatis di EC2, tambahkan ke User Data:

```bash
#!/bin/bash
apt-get update -y
apt-get install -y nodejs npm git

git clone https://github.com/paknux/nginx_loadbalancer_mysql_s3-libraryapp.git /app
cd /app
npm install

cat > .env <<EOF
PORT=3000
DB_HOST=YOUR_DB_HOST
DB_USER=admin
DB_PASSWORD=admin123
DB_NAME=perpustakaan
AWS_REGION=us-east-1
S3_BUCKET=YOUR_BUCKET_NAME
EOF

npm install -g pm2
pm2 start server.js --name library-app
pm2 startup
pm2 save
```
