# Prime Mibzer — Telemetri Sunucu Kurulumu

## 1. VPS Kirala

Onerilen: **Hetzner Cloud** (hetzner.com/cloud)
- CX22: 2 vCPU, 4 GB RAM, 40 GB disk — €3.79/ay
- Konum: Nuremberg veya Helsinki
- OS: **Ubuntu 24.04**

## 2. Sunucuya Baglan

```bash
ssh root@SUNUCU_IP_ADRESI
```

## 3. Node.js Kur

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node --version  # v22.x
```

## 4. Proje Dosyalarini Yukle

Bilgisayarindan sunucuya kopyala:
```bash
# Bilgisayarindan calistir:
scp -r server/ root@SUNUCU_IP:/opt/mibzer/
```

Veya sunucuda Git ile:
```bash
mkdir -p /opt/mibzer
cd /opt/mibzer
# server.js, package.json, public/ dosyalarini buraya koy
```

## 5. Bagimliliklari Kur

```bash
cd /opt/mibzer
npm install
```

## 6. Ortam Degiskenleri (Opsiyonel)

```bash
# API key belirle (ESP32'de ayni key girilmeli)
export API_KEY="gizli_anahtar_123"

# Port degistir (varsayilan: 3000)
export PORT=3000
```

## 7. Test Et

```bash
node server.js
```

Tarayicidan ac: `http://SUNUCU_IP:3000`

## 8. Surekli Calisma (systemd)

```bash
cat > /etc/systemd/system/mibzer.service << 'EOF'
[Unit]
Description=Prime Mibzer Telemetri Sunucusu
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/mibzer
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=3000
Environment=API_KEY=

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mibzer
systemctl start mibzer
systemctl status mibzer
```

## 9. Firewall

```bash
# 3000 portunu ac
ufw allow 3000/tcp
ufw allow 22/tcp
ufw enable
```

## 10. ESP32 Yapilandirma

Telefondan ESP32'ye baglan → `http://192.168.4.1` → TELEMETRI bolumu:

| Alan | Deger |
|------|-------|
| Sunucu URL | `http://SUNUCU_IP:3000/api/data` |
| API Key | (ayarladiysan yaz, yoksa bos birak) |
| Aralik | 10 (saniye) |
| Aktif | ✓ |

**Kaydet** ve **Test Gonder** butonuna bas.

## 11. Telefondan Izleme

Tarayicidan ac: `http://SUNUCU_IP:3000`

- Canli sensor verileri (2 sn guncelleme)
- Ekim performansi (tekli/bosluk/cift oranlari)
- GPS konumu
- Sensor detaylari (IMU, disk, tohum)
- Grafik (hiz, aralik, tekli — son 1 saat)

## Notlar

- Veriler 30 gun saklanir, otomatik temizlenir
- SQLite veritabani: `/opt/mibzer/mibzer.db`
- Loglar: `journalctl -u mibzer -f`
- Yeniden baslat: `systemctl restart mibzer`
