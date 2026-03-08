/**
 * @file    server.js
 * @brief   Prime Mibzer — Hassas Ekim Telemetri Sunucusu
 * @version 4.0.0
 * @date    2026-03-08
 *
 * @details ESP32'den gelen sensor verilerini alir, SQLite'a kaydeder
 *          ve telefondan canli izleme dashboard'u sunar.
 *
 *          v4: Kimlik dogrulama + TOTP 2FA + Admin paneli eklendi.
 *
 *          Kurulum:
 *            npm install
 *            node server.js
 *
 *          Ortam degiskenleri:
 *            PORT           — HTTP port (varsayilan: 3000)
 *            SESSION_SECRET — Oturum sifreleme anahtari (varsayilan: otomatik)
 */

const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { TOTP, Secret } = require('otpauth');
const QRCode = require('qrcode');

/* ============================================================================
 *                           YAPILANDIRMA
 * ============================================================================ */

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'mibzer.db');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

/* Firmware yukleme dizini */
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* Multer yapilandirmasi — 4 MB sinir (.bin dosyalari) */
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${ts}_${safe}`);
  }
});
const uploadMw = multer({ storage, limits: { fileSize: 4 * 1024 * 1024 } });

/* ============================================================================
 *                           VERITABANI
 * ============================================================================ */

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

/* Ana veri tablosu — kullanici telemetrisi */
db.exec(`
  CREATE TABLE IF NOT EXISTS telemetry (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            DATETIME DEFAULT (datetime('now')),
    device_id     TEXT,
    uptime_ms     INTEGER,
    speed_kmh     REAL,
    spacing_cm    REAL,
    target_cm     REAL,
    confidence    INTEGER,
    speed_source  INTEGER,
    motor_hz      REAL,
    motor_target  REAL,
    motor_enabled INTEGER,
    seeds         INTEGER,
    singulation   INTEGER,
    miss          INTEGER,
    double_pct    INTEGER,
    area_ha       REAL,
    distance_m    REAL,
    seeding_state INTEGER,
    lat           REAL,
    lon           REAL,
    satellites    INTEGER,
    gps_valid     INTEGER,
    gps_speed     REAL,
    heading       REAL,
    pitch         REAL,
    roll_deg      REAL,
    vibration     INTEGER,
    seed_spacing_cv REAL,
    seed_active     INTEGER,
    disk_rpm        REAL,
    disk_stability  REAL,
    disk_connected  INTEGER,
    cpu_load      INTEGER,
    alarm_count   INTEGER,
    link          INTEGER,
    wifi_rssi     INTEGER
  )
`);

/* Sirket analitik tablosu */
db.exec(`
  CREATE TABLE IF NOT EXISTS analytics (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              DATETIME DEFAULT (datetime('now')),
    device_id       TEXT,
    fw_version      TEXT,
    uptime_ms       INTEGER,
    boot_count      INTEGER,
    total_seeds     INTEGER,
    area_ha         REAL,
    distance_m      REAL,
    seeding_state   INTEGER,
    link_active     INTEGER,
    cpu_load        INTEGER,
    alarm_count     INTEGER,
    alarm_highest   INTEGER,
    free_heap       INTEGER,
    wifi_rssi       INTEGER,
    wifi_ssid       TEXT,
    tele_sent       INTEGER,
    tele_fail       INTEGER,
    tele_enabled    INTEGER,
    lat             REAL,
    lon             REAL,
    gps_valid       INTEGER
  )
`);

/* Firmware tablosu */
db.exec(`
  CREATE TABLE IF NOT EXISTS firmware (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          DATETIME DEFAULT (datetime('now')),
    target      TEXT NOT NULL,
    version     TEXT NOT NULL,
    filename    TEXT NOT NULL,
    filepath    TEXT NOT NULL,
    size        INTEGER,
    checksum    TEXT,
    notes       TEXT,
    active      INTEGER DEFAULT 1
  )
