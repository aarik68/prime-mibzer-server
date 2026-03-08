/**
 * @file    server.js
 * @brief   Prime Mibzer — Hassas Ekim Telemetri Sunucusu
 * @version 3.0.0
 * @date    2026-03-08
 *
 * @details ESP32'den gelen sensor verilerini alir, SQLite'a kaydeder
 *          ve telefondan canli izleme dashboard'u sunar.
 *
 *          v2: Sirket analitik endpoint'i eklendi.
 *          v3: OTA firmware guncelleme yonetimi eklendi.
 *
 *          Endpointler:
 *            POST /api/data              — ESP32 kullanici telemetrisi
 *            POST /api/analytics         — ESP32 sirket analitigi (gizli)
 *            GET  /api/latest            — Son veri
 *            GET  /api/history           — Gecmis veri (sorgulu)
 *            GET  /api/stats             — Gunluk ozet istatistik
 *            GET  /api/devices           — Kayitli cihaz listesi
 *            GET  /api/health            — Sunucu saglik kontrolu
 *            POST /api/firmware/upload   — Firmware yukleme
 *            GET  /api/firmware/list     — Firmware listesi
 *            POST /api/firmware/assign   — Cihaza firmware ata
 *            GET  /api/firmware/check    — Cihaz guncelleme kontrolu
 *            GET  /api/firmware/download — Firmware indir
 *            POST /api/firmware/status   — Cihaz guncelleme durumu bildir
 *            GET  /                      — Dashboard (telefon)
 *
 *          Kurulum:
 *            npm install
 *            node server.js
 *
 *          Ortam degiskenleri:
 *            PORT      — HTTP port (varsayilan: 3000)
 *            API_KEY   — Yetkilendirme anahtari (opsiyonel)
 */

const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

/* ============================================================================
 *                           YAPILANDIRMA
 * ============================================================================ */

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';  /* Bos = herkes erisir */
const DB_PATH = path.join(__dirname, 'mibzer.db');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

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

/* WAL modu — yazma performansi icin */
db.pragma('journal_mode = WAL');

/* Ana veri tablosu — kullanici telemetrisi */
db.exec(`
  CREATE TABLE IF NOT EXISTS telemetry (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            DATETIME DEFAULT (datetime('now')),
    device_id     TEXT,
    uptime_ms     INTEGER,
    /* Hiz & aralik */
    speed_kmh     REAL,
    spacing_cm    REAL,
    target_cm     REAL,
    confidence    INTEGER,
    speed_source  INTEGER,
    /* Motor */
    motor_hz      REAL,
    motor_target  REAL,
    motor_enabled INTEGER,
    /* Ekim */
    seeds         INTEGER,
    singulation   INTEGER,
    miss          INTEGER,
    double_pct    INTEGER,
    area_ha       REAL,
    distance_m    REAL,
    seeding_state INTEGER,
    /* GPS */
    lat           REAL,
    lon           REAL,
    satellites    INTEGER,
    gps_valid     INTEGER,
    gps_speed     REAL,
    heading       REAL,
    /* IMU */
    pitch         REAL,
    roll_deg      REAL,
    vibration     INTEGER,
    /* Tohum sensoru */
    seed_spacing_cv REAL,
    seed_active     INTEGER,
    /* Disk sensoru */
    disk_rpm        REAL,
    disk_stability  REAL,
    disk_connected  INTEGER,
    /* Sistem */
    cpu_load      INTEGER,
    alarm_count   INTEGER,
    link          INTEGER,
    wifi_rssi     INTEGER
  )
`);

/* Sirket analitik tablosu — cihaz sagligi + konum */
db.exec(`
  CREATE TABLE IF NOT EXISTS analytics (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              DATETIME DEFAULT (datetime('now')),
    device_id       TEXT,
    fw_version      TEXT,
    uptime_ms       INTEGER,
    boot_count      INTEGER,
    /* Ekim ozet */
    total_seeds     INTEGER,
    area_ha         REAL,
    distance_m      REAL,
    seeding_state   INTEGER,
    /* Sistem sagligi */
    link_active     INTEGER,
    cpu_load        INTEGER,
    alarm_count     INTEGER,
    alarm_highest   INTEGER,
    free_heap       INTEGER,
    /* WiFi */
    wifi_rssi       INTEGER,
    wifi_ssid       TEXT,
    /* Telemetri durumu */
    tele_sent       INTEGER,
    tele_fail       INTEGER,
    tele_enabled    INTEGER,
    /* GPS konum */
    lat             REAL,
    lon             REAL,
    gps_valid       INTEGER
  )
`);

