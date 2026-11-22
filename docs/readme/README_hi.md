<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md) · **हिन्दी**

# REA: Reverse Engineer Anything

### बाइनरी, एप्लिकेशन और रनटाइम व्यवहार की रिवर्स इंजीनियरिंग के लिए एक MCP।

**कोई फ़ीचर पसंद आया? समझिए कि वह कैसे काम करता है, बाइनरी स्तर तक।**

[![GitHub स्टार](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![मासिक npm डाउनलोड](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT लाइसेंस](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Discord पर REA से जुड़ें](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![X पर REA को फ़ॉलो करें](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![समर्थित प्लेटफ़ॉर्म: macOS, Windows और Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[वेबसाइट](https://rea.tools/) · [गाइड](https://rea.tools/guides/) · [उदाहरण](https://rea.tools/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Discord पर REA समुदाय से जुड़ें" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[त्वरित शुरुआत](#त्वरित-शुरुआत) · [उदाहरण](#उदाहरण) · [REA कैसे काम करता है](#rea-कैसे-काम-करता-है) · [आप क्या विश्लेषण कर सकते हैं](#आप-क्या-विश्लेषण-कर-सकते-हैं) · [RL एनवायरनमेंट बनाएँ](#build-rl-environments) · [अक्सर पूछे जाने वाले प्रश्न](#अक्सर-पूछे-जाने-वाले-प्रश्न) · [दस्तावेज़](#दस्तावेज़)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> REA के आधिकारिक स्रोत: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm)।
> इंस्टॉलेशन और रिलीज़ के लिंक इन्हीं आधिकारिक स्रोतों से लें। मिलते-जुलते रिपॉज़िटरी नाम या कॉपी किए गए README से यह सिद्ध नहीं होता कि कोई डाउनलोड आधिकारिक है।

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="नेटिव बाइनरी की जाँच करते समय Hopper के भीतर अपना विश्लेषण ब्रिज चलाता हुआ REA" width="1200" />

<br /><br />

<table aria-label="REA समुदाय">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>रिवर्स इंजीनियरिंग समुदाय से जुड़ें</strong>
  </a><br />
  <sub>Discord · प्रश्नोत्तर · अपना काम दिखाएँ</sub>
</td>
</tr>
</table>

<br />

</div>

---

किसी ऐप में कोई फ़ीचर दिखा जो आप अपने प्रोडक्ट में चाहते हैं? अपने एजेंट से कहें कि वह REA की मदद से उसकी जाँच करे। एजेंट सोर्स कोड के बिना ऐप की जाँच कर सकता है, समझा सकता है कि फ़ीचर कैसे काम करता है, साक्ष्य दिखा सकता है और आपके प्रोजेक्ट के लिए उसका अपना संस्करण बना सकता है।

REA आपके एजेंट को नेटिव बाइनरी, JavaScript और Electron ऐप, .NET असेंबली और वेबसाइटों की जाँच करने वाले टूल से जोड़ता है। इन्हीं टूल का उपयोग आप अपने टर्मिनल से भी कर सकते हैं। विश्लेषण स्थानीय रूप से चलता है, और परिणामों में हर निष्कर्ष के पीछे के साक्ष्य और सीमाएँ शामिल होती हैं।

सेटअप REA को आपके एजेंट में रजिस्टर करता है और उससे मेल खाते वर्कफ़्लो निर्देश इंस्टॉल करता है। नेटिव विश्लेषण पहले से इंस्टॉल Hopper, Ghidra, IDA या Kuna का उपयोग कर सकता है; आपकी स्वीकृति मिलने पर सेटअप Hopper इंस्टॉल कर सकता है। स्टैटिक JavaScript विश्लेषण के लिए किसी नेटिव विश्लेषण इंजन की ज़रूरत नहीं होती।

## त्वरित शुरुआत

**[त्वरित शुरुआत · rea.tools](https://rea.tools/get-started/)**

### अपना एजेंट सेट अप करें (MCP)

[Node.js और npm](../reference/supported-targets.md) इंस्टॉल होने पर, यह कमांड उस प्रोजेक्ट के बाहर किसी भरोसेमंद डायरेक्टरी से चलाएँ जिसका आप विश्लेषण करने वाले हैं।

```bash
npx rea-agents setup
```

अपने एजेंट चुनें, प्रस्तावित बदलावों की समीक्षा करें और उन्हें स्वीकृत करें। सेटअप REA का MCP सर्वर और उससे मेल खाते वर्कफ़्लो निर्देश जोड़ता है, और मौजूदा कॉन्फ़िगरेशन का बैकअप रखता है। इसके बाद अपने एजेंट को रीस्टार्ट करें।

[इंस्टॉलेशन और सेटअप](../getting-started/installation.md)

अपने एजेंट से पूछें:

```text
पता लगाएँ कि Notes ऐप में सर्च कैसे काम करता है, मुझे साक्ष्य दिखाएँ और मेरे प्रोजेक्ट के लिए वैसा ही फ़ीचर बनाएँ।
```

Notes की जगह अपना लक्ष्य ऐप और वह फ़ीचर लिखें जिसे आप समझना चाहते हैं।

### टर्मिनल का उपयोग करें (CLI)

निकाली गई (extracted) JavaScript/Electron ऐप डायरेक्टरी या ASAR फ़ाइल की जाँच करें:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

परिणाम में मॉड्यूल, इम्पोर्ट, Electron बाउंड्री और उनके साक्ष्य शामिल होते हैं। पाथ की जगह अपना लक्ष्य दें, जैसे Windows पर `"D:/apps/example"`।

नियमित उपयोग के लिए `rea` कमांड इंस्टॉल करने हेतु:

```bash
npm install --global rea-agents
rea --help
```

नेटिव विश्लेषण के लिए पहले कोई प्रोवाइडर कॉन्फ़िगर करें। नेटिव कमांड, प्रोवाइडर चयन, स्नैपशॉट और स्क्रिप्टिंग के लिए [CLI और Evidence गाइड](../getting-started/cli.md) देखें।

[Linux की पूर्व-आवश्यकताएँ](../getting-started/installation.md#linux-owned-process-prerequisite)

### REA अपडेट करें

`npm install --global` / `bun add --global` से इंस्टॉल किए गए CLI के लिए:

```bash
rea update
```

यदि आप `npx` का उपयोग करते हैं, तो अपने एजेंट का सेटअप इससे अपडेट करें:

```bash
npx rea-agents@latest setup
```

[अपडेट और अनइंस्टॉल](../getting-started/installation.md#diagnose-update-and-remove)

## उदाहरण

<a href="https://rea.tools/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="DX-Ball साउंड-पैन, Notion क्लिपबोर्ड ब्रिज और TH04 बुलेट-रिंग उदाहरणों के चित्र" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: साउंड-पैन की गणना का पुनर्निर्माण</h3>
<p>किसी साउंड कॉल को उसके position-to-pan हेल्पर तक फ़ॉलो करें, इंस्ट्रक्शन की जाँच करें और अधूरे स्यूडोकोड को C में बदलें। यह पुनर्निर्माण मूल x86 के 3,205 टेस्ट केस पास करता है और कंपाइल किए गए फ़ंक्शन के सभी 63 बाइट हूबहू दोबारा बनाता है।</p>
<p><a href="https://rea.tools/showcase/dx-ball/">केस स्टडी पढ़ें</a> · <a href="https://github.com/N0zoM1z0/dx-ball">पुनर्निर्माण की रिपॉज़िटरी</a></p>
</td></tr>
<tr><td>
<h3>Notion: Electron क्लिपबोर्ड ब्रिज को ट्रेस करना</h3>
<p>रेंडरर का क्लिपबोर्ड API खोजें, preload और IPC से होते हुए उसे मुख्य प्रोसेस तक फ़ॉलो करें और रिच क्लिपबोर्ड फ़ॉर्मैट की जाँच करें।</p>
<p><a href="https://rea.tools/showcase/notion/">केस स्टडी पढ़ें</a></p>
</td></tr>
<tr><td>
<h3>TH04: DOS बुलेट-रिंग की गणना को फिर से प्राप्त करना</h3>
<p>मूल PC-98 गेम के 16-बिट इंस्ट्रक्शन की जाँच करें, स्थिर और निशाना साधने वाले (aimed) कोणों की गणना फिर से प्राप्त करें, और पुनर्निर्मित C++ की तुलना उस समय के कंपाइलर के आउटपुट से करें।</p>
<p><a href="https://rea.tools/showcase/th04/">केस स्टडी पढ़ें</a> · <a href="https://github.com/N0zoM1z0/th04">पुनर्निर्माण की रिपॉज़िटरी</a></p>
</td></tr>
</tbody>
</table>

अगर आपने REA का उपयोग किसी दिलचस्प चीज़ पर किया है, तो हम उसे ज़रूर देखना चाहेंगे। अपना केस किसी [issue](https://github.com/morluto/rea/issues) या [pull request](https://github.com/morluto/rea/pulls) में साझा करें, और उसमें लक्ष्य, आपका प्रश्न, REA ने कैसे मदद की और आपको क्या मिला, यह शामिल करें।

## REA कैसे काम करता है

आपका एजेंट लक्ष्य की जाँच करने और संबंधित कोड को ट्रेस करने के लिए MCP के ज़रिए REA को कॉल करता है। REA निष्कर्षों को उनके साक्ष्य के साथ लौटाता है। एजेंट इनका उपयोग आगे के प्रश्न पूछने, व्यवहार समझाने, या कोई इम्प्लीमेंटेशन लिखने और टेस्ट करने के लिए करता है। CLI कमांड भी इन्हीं वर्कफ़्लो का उपयोग करती हैं।

![REA जाँच का प्रवाह: आपका एजेंट किसी स्थानीय लक्ष्य के बारे में पूछता है, REA विश्लेषण टूल से उसकी जाँच और ट्रेसिंग करता है, और एजेंट लौटाए गए कोड, रेफ़रेंस और अज्ञात बातों का उपयोग समझाने, इम्प्लीमेंट करने और टेस्ट करने के लिए करता है।](../../website/public/assets/figures/rea-investigation-flow.svg)

[चित्र को पूरे आकार में खोलें](../../website/public/assets/figures/rea-investigation-flow.svg)।

<a id="current-status"></a>

## आप क्या विश्लेषण कर सकते हैं

नेटिव बाइनरी · JavaScript / Electron · वेबसाइटें · .NET असेंबली · Android APK · फ़र्मवेयर · प्रोसेस का व्यवहार

[फ़ॉर्मैट और आवश्यकताएँ](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[प्रोवाइडर चुनना](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## RL एनवायरनमेंट बनाएँ

किसी रिकॉर्ड किए गए वेब सेशन या Linux डेस्कटॉप ऐप से एक स्थानीय एनवायरनमेंट बनाएँ, ताकि कोई एजेंट किसी टास्क का अभ्यास कर सके और उसका परिणाम जाँच सके।

[REA के साथ RL एनवायरनमेंट बनाएँ](https://rea.tools/guides/rl-environments/)

## अक्सर पूछे जाने वाले प्रश्न

<details>
<summary><strong>कौन-से एजेंट REA का उपयोग कर सकते हैं?</strong></summary>

कोई भी एजेंट जो स्थानीय MCP सर्वर को सपोर्ट करता है। सेटअप [समर्थित एजेंटों](../getting-started/installation.md#supported-agents) को कॉन्फ़िगर करता है; अन्य क्लाइंट [मैन्युअल MCP रजिस्ट्रेशन](../getting-started/installation.md#mcp-registry) का उपयोग कर सकते हैं।

</details>

<details>
<summary><strong>क्या मुझे Hopper, Ghidra, IDA या Kuna की ज़रूरत है?</strong></summary>

गहन नेटिव विश्लेषण इनमें से किसी एक का उपयोग करता है। स्टैटिक JavaScript और .NET जाँच किसी नेटिव विश्लेषण इंजन के बिना काम करती है। सेटअप आपकी स्वीकृति के बाद Hopper इंस्टॉल कर सकता है; Ghidra, IDA और Kuna के लिए आपके मौजूदा इंस्टॉलेशन उपयोग होते हैं। [प्रोवाइडर सेटअप](../getting-started/installation.md#hopper) देखें।

</details>

<details>
<summary><strong>क्या मुझे पहले Hopper शुरू करना होगा?</strong></summary>

जब किसी ऑपरेशन को Hopper की ज़रूरत होती है, तो REA उसे शुरू कर देता है। macOS पर पहली बार चलाने पर एक डायलॉग आपसे डेमो मोड चुनने या अपना लाइसेंस सक्रिय करने के लिए कह सकता है। [Hopper स्टार्टअप और समस्या निवारण](../getting-started/installation.md#launcher-paths-and-troubleshooting) देखें।

</details>

<details>
<summary><strong>skills.sh से स्किल इंस्टॉल करने पर क्या होता है?</strong></summary>

स्किल आपके एजेंट को जाँच करने के निर्देश देती है। REA का MCP सर्वर रजिस्टर करने और मेल खाते निर्देश इंस्टॉल करने के लिए `npx rea-agents setup` का उपयोग करें, फिर अपने एजेंट को रीस्टार्ट करें। [केवल स्किल इंस्टॉलेशन](../getting-started/installation.md#skill-only-installation) देखें।

</details>

<details>
<summary><strong>REA कौन-सा कोड लौटाता है?</strong></summary>

नेटिव विश्लेषण स्यूडोकोड और असेंबली लौटाता है। JavaScript/Electron विश्लेषण मॉड्यूल और उनके आपसी संबंध फिर से प्राप्त करता है। आपका एजेंट इन निष्कर्षों का उपयोग इम्प्लीमेंटेशन लिखने और टेस्ट करने के लिए करता है; [उदाहरण](#उदाहरण) अनुभाग में चरण-दर-चरण उदाहरण दिए गए हैं।

</details>

<details>
<summary><strong>क्या REA मेरा ऐप अपलोड करता है?</strong></summary>

REA लक्ष्यों का विश्लेषण स्थानीय रूप से करता है। आपके एजेंट को टूल के परिणाम मिलते हैं, और उसके मॉडल प्रोवाइडर की अपनी डेटा नीति होती है।

</details>

<details>
<summary><strong>अगर मुझे कोई बग मिले तो मैं क्या करूँ?</strong></summary>

पहले अपडेट करें; हो सकता है कि हाल की कोई रिलीज़ उसे पहले ही ठीक कर चुकी हो।

npm से इंस्टॉल किए गए CLI के लिए:

```bash
rea update
```

`npx` के ज़रिए एजेंट सेटअप के लिए:

```bash
npx rea-agents@latest setup
```

यदि आप किसी एजेंट का उपयोग कर रहे हैं, तो [सेटअप रीफ़्रेश](#rea-अपडेट-करें) पूरा करें और उसे रीस्टार्ट करें। वही टास्क दोबारा आज़माएँ। अगर समस्या बनी रहती है, तो अपने REA संस्करण, लक्ष्य के प्रकार, समस्या दोहराने के चरणों और एरर आउटपुट के साथ [एक issue खोलें](https://github.com/morluto/rea/issues)।

</details>

## दस्तावेज़

वेबसाइट की [व्यावहारिक गाइड](https://rea.tools/guides/) से शुरुआत करें। सटीक विकल्पों, पूर्व-आवश्यकताओं और परिणाम कॉन्ट्रैक्ट के लिए:

- [इंस्टॉलेशन और सेटअप](../getting-started/installation.md): एजेंट रजिस्ट्रेशन, प्रोवाइडर कॉन्फ़िगरेशन, अपडेट और अनइंस्टॉल।
- [तैयारी की जाँच और समस्या निवारण](../getting-started/installation.md#check-readiness-for-your-task): किसी एक एजेंट या विश्लेषण इंजन की समस्या का निदान।
- [CLI और Evidence](../getting-started/cli.md): कमांड, प्रोवाइडर चयन, स्नैपशॉट, इम्पोर्ट/एक्सपोर्ट और एग्ज़िट स्टेटस।
- [MCP कॉन्ट्रैक्ट](../reference/mcp-contracts.md) और [एजेंट प्रॉम्प्ट](../getting-started/mcp-prompts.md): टूल के परिणाम, सेशन और निर्देशित जाँच।
- [टूल कैटलॉग](../reference/mcp-contracts.md#generated-catalog): बिल्ड के समय जनरेट की गई टूल, प्रोवाइडर और CLI कमांड की सूची।

सुरक्षा कमज़ोरियों की रिपोर्ट [SECURITY.md](../../SECURITY.md) के ज़रिए करें।

## समुदाय और सहायता

- **Discord** — 50,000 से अधिक रिवर्स इंजीनियरों और बिल्डरों के हमारे उत्साही समुदाय से प्रश्न पूछें और अपनी जाँच साझा करें! [![Discord पर REA से जुड़ें](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — अपडेट और घोषणाओं के लिए [@reatools](https://x.com/reatools) को फ़ॉलो करें।
- **सुझाव और विचार** — कोई नया फ़ीचर या किसी फ़ाइल फ़ॉर्मैट का सपोर्ट चाहिए? [GitHub पर issue खोलें](https://github.com/morluto/rea/issues) या [हमारे Discord से जुड़ें](https://discord.gg/GkcryMnJDM) और हमें बताएँ।

## स्टार इतिहास

🎉 **4,00,000 GitHub स्टार — धन्यवाद!**

REA का उपयोग करने, बग रिपोर्ट करने, फ़ीचर का अनुरोध करने, बिल्ड टेस्ट करने और फ़िक्स में योगदान देने वाले सभी लोगों का धन्यवाद।

<a href="https://rea.tools/contributors/">
  <img src="../../website/public/contributors/avatars.png" alt="REA के योगदानकर्ता" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA का GitHub स्टार इतिहास" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## योगदान

REA में आपकी मदद का हमें इंतज़ार है! बग रिपोर्ट करने या कोई फ़ीचर सुझाने के लिए [एक issue खोलें](https://github.com/morluto/rea/issues), या कोड या दस्तावेज़ सुधारने के लिए [एक pull request भेजें](https://github.com/morluto/rea/pulls)।

डेवलपमेंट सेटअप और जाँचों के लिए [CONTRIBUTING.md](../../CONTRIBUTING.md), और सत्यापन लेन के लिए [टेस्टिंग गाइड](../development/testing.md) देखें।

## अस्वीकरण

ज़िम्मेदार उपयोग से जुड़े मार्गदर्शन के लिए [DISCLAIMER.md](../../DISCLAIMER.md) देखें।

REA वैध शोध, शिक्षा, इंटरऑपरेबिलिटी, सॉफ़्टवेयर संरक्षण और ऐसे सॉफ़्टवेयर के विश्लेषण के लिए है जिसके आप स्वामी हैं या जिसकी जाँच करने के लिए आप अधिकृत हैं।

अवैध या अनधिकृत उपयोग पर प्रोजेक्ट का रुख REA के सभी संस्करणों, वितरण चैनलों और प्लेटफ़ॉर्म पर लागू होता है; हर प्रति पर उसके लागू लाइसेंस बने रहते हैं।

## लाइसेंस

[MIT](../../LICENSE)

REA के लिए लिखा गया कोड MIT लाइसेंस के अंतर्गत है। तृतीय-पक्ष सामग्री अपने लाइसेंस और कॉपीराइट नोटिस बनाए रखती है; डिपेंडेंसी सूची, सुरक्षित रखे गए लाइसेंस टेक्स्ट और बाहरी टूल की शर्तों के लिए [तृतीय-पक्ष नोटिस](../../THIRD_PARTY_NOTICES.md) देखें।

**आपको व्यावसायिक टूल वैध रूप से प्राप्त करने होंगे और उनके लागू लाइसेंसों के अंतर्गत उनका उपयोग करने के लिए अधिकृत होना होगा**, जिनमें IDA Pro / Hex-Rays डीकंपाइलर, Hopper और JEB शामिल हैं। REA कोई टूल लाइसेंस, कुंजी या एक्टिवेशन का अधिकार नहीं देता। ट्रायल और डेमो संस्करण विक्रेता की शर्तों के अधीन रहते हैं, जिनमें उपयोगकर्ता, फ़ीचर, ऑटोमेशन और आउटपुट साझा करने से जुड़े प्रतिबंध शामिल हैं। क्रैक की गई प्रतियाँ, चुराई गई कुंजियाँ, कुंजियों को अनधिकृत रूप से साझा करना और लाइसेंस प्रतिबंधों को दरकिनार करना अधिकृत नहीं है। यह मार्गदर्शन MIT या तृतीय-पक्ष लाइसेंसों में कोई संशोधन नहीं करता।