`);

/* Firmware atama tablosu */
db.exec(`
  CREATE TABLE IF NOT EXISTS firmware_assignments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          DATETIME DEFAULT (datetime('now')),
    device_id   TEXT NOT NULL,
    firmware_id INTEGER NOT NULL,
    status      TEXT DEFAULT 'pending',
    progress    INTEGER DEFAULT 0,
    error_msg   TEXT,
    updated_at  DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (firmware_id) REFERENCES firmware(id)
  )
`);

/* Kullanici tablosu — kimlik dogrulama */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret   TEXT,
    totp_enabled  INTEGER DEFAULT 0,
    role          TEXT DEFAULT 'user',
    created_at    DATETIME DEFAULT (datetime('now'))
  )
`);

/* Ayarlar tablosu */
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

/* Varsayilan ayarlar */
const defaultSettings = {
  site_name: 'PRIME MIBZER',
  site_subtitle: 'Cihaz Yonetim Paneli'
};
for (const [k, v] of Object.entries(defaultSettings)) {
  const exists = db.prepare('SELECT key FROM settings WHERE key = ?').get(k);
  if (!exists) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);
  }
}

/* Indexler */
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_ts ON telemetry(ts);
  CREATE INDEX IF NOT EXISTS idx_device ON telemetry(device_id);
  CREATE INDEX IF NOT EXISTS idx_analytics_ts ON analytics(ts);
  CREATE INDEX IF NOT EXISTS idx_analytics_device ON analytics(device_id);
  CREATE INDEX IF NOT EXISTS idx_fw_assign_device ON firmware_assignments(device_id);
  CREATE INDEX IF NOT EXISTS idx_fw_assign_status ON firmware_assignments(status);
`);

/* Varsayilan admin kullanici olustur (yoksa) */
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('PrimeTech');
if (!adminExists) {
  const hash = bcrypt.hashSync('PrimeTech2026.akgol', 10);
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('PrimeTech', hash, 'admin');
  console.log('[AUTH] Varsayilan admin kullanici olusturuldu: PrimeTech');
}

/* Hazir sorgular */
const stmtInsert = db.prepare(`
  INSERT INTO telemetry (
    device_id, uptime_ms,
    speed_kmh, spacing_cm, target_cm, confidence, speed_source,
    motor_hz, motor_target, motor_enabled,
    seeds, singulation, miss, double_pct, area_ha, distance_m, seeding_state,
    lat, lon, satellites, gps_valid, gps_speed, heading,
    pitch, roll_deg, vibration,
    seed_spacing_cv, seed_active,
    disk_rpm, disk_stability, disk_connected,
    cpu_load, alarm_count, link, wifi_rssi
  ) VALUES (
    @device_id, @uptime_ms,
    @speed_kmh, @spacing_cm, @target_cm, @confidence, @speed_source,
    @motor_hz, @motor_target, @motor_enabled,
    @seeds, @singulation, @miss, @double_pct, @area_ha, @distance_m, @seeding_state,
    @lat, @lon, @satellites, @gps_valid, @gps_speed, @heading,
    @pitch, @roll_deg, @vibration,
    @seed_spacing_cv, @seed_active,
    @disk_rpm, @disk_stability, @disk_connected,
    @cpu_load, @alarm_count, @link, @wifi_rssi
  )
`);

const stmtAnalytics = db.prepare(`
  INSERT INTO analytics (
    device_id, fw_version, uptime_ms, boot_count,
    total_seeds, area_ha, distance_m, seeding_state,
    link_active, cpu_load, alarm_count, alarm_highest, free_heap,
    wifi_rssi, wifi_ssid,
    tele_sent, tele_fail, tele_enabled,
    lat, lon, gps_valid
  ) VALUES (
    @device_id, @fw_version, @uptime_ms, @boot_count,
    @total_seeds, @area_ha, @distance_m, @seeding_state,
    @link_active, @cpu_load, @alarm_count, @alarm_highest, @free_heap,
    @wifi_rssi, @wifi_ssid,
    @tele_sent, @tele_fail, @tele_enabled,
    @lat, @lon, @gps_valid
  )
