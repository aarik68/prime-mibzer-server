/**
 * @file    server.js
 * @brief   Prime Mibzer — Hassas Ekim Telemetri Sunucusu
 * @version 1.0.0
 * @date    2026-03-08
 *
 * @details ESP32'den gelen sensor verilerini alir, SQLite'a kaydeder
 *          ve telefondan canli izleme dashboard'u sunar.
 *
 *          Endpointler:
 *            POST /api/data         — ESP32 veri gonderir
 *            GET  /api/latest       — Son veri
 *            GET  /api/history      — Gecmis veri (sorgulu)
 *            GET  /api/stats        — Gunluk ozet istatistik
 *            GET  /                 — Dashboard (telefon)
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

/* ============================================================================
 *                           YAPILANDIRMA
 * ============================================================================ */

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';  /* Bos = herkes erisir */
const DB_PATH = path.join(__dirname, 'mibzer.db');

/* ============================================================================
 *                           VERITABANI
 * ============================================================================ */

const db = new Database(DB_PATH);

/* WAL modu — yazma performansi icin */
db.pragma('journal_mode = WAL');

/* Ana veri tablosu */
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

/* Index: zaman bazli sorgular icin */
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_ts ON telemetry(ts);
  CREATE INDEX IF NOT EXISTS idx_device ON telemetry(device_id);
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
 * POST /api/data — ESP32 veri gonderir
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
 * GET /api/health — Sunucu saglik kontrolu
 */
app.get('/api/health', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM telemetry').get();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    records: count.c,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
  });
});

/* ============================================================================
 *                           ESKI VERI TEMIZLEME
 * ============================================================================ */

/* Her saat 30 gunden eski verileri sil */
setInterval(() => {
  try {
    const result = db.prepare(`
      DELETE FROM telemetry WHERE ts < datetime('now', '-30 days')
    `).run();
    if (result.changes > 0) {
      console.log(`[TEMIZLIK] ${result.changes} eski kayit silindi`);
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
  ║   PRIME MIBZER Telemetri Sunucusu v1.0    ║
  ╠═══════════════════════════════════════════╣
  ║   Port    : ${PORT}                          ║
  ║   API Key : ${API_KEY ? 'AKTIF' : 'YOK (acik erisim)'}               ║
  ║   DB      : ${DB_PATH}  ║
  ╚═══════════════════════════════════════════╝
  `);
});
