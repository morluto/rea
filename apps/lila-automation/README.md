# Lila otomasyon uygulaması

Yerel-first öğrenci içe aktarma, sınıf/ders eşleme ve yoklama kayıt uygulaması.

## Çalıştırma

```powershell
cd apps/lila-automation
node server.js
```

Tarayıcıdan `http://127.0.0.1:4173` adresini açın.

## Test

```powershell
npm test
```

Veri varsayılan olarak uygulama klasöründeki `lila.sqlite` dosyasına yazılır.
Farklı bir dosya için `LILA_DB` ortam değişkeni kullanılabilir.

## Kullanım sınırı

Bu sürüm yalnızca kullanıcı tarafından seçilen CSV dosyalarını kabul eder.
MEBBİS resmi API'sı veya yetkili dışa aktarma biçimi ayrı olarak doğrulanmadan
oturum açma, CAPTCHA aşımı veya otomatik erişim eklenmez.