`);

const stmtLatest = db.prepare('SELECT * FROM telemetry ORDER BY id DESC LIMIT 1');

const stmtHistory = db.prepare(`
  SELECT * FROM telemetry
  WHERE ts >= datetime('now', ?)
  ORDER BY ts DESC
  LIMIT ?
`);

/* ============================================================================
 *                           EXPRESS SUNUCU
 * ============================================================================ */

const app = express();
app.use(cors());
app.use(express.json({ limit: '16kb' }));

/* Oturum yonetimi */
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,  /* 24 saat */
    httpOnly: true,
    sameSite: 'lax'
  }
}));

/* ============================================================================
 *                           AUTH MIDDLEWARE
 * ============================================================================ */

/** Oturum kontrol — tarayici icin (HTML sayfalar) */
function requireAuth(req, res, next) {
  if (req.session && req.session.userId && req.session.authenticated) {
    return next();
  }
  return res.redirect('/login.html');
}

/** Oturum kontrol — API icin (JSON yanit) */
function requireAuthAPI(req, res, next) {
  if (req.session && req.session.userId && req.session.authenticated) {
    return next();
  }
  return res.status(401).json({ error: 'Oturum acmaniz gerekiyor' });
}

/** Admin rol kontrol — API icin */
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId || !req.session.authenticated) {
    return res.status(401).json({ error: 'Oturum acmaniz gerekiyor' });
  }
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Yetkiniz yok' });
  }
  return next();
}

/* ============================================================================
 *                       STATIK DOSYA SERVISI
 *             Login sayfasi acik, diger sayfalar korunmali
 * ============================================================================ */

/* Login sayfasi — auth gerektirmez */
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

/* TOTP kurulum sayfasi — parcali auth (sifre gecmis, TOTP kurulmamis) */
app.get('/totp-setup.html', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'totp-setup.html'));
});

/* Korunan dashboard sayfalari */
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/index.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/monitor.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'monitor.html'));
});
app.get('/analytics.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'analytics.html'));
});
app.get('/ota.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ota.html'));
});
app.get('/admin.html', (req, res) => {
  if (!req.session || !req.session.authenticated) return res.redirect('/login.html');
  if (req.session.role !== 'admin') return res.status(403).send('Yetkiniz yok');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

/* CSS/JS/resim gibi statik dosyalar icin (font, favicon vs.) */
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

/* ============================================================================
 *                       AUTH ENDPOINTLERI
 * ============================================================================ */

/** POST /auth/login — Kullanici adi + sifre dogrulama */
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanici adi ve sifre zorunlu' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Kullanici adi veya sifre hatali' });
  }

  /* Sifre dogru — oturuma kullanici bilgisi yaz */
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;

  /* TOTP kurulu mu? */
  if (user.totp_enabled) {
    req.session.authenticated = false;  /* TOTP bekleniyor */
    return res.json({ ok: true, step: 'totp', message: 'TOTP kodu girin' });
  }

  /* TOTP kurulmamis — kurulum sayfasina yonlendir */
  req.session.authenticated = false;
  return res.json({ ok: true, step: 'totp-setup', message: 'TOTP kurulumu gerekli' });
});

/** GET /auth/totp-setup — QR kod + secret uret (ilk kurulum) */
app.get('/auth/totp-setup', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Once giris yapin' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'Kullanici bulunamadi' });

  try {
    /* Yeni secret uret */
    const secret = new Secret();
    const secretBase32 = secret.base32;

    /* Gecici olarak session'a kaydet (henuz DB'ye yazmiyoruz) */
    req.session.pendingTotpSecret = secretBase32;

    /* TOTP URI olustur */
    const totp = new TOTP({
      issuer: 'PrimeMibzer',
      label: user.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: secret
    });

    const otpauthUri = totp.toString();
    const qrDataUrl = await QRCode.toDataURL(otpauthUri);

    res.json({
      ok: true,
      secret: secretBase32,
      qr: qrDataUrl,
      username: user.username
    });
  } catch (err) {
    console.error('[AUTH] QR kod olusturma hatasi:', err.message);
    res.status(500).json({ error: 'QR kod olusturulamadi' });
  }
});

/** POST /auth/setup-totp — TOTP ilk kurulum dogrulama */
app.post('/auth/setup-totp', (req, res) => {
  if (!req.session || !req.session.userId || !req.session.pendingTotpSecret) {
    return res.status(401).json({ error: 'Once giris yapin ve QR kodu tarayin' });
  }

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Dogrulama kodu zorunlu' });

  const totp = new TOTP({
    issuer: 'PrimeMibzer',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(req.session.pendingTotpSecret)
  });

  const delta = totp.validate({ token: code.toString().trim(), window: 1 });

  if (delta === null) {
    return res.status(401).json({ error: 'Gecersiz kod. Google Authenticator\'daki kodu girin.' });
  }

  /* TOTP'yi DB'ye kaydet ve aktiflestir */
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?')
    .run(req.session.pendingTotpSecret, req.session.userId);

  delete req.session.pendingTotpSecret;
  req.session.authenticated = true;

  console.log(`[AUTH] TOTP kuruldu: ${req.session.username}`);
  res.json({ ok: true, message: 'TOTP basariyla kuruldu' });
});

/** POST /auth/verify-totp — TOTP kod dogrulama (her giris) */
app.post('/auth/verify-totp', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Once giris yapin' });
  }

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Dogrulama kodu zorunlu' });

  const user = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !user.totp_secret) {
    return res.status(400).json({ error: 'TOTP kurulmamis' });
  }

  const totp = new TOTP({
    issuer: 'PrimeMibzer',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(user.totp_secret)
  });

  const delta = totp.validate({ token: code.toString().trim(), window: 1 });

  if (delta === null) {
    return res.status(401).json({ error: 'Gecersiz kod' });
  }

  req.session.authenticated = true;
  console.log(`[AUTH] Giris basarili: ${req.session.username}`);
  res.json({ ok: true, message: 'Giris basarili' });
});

/** GET /auth/logout — Oturum kapat */
app.get('/auth/logout', (req, res) => {
  const username = req.session ? req.session.username : 'bilinmeyen';
  req.session.destroy(() => {
    console.log(`[AUTH] Cikis: ${username}`);
    res.redirect('/login.html');
  });
});

/** GET /auth/me — Oturum bilgisi */
app.get('/auth/me', (req, res) => {
  if (!req.session || !req.session.authenticated) {
    return res.json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    username: req.session.username,
    role: req.session.role
  });
});

/** POST /auth/change-password — Kendi sifreni degistir */
app.post('/auth/change-password', requireAuthAPI, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Mevcut ve yeni sifre zorunlu' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Yeni sifre en az 6 karakter olmali' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Mevcut sifre hatali' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.session.userId);

  console.log(`[AUTH] Sifre degistirildi: ${req.session.username}`);
  res.json({ ok: true });
});

/* ============================================================================
 *                       ADMIN ENDPOINTLERI (Kullanici Yonetimi)
 * ============================================================================ */

/** GET /api/users — Kullanici listesi */
app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, username, role, totp_enabled, created_at FROM users ORDER BY id
  `).all();
  res.json(users);
});