/* Firmware tablosu — yuklenen .bin dosyalari */
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

/* Firmware atama tablosu — hangi cihaza hangi firmware */
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

/* Indexler */
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_ts ON telemetry(ts);
  CREATE INDEX IF NOT EXISTS idx_device ON telemetry(device_id);
  CREATE INDEX IF NOT EXISTS idx_analytics_ts ON analytics(ts);
  CREATE INDEX IF NOT EXISTS idx_analytics_device ON analytics(device_id);
  CREATE INDEX IF NOT EXISTS idx_fw_assign_device ON firmware_assignments(device_id);
  CREATE INDEX IF NOT EXISTS idx_fw_assign_status ON firmware_assignments(status);
`);

/* Hazir sorgular (prepared statements — performans) */
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

/* Analitik insert */
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

const stmtLatest = db.prepare(`
  SELECT * FROM telemetry ORDER BY id DESC LIMIT 1
`);

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
app.use(express.static(path.join(__dirname, 'public')));

/* --- API key dogrulama middleware --- */
function authCheck(req, res, next) {
  if (!API_KEY) return next();  /* Key tanimli degil = acik erisim */

  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');

  if (token === API_KEY) return next();
  return res.status(401).json({ error: 'Yetkisiz erisim' });
}

/* ============================================================================
 *                           API ENDPOINTLERI
 * ============================================================================ */

/**
 * POST /api/data — ESP32 kullanici telemetrisi
 * Body: JSON sensor verisi
 */
app.post('/api/data', authCheck, (req, res) => {
  try {
    const d = req.body;

    stmtInsert.run({
      device_id:    d.device_id || 'unknown',
      uptime_ms:    d.uptime_ms || 0,
      speed_kmh:    d.speed_kmh || 0,
      spacing_cm:   d.spacing_cm || 0,
      target_cm:    d.target_cm || 0,
      confidence:   d.confidence || 0,
      speed_source: d.speed_source || 0,
      motor_hz:     d.motor_hz || 0,
      motor_target: d.motor_target || 0,
      motor_enabled: d.motor_enabled ? 1 : 0,
      seeds:        d.seeds || 0,
      singulation:  d.singulation || 0,
      miss:         d.miss || 0,
      double_pct:   d.double || 0,
      area_ha:      d.area_ha || 0,
      distance_m:   d.distance_m || 0,
      seeding_state: d.seeding_state || 0,
      lat:          d.lat || 0,
      lon:          d.lon || 0,
      satellites:   d.satellites || 0,
      gps_valid:    d.gps_valid ? 1 : 0,
      gps_speed:    d.gps_speed || 0,
      heading:      d.heading || 0,
      pitch:        d.pitch || 0,
      roll_deg:     d.roll || 0,
      vibration:    d.vibration ? 1 : 0,
      seed_spacing_cv: d.seed_spacing_cv || 0,
      seed_active:  d.seed_active ? 1 : 0,
      disk_rpm:     d.disk_rpm || 0,
      disk_stability: d.disk_stability || 0,
      disk_connected: d.disk_connected ? 1 : 0,
      cpu_load:     d.cpu_load || 0,
      alarm_count:  d.alarm_count || 0,
      link:         d.link ? 1 : 0,
      wifi_rssi:    d.wifi_rssi || 0
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[HATA] Veri kayit:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/analytics — ESP32 sirket analitigi (gizli, kullanicidan bagimsiz)
 * Body: JSON cihaz sagligi + konum verisi
 */
app.post('/api/analytics', (req, res) => {
  try {
    const d = req.body;

    stmtAnalytics.run({
      device_id:     d.device_id || 'unknown',
      fw_version:    d.fw_version || '',
      uptime_ms:     d.uptime_ms || 0,
      boot_count:    d.boot_count || 0,
      total_seeds:   d.total_seeds || 0,
      area_ha:       d.area_ha || 0,
      distance_m:    d.distance_m || 0,
      seeding_state: d.seeding_state || 0,
      link_active:   d.link_active ? 1 : 0,
      cpu_load:      d.cpu_load || 0,
      alarm_count:   d.alarm_count || 0,
      alarm_highest: d.alarm_highest || 0,
      free_heap:     d.free_heap || 0,
      wifi_rssi:     d.wifi_rssi || 0,
      wifi_ssid:     d.wifi_ssid || '',
      tele_sent:     d.tele_sent || 0,
      tele_fail:     d.tele_fail || 0,
      tele_enabled:  d.tele_enabled ? 1 : 0,
      lat:           d.lat || 0,
      lon:           d.lon || 0,
      gps_valid:     d.gps_valid ? 1 : 0
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[HATA] Analitik kayit:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/latest — Son veri
 */
app.get('/api/latest', (req, res) => {
  const row = stmtLatest.get();
  if (!row) return res.json({ empty: true });
  res.json(row);
});

/**
 * GET /api/history?period=-1 hour&limit=100
 * period: SQLite datetime modifier (varsayilan: -1 hour)
 * limit: Maksimum kayit (varsayilan: 500)
 */
app.get('/api/history', (req, res) => {
  const period = req.query.period || '-1 hour';
  const limit = Math.min(parseInt(req.query.limit) || 500, 5000);

  /* Guvenlik: sadece izin verilen formatlar */
  if (!/^-\d+ (minute|hour|day|month)s?$/.test(period)) {
    return res.status(400).json({ error: 'Gecersiz period formati' });
  }

  const rows = stmtHistory.all(period, limit);
  res.json(rows);
});

/**
 * GET /api/stats — Gunluk ozet istatistik
 */
app.get('/api/stats', (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_records,
      MAX(ts) as last_update,
      MAX(area_ha) as max_area,
      MAX(seeds) as max_seeds,
      AVG(speed_kmh) as avg_speed,
      AVG(spacing_cm) as avg_spacing,
      AVG(confidence) as avg_confidence,
      AVG(singulation) as avg_singulation,
      MIN(ts) as first_record
    FROM telemetry
    WHERE ts >= datetime('now', '-24 hours')
  `).get();

  res.json(stats);
});

