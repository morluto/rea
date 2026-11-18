# Lila Automation - Kişisel Okul Otomasyonu

## Amaç

Yetkili dosya dışa aktarmalarıyla öğrenci verisini yerel olarak içe aktaran,
sınıf/ders ilişkilerini yöneten ve yoklama kaydı tutan küçük bir uygulama
oluşturmak.

## Yetki sınırı

- MEBBİS'e erişim için resmi API veya kullanıcı tarafından yetkili dışa aktarma
  dosyası desteği gerekir.
- Kimlik bilgisi saklama, oturum açma, CAPTCHA aşımı, erişim kontrolü atlatma
  veya tarayıcı otomasyonu yapılmaz.
- İlk sürüm yalnızca CSV dosyası gibi kullanıcıdan gelen yerel verileri kabul eder.

## Temel iş akışları

1. CSV dosyası önizleme ve sütun eşleme.
2. Öğrenci kaydı oluşturma veya mevcut kayıtla eşleşme.
3. Sınıf ve ders oluşturma.
4. Öğrencileri sınıfa atama.
5. Ders oturumu açma.
6. Yoklama durumlarını kaydetme ve düzeltme.
7. İçe aktarma ve audit kayıtlarını görüntüleme.