/** POST /api/users — Yeni kullanici olustur */
app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanici adi ve sifre zorunlu' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Sifre en az 6 karakter olmali' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Bu kullanici adi zaten var' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const userRole = (role === 'admin') ? 'admin' : 'user';

  const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, hash, userRole);

  console.log(`[ADMIN] Yeni kullanici: ${username} (${userRole})`);
  res.json({ ok: true, id: info.lastInsertRowid });
});

/** PUT /api/users/:id — Kullanici guncelle (sifre degistir) */
app.put('/api/users/:id', requireAdmin, (req, res) => {
  const { password, role } = req.body;
  const userId = parseInt(req.params.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Kullanici bulunamadi' });

  if (password) {
    if (password.length < 6) {
      return res.status(400).json({ error: 'Sifre en az 6 karakter olmali' });
    }
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  }

  if (role && (role === 'admin' || role === 'user')) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  }

  console.log(`[ADMIN] Kullanici guncellendi: #${userId} ${user.username}`);
  res.json({ ok: true });
});

/** DELETE /api/users/:id — Kullanici sil */
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);

  /* Admin kendini silemez */
  if (userId === req.session.userId) {
    return res.status(400).json({ error: 'Kendinizi silemezsiniz' });
  }

  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Kullanici bulunamadi' });

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  console.log(`[ADMIN] Kullanici silindi: ${user.username}`);
  res.json({ ok: true });
});

