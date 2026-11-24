<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · **Türkçe** · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md)

# REA: Her şeyi tersine mühendislikle inceleyin

### İkili dosyaların, uygulamaların ve çalışma zamanı davranışının tersine mühendisliği için tek bir MCP.

**Beğendiğiniz bir özellik mi gördünüz? İkili kod düzeyine kadar nasıl çalıştığını anlayın.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Web sitesi](https://rea.tools/tr/) · [Rehberler](https://rea.tools/tr/guides/) · [Örnek çalışmalar](https://rea.tools/tr/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Discord'da REA topluluğuna katılın" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Hızlı başlangıç](#hızlı-başlangıç) · [Örnek çalışmalar](#örnek-çalışmalar) · [REA nasıl çalışır](#rea-nasıl-çalışır) · [Neleri analiz edebilirsiniz](#neleri-analiz-edebilirsiniz) · [RL ortamları oluşturun](#build-rl-environments) · [Sık sorulan sorular](#sık-sorulan-sorular) · [Belgeler](#belgeler)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> REA’nın resmî kaynakları: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm).
> Kurulum ve sürüm bağlantılarını bu resmî kaynaklardan takip edin. Benzer bir depo adı veya kopyalanmış bir README, indirilen dosyanın resmî olduğunu kanıtlamaz.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA, yerel bir ikili dosyayı incelerken Hopper içinde analiz köprüsünü başlatıyor" width="1200" />

<br /><br />

<table aria-label="REA topluluğu">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Tersine mühendislik topluluğuna katılın</strong>
  </a><br />
  <sub>Discord · Soru-cevap · Sonuç paylaşımı</sub>
</td>
</tr>
</table>

<br />

</div>

---

Bir uygulamada kendi ürününüze eklemek istediğiniz bir özellik mi gördünüz? Ajanınızdan REA ile araştırmasını isteyin. Kaynak kodu olmadan uygulamayı inceleyebilir, özelliğin nasıl çalıştığını açıklayabilir, kanıtları gösterebilir ve projenize uygun bir sürümünü geliştirebilir.

REA, ajanınızı yerel makine kodu içeren ikili dosyaları, JavaScript ve Electron uygulamalarını, .NET derlemelerini ve web sitelerini inceleyen araçlara bağlar. Aynı araçları terminalden de kullanabilirsiniz. Analiz yerel olarak çalışır; sonuçlar her çıkarımın dayandığı kanıtları ve sınırlamaları içerir.

Kurulum, REA'yı ajanınıza kaydeder ve uyumlu iş akışı talimatlarını yükler. Yerel makine kodu analizi mevcut bir Hopper, Ghidra, IDA veya Kuna kurulumunu kullanabilir; kurulum işlemi, onayınızla isteğe bağlı olarak Hopper da yükleyebilir. Statik JavaScript analizi bu yerel analiz motorlarından hiçbirine ihtiyaç duymaz.

## Hızlı başlangıç

**[Hızlı başlangıç · rea.tools](https://rea.tools/tr/get-started/)**

### Ajanınızı yapılandırın (MCP)

[Node.js ve npm](../reference/supported-targets.md) kuruluysa bu komutu inceleyeceğiniz projenin dışında, güvendiğiniz bir dizinde çalıştırın.

```bash
npx rea-agents setup
```

Ajanlarınızı seçin, önerilen değişiklikleri inceleyin ve onaylayın. Kurulum, mevcut yapılandırmaları yedekleyerek REA'nın MCP sunucusunu ve uyumlu iş akışı talimatlarını ekler. Ardından ajanınızı yeniden başlatın.

[yükleme ve kurulum](../getting-started/installation.md)

Ajanınıza sorun:

```text
Notes uygulamasında aramanın nasıl çalıştığını araştır, kanıtları göster ve projem için benzer bir özellik geliştir.
```

Notes yerine hedef uygulamanızı ve anlamak istediğiniz özelliği belirtin.

### Terminali kullanın (CLI)

Çıkarılmış bir JavaScript/Electron uygulama dizinini veya ASAR dosyasını inceleyin:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Sonuç; modülleri, içe aktarmaları, Electron sınırlarını ve bunlara ilişkin kanıtları içerir. Yolu hedefinizle değiştirin; Windows'ta örneğin `"D:/apps/example"` kullanabilirsiniz.

Düzenli kullanım için `rea` komutunu yüklemek üzere:

```bash
npm install --global rea-agents
rea --help
```

Yerel makine kodu analizi için önce bir sağlayıcı yapılandırın. Yerel analiz komutları, sağlayıcı seçimi, anlık görüntüler ve betik kullanımı için [CLI ve Evidence rehberine](../getting-started/cli.md) bakın.

[Linux gereksinimleri](../getting-started/installation.md#linux-owned-process-prerequisite)

### REA'yı güncelleyin

`npm install --global` veya `bun add --global` ile yüklenen CLI için:

```bash
rea update
```

`npx` kullanıyorsanız ajan kurulumunu şu komutla güncelleyin:

```bash
npx rea-agents@latest setup
```

[Güncelleme ve kaldırma](../getting-started/installation.md#diagnose-update-and-remove)

## Örnek çalışmalar

<a href="https://rea.tools/tr/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="DX-Ball ses kaydırma, Notion pano köprüsü ve TH04 mermi halkası örneklerinin çizimleri" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: Sesin stereo konumlandırma hesabını yeniden oluşturma</h3>
<p>Bir ses çağrısından konumu stereo konumlandırmaya dönüştüren yardımcı fonksiyona ilerleyin, talimatları inceleyin ve eksik sözde kodu C'ye dönüştürün. Yeniden oluşturulan kod, özgün x86 üzerinde 3.205 test durumunu geçer ve derlenmiş fonksiyonun 63 baytının tamamını yeniden üretir.</p>
<p><a href="https://rea.tools/tr/showcase/dx-ball/">Örnek çalışmayı okuyun</a> · <a href="https://github.com/N0zoM1z0/dx-ball">Yeniden oluşturma deposu</a></p>
</td></tr>
<tr><td>
<h3>Notion: Electron pano köprüsünü izleme</h3>
<p>İşleyici sürecin pano API'sini bulun, preload ve IPC üzerinden ana sürece kadar izleyin ve zengin pano biçimini inceleyin.</p>
<p><a href="https://rea.tools/tr/showcase/notion/">Örnek çalışmayı okuyun</a></p>
</td></tr>
<tr><td>
<h3>TH04: DOS mermi halkası hesabını geri çıkarma</h3>
<p>Özgün PC-98 oyununun 16 bit talimatlarını inceleyin, sabit ve hedefe yönelik açı hesaplarını geri çıkarın ve yeniden oluşturulan C++ kodunu dönemin derleyici çıktısıyla karşılaştırın.</p>
<p><a href="https://rea.tools/tr/showcase/th04/">Örnek çalışmayı okuyun</a> · <a href="https://github.com/N0zoM1z0/th04">Yeniden oluşturma deposu</a></p>
</td></tr>
</tbody>
</table>

REA'yı ilginç bir konuda kullandıysanız görmek isteriz. Hedefi, sorunuzu, REA'nın nasıl yardımcı olduğunu ve bulgularınızı bir [issue](https://github.com/morluto/rea/issues) veya [pull request](https://github.com/morluto/rea/pulls) ile paylaşın.

## REA nasıl çalışır

Ajanınız, hedefi incelemek ve ilgili kodu izlemek için MCP üzerinden REA'yı çağırır. REA bulguları kanıtlarıyla birlikte döndürür. Ajan bunları takip soruları sormak, davranışı açıklamak veya bir uygulama yazıp test etmek için kullanır. CLI komutları aynı iş akışlarını kullanır.

![REA araştırma akışı: ajanınız yerel bir hedef hakkında soru sorar, REA analiz araçlarıyla hedefi inceler ve izler; ajan döndürülen kodu, referansları ve bilinmeyenleri açıklama, geliştirme ve test için kullanır.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Şekli tam boyutuyla açın](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Neleri analiz edebilirsiniz

Yerel makine kodu içeren ikili dosyalar · JavaScript / Electron · Web siteleri · .NET derlemeleri · Android APK'leri · Donanım yazılımı · Süreç davranışı

[Desteklenen biçimler ve gereksinimler](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[Analiz sağlayıcısı seçimi](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## RL ortamları oluşturun

Kaydedilmiş bir web oturumundan veya Linux masaüstü uygulamasından yerel bir ortam oluşturun. Ajan burada bir görevi deneyebilir ve sonucu kontrol edebilir.

[RL ortamları oluşturun](https://rea.tools/guides/rl-environments/)

## Sık sorulan sorular

<details>
<summary><strong>Hangi ajanlar REA'yı kullanabilir?</strong></summary>

Yerel MCP sunucularını destekleyen her ajan REA'yı kullanabilir. Kurulum, [desteklenen ajanları](../getting-started/installation.md#supported-agents) yapılandırır; diğer istemciler [elle MCP kaydını](../getting-started/installation.md#mcp-registry) kullanabilir.

</details>

<details>
<summary><strong>Hopper, Ghidra, IDA veya Kuna gerekiyor mu?</strong></summary>

Derin yerel kod analizi bunlardan birini kullanır. Statik JavaScript ve .NET incelemesi yerel analiz motoru olmadan çalışır. Kurulum onaydan sonra Hopper yükleyebilir; Ghidra, IDA ve Kuna mevcut kurulumlarınızı kullanır. [Sağlayıcı kurulumuna](../getting-started/installation.md#hopper) bakın.

</details>

<details>
<summary><strong>Önce Hopper'ı başlatmam gerekiyor mu?</strong></summary>

REA, bir işlem gerektirdiğinde Hopper'ı başlatır. macOS'ta ilk çalıştırmada demo modunu seçmenizi veya lisansınızı etkinleştirmenizi isteyen bir iletişim kutusu açılabilir. [Hopper başlatma ve sorun giderme](../getting-started/installation.md#launcher-paths-and-troubleshooting) belgesine bakın.

</details>

<details>
<summary><strong>skills.sh üzerinden skill yüklemek ne yapar?</strong></summary>

Skill, ajanınıza araştırma talimatları sağlar. REA'nın MCP sunucusunu kaydetmek ve uyumlu talimatları yüklemek için `npx rea-agents setup` kullanın, ardından ajanınızı yeniden başlatın. [Yalnızca skill yükleme](../getting-started/installation.md#skill-only-installation) belgesine bakın.

</details>

<details>
<summary><strong>REA hangi kodu döndürür?</strong></summary>

Yerel kod analizi sözde kod ve assembly kodu döndürür. JavaScript/Electron analizi modülleri ve aralarındaki ilişkileri geri çıkarır. Ajanınız bu bulgularla bir uygulama yazar ve test eder; [örnek çalışmalar](#örnek-çalışmalar) uygulamalı örnekler sunar.

</details>

<details>
<summary><strong>REA uygulamamı yükler mi?</strong></summary>

REA hedefleri yerel olarak analiz eder. Ajanınız araç sonuçlarını alır ve model sağlayıcısının kendi veri politikası vardır.

</details>

<details>
<summary><strong>Bir hatayla karşılaşırsam ne yapmalıyım?</strong></summary>

Önce güncelleyin; yakın tarihli bir sürüm hatayı düzeltmiş olabilir.

npm ile yüklenen CLI için:

```bash
rea update
```

`npx` üzerinden ajan kurulumu için:

```bash
npx rea-agents@latest setup
```

Ajan kullanıyorsanız [kurulum yenilemesini](#reayı-güncelleyin) tamamlayın ve ajanı yeniden başlatın. Aynı görevi tekrar deneyin. Sorun sürerse REA sürümünüzü, hedef türünü, yeniden üretme adımlarını ve hata çıktısını içeren bir [issue açın](https://github.com/morluto/rea/issues).

</details>

## Belgeler

Web sitesindeki [uygulamalı rehberlerden](https://rea.tools/tr/guides/) başlayın. Kesin seçenekler, ön koşullar ve sonuç sözleşmeleri için:

- [Yükleme ve kurulum](../getting-started/installation.md): ajan kaydı, sağlayıcı yapılandırması, güncellemeler ve kaldırma.
- [Hazırlık ve sorun giderme](../getting-started/installation.md#check-readiness-for-your-task): belirli bir ajanı veya analiz motorunu tanılama.
- [CLI ve Evidence](../getting-started/cli.md): komutlar, sağlayıcı seçimi, anlık görüntüler, içe/dışa aktarma ve çıkış durumları.
- [MCP sözleşmeleri](../reference/mcp-contracts.md) ve [ajan istemleri](../getting-started/mcp-prompts.md): araç sonuçları, oturumlar ve yönlendirmeli araştırmalar.
- [Araç kataloğu](../reference/mcp-contracts.md#generated-catalog): derleme sırasında oluşturulan araç, sağlayıcı ve CLI komutu envanteri.

Güvenlik açıklarını [SECURITY.md](../../SECURITY.md) üzerinden bildirin.

## Topluluk ve destek

- **Discord** — Sorularınızı sorun ve araştırmalarınızı tersine mühendisliğe ve yeni projeler geliştirmeye gönül vermiş 50.000’den fazla kişiyle paylaşın! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Duyurular için [@reatools](https://x.com/reatools) hesabını takip edin.
- **Geri bildirim ve öneriler** — Bir özellik veya dosya biçimi desteği mi istiyorsunuz? [GitHub](https://github.com/morluto/rea/issues) veya [Discord](https://discord.gg/GkcryMnJDM) üzerinden bize yazın.

## Yıldız geçmişi

🎉 **GitHub'da 400.000 yıldız — teşekkürler!**

REA'yı kullanan, hata bildiren, özellik talep eden, derlemeleri test eden ve düzeltmelere katkıda bulunan herkese teşekkürler.

<a href="https://rea.tools/tr/contributors/">
  <img src="../../website/public/contributors/avatars.png" alt="REA’ya katkıda bulunanlar" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA GitHub yıldız geçmişi" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Katkıda bulunma

REA'ya katkınızı bekliyoruz! Hata bildirmek veya özellik önermek için bir [issue açın](https://github.com/morluto/rea/issues); kodu veya belgeleri geliştirmek için bir [pull request gönderin](https://github.com/morluto/rea/pulls).

Geliştirme ortamı ve kontroller için [CONTRIBUTING.md](../../CONTRIBUTING.md), doğrulama süreçleri için [test rehberi](../development/testing.md) belgelerine bakın.

## Sorumluluk reddi

Sorumlu kullanım yönergeleri için [DISCLAIMER.md](../../DISCLAIMER.md) dosyasına bakın.

REA; yasal araştırma, eğitim, birlikte çalışabilirlik, yazılımın korunması ve sahibi olduğunuz ya da inceleme yetkiniz bulunan yazılımların analizi için tasarlanmıştır.

Projenin yasa dışı veya yetkisiz kullanıma ilişkin tutumu tüm REA sürümleri,
dağıtım kanalları ve platformlar için geçerlidir; her kopya geçerli lisanslarını
korur.

## Lisans

[MIT](../../LICENSE)

REA tarafından yazılan kod MIT lisansı altında lisanslanır. Üçüncü taraf
materyaller kendi lisanslarını ve telif hakkı bildirimlerini korur; bağımlılık
envanteri, korunan lisans metinleri ve harici araç koşulları için [Üçüncü taraf
bildirimleri](../../THIRD_PARTY_NOTICES.md) dosyasına bakın.

**IDA Pro / Hex-Rays decompiler'ları, Hopper ve JEB dahil olmak üzere ticari
araçları yasal olarak edinmeli ve ilgili lisanslar kapsamında kullanma
yetkiniz olmalıdır.** REA hiçbir araç lisansı, anahtarı veya etkinleştirme hakkı
vermez. Deneme sürümleri ve demolar; kullanıcı, özellik, otomasyon ve çıktı
paylaşımı kısıtlamaları dahil olmak üzere satıcı koşullarına tabidir. Kırılmış
kopyalar, çalınmış anahtarlar, yetkisiz anahtar paylaşımı ve lisans
kısıtlamalarını aşma yetkili kullanım kapsamında değildir. Bu yönlendirme MIT
veya üçüncü taraf lisanslarını değiştirmez.