/**
 * GET /api/devices — Kayitli cihaz listesi (analitikten)
 */
app.get('/api/devices', (req, res) => {
  const devices = db.prepare(`
    SELECT
      device_id,
      fw_version,
      MAX(ts) as last_seen,
      MAX(boot_count) as boot_count,
      MAX(uptime_ms) as last_uptime,
      MAX(total_seeds) as total_seeds,
      MAX(area_ha) as total_area,
      COUNT(*) as report_count
    FROM analytics
    GROUP BY device_id
    ORDER BY last_seen DESC
  `).all();

  res.json(devices);
});

/**
 * GET /api/analytics/latest?device_id=PM-XXYYZZ — Cihaz son analitik
 */
app.get('/api/analytics/latest', (req, res) => {
  const deviceId = req.query.device_id;
  let row;
  if (deviceId) {
    row = db.prepare(`
      SELECT * FROM analytics WHERE device_id = ? ORDER BY id DESC LIMIT 1
    `).get(deviceId);
  } else {
    row = db.prepare(`
      SELECT * FROM analytics ORDER BY id DESC LIMIT 1
    `).get();
  }
  if (!row) return res.json({ empty: true });
  res.json(row);
});

/**
 * GET /api/analytics/history?device_id=PM-XXYYZZ&limit=20 — Analitik gecmis
 */
app.get('/api/analytics/history', (req, res) => {
  const deviceId = req.query.device_id;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);

  let rows;
  if (deviceId) {
    rows = db.prepare(`
      SELECT * FROM analytics WHERE device_id = ? ORDER BY id DESC LIMIT ?
    `).all(deviceId, limit);
  } else {
    rows = db.prepare(`
      SELECT * FROM analytics ORDER BY id DESC LIMIT ?
    `).all(limit);
  }

  res.json(rows);
});

/**
 * GET /api/trail?period=-1 hour&limit=500 — GPS guzergah (hafif, sadece konum)
 * Telemetri verisinden lat/lon/ts/speed cekilir
 */