/** POST /api/users/:id/reset-totp — TOTP sifirla */
app.post('/api/users/:id/reset-totp', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);

  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Kullanici bulunamadi' });

  db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(userId);
  console.log(`[ADMIN] TOTP sifirlandi: ${user.username}`);
  res.json({ ok: true });
});

/* ============================================================================
 *                       CIHAZ API ENDPOINTLERI (Acik — auth yok)
 * ============================================================================ */

/** POST /api/data — ESP32 kullanici telemetrisi */
app.post('/api/data', (req, res) => {
  try {
    const d = req.body;
    stmtInsert.run({
      device_id: d.device_id || 'unknown', uptime_ms: d.uptime_ms || 0,
      speed_kmh: d.speed_kmh || 0, spacing_cm: d.spacing_cm || 0,
      target_cm: d.target_cm || 0, confidence: d.confidence || 0,
      speed_source: d.speed_source || 0,
      motor_hz: d.motor_hz || 0, motor_target: d.motor_target || 0,
      motor_enabled: d.motor_enabled ? 1 : 0,
      seeds: d.seeds || 0, singulation: d.singulation || 0,
      miss: d.miss || 0, double_pct: d.double || 0,
      area_ha: d.area_ha || 0, distance_m: d.distance_m || 0,
      seeding_state: d.seeding_state || 0,
      lat: d.lat || 0, lon: d.lon || 0, satellites: d.satellites || 0,
      gps_valid: d.gps_valid ? 1 : 0, gps_speed: d.gps_speed || 0,
      heading: d.heading || 0,
      pitch: d.pitch || 0, roll_deg: d.roll || 0,
      vibration: d.vibration ? 1 : 0,
      seed_spacing_cv: d.seed_spacing_cv || 0, seed_active: d.seed_active ? 1 : 0,
      disk_rpm: d.disk_rpm || 0, disk_stability: d.disk_stability || 0,
      disk_connected: d.disk_connected ? 1 : 0,
      cpu_load: d.cpu_load || 0, alarm_count: d.alarm_count || 0,
      link: d.link ? 1 : 0, wifi_rssi: d.wifi_rssi || 0
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[HATA] Veri kayit:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/analytics — ESP32 sirket analitigi */
app.post('/api/analytics', (req, res) => {
  try {
    const d = req.body;
    stmtAnalytics.run({
      device_id: d.device_id || 'unknown', fw_version: d.fw_version || '',
      uptime_ms: d.uptime_ms || 0, boot_count: d.boot_count || 0,
      total_seeds: d.total_seeds || 0, area_ha: d.area_ha || 0,
      distance_m: d.distance_m || 0, seeding_state: d.seeding_state || 0,
      link_active: d.link_active ? 1 : 0, cpu_load: d.cpu_load || 0,
      alarm_count: d.alarm_count || 0, alarm_highest: d.alarm_highest || 0,
      free_heap: d.free_heap || 0,
      wifi_rssi: d.wifi_rssi || 0, wifi_ssid: d.wifi_ssid || '',
      tele_sent: d.tele_sent || 0, tele_fail: d.tele_fail || 0,
      tele_enabled: d.tele_enabled ? 1 : 0,
      lat: d.lat || 0, lon: d.lon || 0, gps_valid: d.gps_valid ? 1 : 0
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[HATA] Analitik kayit:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/firmware/check — ESP32 guncelleme kontrolu (acik) */
app.get('/api/firmware/check', (req, res) => {
  const deviceId = req.query.device_id;
  if (!deviceId) return res.json({ update: false });

  const assignment = db.prepare(`
    SELECT fa.id as assign_id, fa.firmware_id, f.target, f.version, f.size, f.checksum
    FROM firmware_assignments fa
    JOIN firmware f ON f.id = fa.firmware_id
    WHERE fa.device_id = ? AND fa.status = 'pending' AND f.active = 1
    ORDER BY fa.id DESC LIMIT 1
  `).get(deviceId);

  if (!assignment) return res.json({ update: false });
  res.json({
    update: true,
    assign_id: assignment.assign_id,
    firmware_id: assignment.firmware_id,
    target: assignment.target,
    version: assignment.version,
    size: assignment.size,
    checksum: assignment.checksum,
    url: `/api/firmware/download/${assignment.firmware_id}`
  });
});

/** GET /api/firmware/download/:id — Firmware indir (acik — cihaz icin) */
app.get('/api/firmware/download/:id', (req, res) => {
  const fw = db.prepare('SELECT * FROM firmware WHERE id = ?').get(req.params.id);
  if (!fw) return res.status(404).json({ error: 'Firmware bulunamadi' });
  if (!fs.existsSync(fw.filepath)) return res.status(404).json({ error: 'Dosya bulunamadi' });
  res.download(fw.filepath, fw.filename);
});

/** POST /api/firmware/status — Cihaz guncelleme durumu bildir (acik) */
app.post('/api/firmware/status', (req, res) => {
  try {
    const { assign_id, status, progress, error_msg } = req.body;
    if (!assign_id || !status) {
      return res.status(400).json({ error: 'assign_id ve status zorunlu' });
    }
    db.prepare(`
      UPDATE firmware_assignments
      SET status = ?, progress = ?, error_msg = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, progress || 0, error_msg || '', assign_id);

    console.log(`[OTA] Atama #${assign_id}: ${status} (%${progress || 0})`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/settings/public — Site adi gibi herkese acik ayarlar */
app.get('/api/settings/public', (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('site_name', 'site_subtitle')").all();
  const result = {};
  for (const r of rows) result[r.key] = r.value;
  res.json(result);
});

/** GET /api/settings — Tum ayarlar (admin) */
app.get('/api/settings', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const r of rows) result[r.key] = r.value;
  res.json(result);
});

/** PUT /api/settings — Ayar guncelle (admin) */
app.put('/api/settings', requireAdmin, (req, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'key ve value zorunlu' });
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value.toString().trim());
  console.log(`[ADMIN] Ayar guncellendi: ${key} = ${value}`);
  res.json({ ok: true });
});

/** GET /api/health — Sunucu saglik kontrolu (acik — Cloud Panel icin) */
app.get('/api/health', (req, res) => {
  const telCount = db.prepare('SELECT COUNT(*) as c FROM telemetry').get();
  const anaCount = db.prepare('SELECT COUNT(*) as c FROM analytics').get();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    telemetry_records: telCount.c,
    analytics_records: anaCount.c,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
  });
});

/* ============================================================================
 *                       KORUNAN API ENDPOINTLERI (Auth gerekli)
 * ============================================================================ */

app.get('/api/latest', requireAuthAPI, (req, res) => {
  const row = stmtLatest.get();
  if (!row) return res.json({ empty: true });
  res.json(row);
});

app.get('/api/history', requireAuthAPI, (req, res) => {
  const period = req.query.period || '-1 hour';
  const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
  if (!/^-\d+ (minute|hour|day|month)s?$/.test(period)) {
    return res.status(400).json({ error: 'Gecersiz period formati' });
  }
  const rows = stmtHistory.all(period, limit);
  res.json(rows);
});

app.get('/api/stats', requireAuthAPI, (req, res) => {
  const stats = db.prepare(`
    SELECT COUNT(*) as total_records, MAX(ts) as last_update,
      MAX(area_ha) as max_area, MAX(seeds) as max_seeds,
      AVG(speed_kmh) as avg_speed, AVG(spacing_cm) as avg_spacing,
      AVG(confidence) as avg_confidence, AVG(singulation) as avg_singulation,
      MIN(ts) as first_record
    FROM telemetry WHERE ts >= datetime('now', '-24 hours')
  `).get();
  res.json(stats);
});

app.get('/api/devices', requireAuthAPI, (req, res) => {
  const devices = db.prepare(`
    SELECT device_id, fw_version, MAX(ts) as last_seen,
      MAX(boot_count) as boot_count, MAX(uptime_ms) as last_uptime,
      MAX(total_seeds) as total_seeds, MAX(area_ha) as total_area,
      COUNT(*) as report_count
    FROM analytics GROUP BY device_id ORDER BY last_seen DESC
  `).all();
  res.json(devices);
});

app.get('/api/analytics/latest', requireAuthAPI, (req, res) => {
  const deviceId = req.query.device_id;
  let row;
  if (deviceId) {
    row = db.prepare('SELECT * FROM analytics WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(deviceId);
  } else {
    row = db.prepare('SELECT * FROM analytics ORDER BY id DESC LIMIT 1').get();
  }
  if (!row) return res.json({ empty: true });
  res.json(row);
});

app.get('/api/analytics/history', requireAuthAPI, (req, res) => {
  const deviceId = req.query.device_id;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  let rows;
  if (deviceId) {
    rows = db.prepare('SELECT * FROM analytics WHERE device_id = ? ORDER BY id DESC LIMIT ?').all(deviceId, limit);
  } else {
    rows = db.prepare('SELECT * FROM analytics ORDER BY id DESC LIMIT ?').all(limit);
  }
  res.json(rows);
});

app.get('/api/trail', requireAuthAPI, (req, res) => {
  const period = req.query.period || '-1 hour';
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  const deviceId = req.query.device_id;
  if (!/^-\d+ (minute|hour|day|month)s?$/.test(period)) {
    return res.status(400).json({ error: 'Gecersiz period formati' });
  }
  let rows;
  if (deviceId) {
    rows = db.prepare(`SELECT lat, lon, ts, speed_kmh FROM telemetry WHERE ts >= datetime('now', ?) AND device_id = ? AND gps_valid = 1 AND (lat != 0 OR lon != 0) ORDER BY ts ASC LIMIT ?`).all(period, deviceId, limit);
  } else {
    rows = db.prepare(`SELECT lat, lon, ts, speed_kmh FROM telemetry WHERE ts >= datetime('now', ?) AND gps_valid = 1 AND (lat != 0 OR lon != 0) ORDER BY ts ASC LIMIT ?`).all(period, limit);
  }
  res.json(rows);
});

app.get('/api/analytics/trail', requireAuthAPI, (req, res) => {
  const deviceId = req.query.device_id;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  let rows;
  if (deviceId) {
    rows = db.prepare(`SELECT lat, lon, ts FROM analytics WHERE device_id = ? AND gps_valid = 1 AND (lat != 0 OR lon != 0) ORDER BY ts ASC LIMIT ?`).all(deviceId, limit);
  } else {
    rows = db.prepare(`SELECT lat, lon, ts FROM analytics WHERE gps_valid = 1 AND (lat != 0 OR lon != 0) ORDER BY ts ASC LIMIT ?`).all(limit);
  }
  res.json(rows);
});

/* ============================================================================
 *                       ADMIN FIRMWARE ENDPOINTLERI
 * ============================================================================ */

app.post('/api/firmware/upload', requireAdmin, uploadMw.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Dosya eksik' });
    const { target, version, notes } = req.body;
    if (!target || !version) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'target ve version zorunlu' });
    }
    const buf = fs.readFileSync(req.file.path);
    const checksum = crypto.createHash('md5').update(buf).digest('hex');
    const info = db.prepare('INSERT INTO firmware (target, version, filename, filepath, size, checksum, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(target, version, req.file.originalname, req.file.path, req.file.size, checksum, notes || '');
    console.log(`[OTA] Firmware yuklendi: ${target} v${version} (${req.file.size} byte)`);
    res.json({ ok: true, id: info.lastInsertRowid, checksum });
  } catch (err) {
    console.error('[HATA] Firmware yukleme:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/firmware/list', requireAuthAPI, (req, res) => {
  const rows = db.prepare(`
    SELECT id, ts, target, version, filename, size, checksum, notes, active,
    (SELECT COUNT(*) FROM firmware_assignments WHERE firmware_id = firmware.id) as assign_count,
    (SELECT COUNT(*) FROM firmware_assignments WHERE firmware_id = firmware.id AND status = 'success') as success_count
    FROM firmware ORDER BY id DESC
  `).all();
  res.json(rows);
});

app.delete('/api/firmware/:id', requireAdmin, (req, res) => {
  try {
    const fw = db.prepare('SELECT * FROM firmware WHERE id = ?').get(req.params.id);
    if (!fw) return res.status(404).json({ error: 'Firmware bulunamadi' });
    if (fs.existsSync(fw.filepath)) fs.unlinkSync(fw.filepath);
    db.prepare('DELETE FROM firmware_assignments WHERE firmware_id = ?').run(fw.id);
    db.prepare('DELETE FROM firmware WHERE id = ?').run(fw.id);
    console.log(`[OTA] Firmware silindi: #${fw.id} ${fw.target} v${fw.version}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/firmware/assign', requireAdmin, (req, res) => {
  try {
    const { firmware_id, device_ids } = req.body;
    if (!firmware_id || !device_ids || !device_ids.length) {
      return res.status(400).json({ error: 'firmware_id ve device_ids zorunlu' });
    }
    const fw = db.prepare('SELECT * FROM firmware WHERE id = ?').get(firmware_id);
    if (!fw) return res.status(404).json({ error: 'Firmware bulunamadi' });
    const stmtAssign = db.prepare("INSERT INTO firmware_assignments (device_id, firmware_id, status) VALUES (?, ?, 'pending')");
    const cancelStmt = db.prepare("UPDATE firmware_assignments SET status = 'cancelled', updated_at = datetime('now') WHERE device_id = ? AND status = 'pending'");
    let count = 0;
    for (const did of device_ids) {
      cancelStmt.run(did);
      stmtAssign.run(did, firmware_id);
      count++;
    }
    console.log(`[OTA] Firmware #${firmware_id} → ${count} cihaza atandi`);
    res.json({ ok: true, assigned: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/firmware/assignments', requireAuthAPI, (req, res) => {
  const deviceId = req.query.device_id;
  let rows;
  if (deviceId) {
    rows = db.prepare(`SELECT fa.*, f.target, f.version, f.filename FROM firmware_assignments fa JOIN firmware f ON f.id = fa.firmware_id WHERE fa.device_id = ? ORDER BY fa.id DESC LIMIT 20`).all(deviceId);
  } else {
    rows = db.prepare(`SELECT fa.*, f.target, f.version, f.filename FROM firmware_assignments fa JOIN firmware f ON f.id = fa.firmware_id ORDER BY fa.id DESC LIMIT 50`).all();
  }
  res.json(rows);
});

/* ============================================================================
 *                           ESKI VERI TEMIZLEME
 * ============================================================================ */

setInterval(() => {
  try {
    const r1 = db.prepare("DELETE FROM telemetry WHERE ts < datetime('now', '-30 days')").run();
    if (r1.changes > 0) console.log(`[TEMIZLIK] ${r1.changes} eski telemetri kaydi silindi`);
    const r2 = db.prepare("DELETE FROM analytics WHERE ts < datetime('now', '-90 days')").run();
    if (r2.changes > 0) console.log(`[TEMIZLIK] ${r2.changes} eski analitik kaydi silindi`);
  } catch (err) {
    console.error('[HATA] Temizlik:', err.message);
  }
}, 3600 * 1000);

/* ============================================================================
 *                           SUNUCU BASLAT
 * ============================================================================ */

app.listen(PORT, '0.0.0.0', () => {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   PRIME MIBZER Telemetri Sunucusu v4.0    ║
  ╠═══════════════════════════════════════════╣
  ║   Port       : ${PORT}                        ║
  ║   Auth       : AKTIF (TOTP 2FA)           ║
  ║   Kullanici  : ${userCount} kayitli               ║
  ║   DB         : mibzer.db                  ║
  ╚═══════════════════════════════════════════╝
  `);
});