app.get('/api/trail', (req, res) => {
  const period = req.query.period || '-1 hour';
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  const deviceId = req.query.device_id;

  if (!/^-\d+ (minute|hour|day|month)s?$/.test(period)) {
    return res.status(400).json({ error: 'Gecersiz period formati' });
  }

  let rows;
  if (deviceId) {
    rows = db.prepare(`
      SELECT lat, lon, ts, speed_kmh FROM telemetry
      WHERE ts >= datetime('now', ?) AND device_id = ? AND gps_valid = 1 AND (lat != 0 OR lon != 0)
      ORDER BY ts ASC LIMIT ?
    `).all(period, deviceId, limit);
  } else {
    rows = db.prepare(`
      SELECT lat, lon, ts, speed_kmh FROM telemetry
      WHERE ts >= datetime('now', ?) AND gps_valid = 1 AND (lat != 0 OR lon != 0)
      ORDER BY ts ASC LIMIT ?
    `).all(period, limit);
  }

  res.json(rows);
});

/**
 * GET /api/analytics/trail?device_id=PM-XXYYZZ&limit=100 — Analitik GPS izi
 */
app.get('/api/analytics/trail', (req, res) => {
  const deviceId = req.query.device_id;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);

  let rows;
  if (deviceId) {
    rows = db.prepare(`
      SELECT lat, lon, ts FROM analytics
      WHERE device_id = ? AND gps_valid = 1 AND (lat != 0 OR lon != 0)
      ORDER BY ts ASC LIMIT ?
    `).all(deviceId, limit);
  } else {
    rows = db.prepare(`
      SELECT lat, lon, ts FROM analytics
      WHERE gps_valid = 1 AND (lat != 0 OR lon != 0)
      ORDER BY ts ASC LIMIT ?
    `).all(limit);
  }

  res.json(rows);
});

/* ============================================================================
 *                       FIRMWARE / OTA ENDPOINTLERI
 * ============================================================================ */

/**
 * POST /api/firmware/upload — Firmware .bin dosyasi yukle
 * Multipart form: target (esp32|stm32_m7|stm32_m4), version, notes, file
 */
app.post('/api/firmware/upload', uploadMw.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Dosya eksik' });

    const { target, version, notes } = req.body;
    if (!target || !version) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'target ve version zorunlu' });
    }

    /* MD5 checksum hesapla */
    const buf = fs.readFileSync(req.file.path);
    const checksum = crypto.createHash('md5').update(buf).digest('hex');

    const info = db.prepare(`
      INSERT INTO firmware (target, version, filename, filepath, size, checksum, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(target, version, req.file.originalname, req.file.path, req.file.size, checksum, notes || '');

    console.log(`[OTA] Firmware yuklendi: ${target} v${version} (${req.file.size} byte)`);
    res.json({ ok: true, id: info.lastInsertRowid, checksum });
  } catch (err) {
    console.error('[HATA] Firmware yukleme:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/firmware/list — Tum firmware listesi
 */
app.get('/api/firmware/list', (req, res) => {
  const rows = db.prepare(`
    SELECT id, ts, target, version, filename, size, checksum, notes, active,
    (SELECT COUNT(*) FROM firmware_assignments WHERE firmware_id = firmware.id) as assign_count,
    (SELECT COUNT(*) FROM firmware_assignments WHERE firmware_id = firmware.id AND status = 'success') as success_count
    FROM firmware ORDER BY id DESC
  `).all();
  res.json(rows);
});

/**
 * DELETE /api/firmware/:id — Firmware sil
 */
app.delete('/api/firmware/:id', (req, res) => {
  try {
    const fw = db.prepare('SELECT * FROM firmware WHERE id = ?').get(req.params.id);
    if (!fw) return res.status(404).json({ error: 'Firmware bulunamadi' });

    /* Dosyayi diskten sil */
    if (fs.existsSync(fw.filepath)) fs.unlinkSync(fw.filepath);

    /* Atamalari sil */
    db.prepare('DELETE FROM firmware_assignments WHERE firmware_id = ?').run(fw.id);
    db.prepare('DELETE FROM firmware WHERE id = ?').run(fw.id);

    console.log(`[OTA] Firmware silindi: #${fw.id} ${fw.target} v${fw.version}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/firmware/assign — Cihaza firmware ata
 * Body: { firmware_id, device_ids: ["PM-XXYYZZ", ...] }
 */
app.post('/api/firmware/assign', (req, res) => {
  try {
    const { firmware_id, device_ids } = req.body;
    if (!firmware_id || !device_ids || !device_ids.length) {
      return res.status(400).json({ error: 'firmware_id ve device_ids zorunlu' });
    }

    const fw = db.prepare('SELECT * FROM firmware WHERE id = ?').get(firmware_id);
    if (!fw) return res.status(404).json({ error: 'Firmware bulunamadi' });

    const stmt = db.prepare(`
      INSERT INTO firmware_assignments (device_id, firmware_id, status)
      VALUES (?, ?, 'pending')
    `);

    /* Onceki pending atamalari iptal et */
    const cancelStmt = db.prepare(`
      UPDATE firmware_assignments SET status = 'cancelled', updated_at = datetime('now')
      WHERE device_id = ? AND status = 'pending'
    `);

    let count = 0;
    for (const did of device_ids) {
      cancelStmt.run(did);
      stmt.run(did, firmware_id);
      count++;
    }

    console.log(`[OTA] Firmware #${firmware_id} → ${count} cihaza atandi`);
    res.json({ ok: true, assigned: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/firmware/check?device_id=PM-XXYYZZ — Cihaz guncelleme kontrolu
 * ESP32 periyodik olarak cagirir. Pending atama varsa firmware bilgisi doner.
 */
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

/**
 * GET /api/firmware/download/:id — Firmware .bin dosyasi indir
 */
app.get('/api/firmware/download/:id', (req, res) => {
  const fw = db.prepare('SELECT * FROM firmware WHERE id = ?').get(req.params.id);
  if (!fw) return res.status(404).json({ error: 'Firmware bulunamadi' });
  if (!fs.existsSync(fw.filepath)) return res.status(404).json({ error: 'Dosya bulunamadi' });

  res.download(fw.filepath, fw.filename);
});

/**
 * POST /api/firmware/status — Cihaz guncelleme durumu bildir
 * Body: { assign_id, status: 'downloading'|'flashing'|'success'|'failed', progress: 0-100, error_msg }
 */
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

/**
 * GET /api/firmware/assignments — Tum atamalar (durumlu)
 */
app.get('/api/firmware/assignments', (req, res) => {
  const deviceId = req.query.device_id;
  let rows;
  if (deviceId) {
    rows = db.prepare(`
      SELECT fa.*, f.target, f.version, f.filename
      FROM firmware_assignments fa
      JOIN firmware f ON f.id = fa.firmware_id
      WHERE fa.device_id = ?
      ORDER BY fa.id DESC LIMIT 20
    `).all(deviceId);
  } else {
    rows = db.prepare(`
      SELECT fa.*, f.target, f.version, f.filename
      FROM firmware_assignments fa
      JOIN firmware f ON f.id = fa.firmware_id
      ORDER BY fa.id DESC LIMIT 50
    `).all();
  }
  res.json(rows);
});

/**
 * GET /api/health — Sunucu saglik kontrolu
 */
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
 *                           ESKI VERI TEMIZLEME
 * ============================================================================ */

/* Her saat 30 gunden eski telemetri + 90 gunden eski analitik sil */
setInterval(() => {
  try {
    const r1 = db.prepare(`
      DELETE FROM telemetry WHERE ts < datetime('now', '-30 days')
    `).run();
    if (r1.changes > 0) {
      console.log(`[TEMIZLIK] ${r1.changes} eski telemetri kaydi silindi`);
    }

    const r2 = db.prepare(`
      DELETE FROM analytics WHERE ts < datetime('now', '-90 days')
    `).run();
    if (r2.changes > 0) {
      console.log(`[TEMIZLIK] ${r2.changes} eski analitik kaydi silindi`);
    }
  } catch (err) {
    console.error('[HATA] Temizlik:', err.message);
  }
}, 3600 * 1000);

/* ============================================================================
 *                           SUNUCU BASLAT
 * ============================================================================ */

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   PRIME MIBZER Telemetri Sunucusu v3.0    ║
  ╠═══════════════════════════════════════════╣
  ║   Port    : ${PORT}                          ║
  ║   API Key : ${API_KEY ? 'AKTIF' : 'YOK (acik erisim)'}               ║
  ║   DB      : ${DB_PATH}  ║
  ╚═══════════════════════════════════════════╝
  `);
});
