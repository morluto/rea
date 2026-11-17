<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md) · **हिन्दी**

# REA: Reverse Engineer Anything

### बाइनरी, एप्लिकेशन और रनटाइम व्यवहार की रिवर्स इंजीनियरिंग के लिए एक MCP।

**कोई फ़ीचर पसंद आया? समझिए कि वह कैसे काम करता है, बाइनरी स्तर तक।**

[![npm संस्करण](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![MCP टूल कैटलॉग](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](../reference/mcp-contracts.md#generated-catalog)
[![Node.js आवश्यकताएँ](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#current-status)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)
[![MIT लाइसेंस](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55"/></a>

**[वेबसाइट](https://rea.tools/) · [गाइड](https://rea.tools/guides/) · [उदाहरण](https://rea.tools/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Discord पर REA समुदाय से जुड़ें" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[त्वरित शुरुआत](#त्वरित-शुरुआत) · [REA कैसे काम करता है](#rea-कैसे-काम-करता-है) · [आप क्या विश्लेषण कर सकते हैं](#आप-क्या-विश्लेषण-कर-सकते-हैं) · [उदाहरण](#उदाहरण) · [RL एनवायरनमेंट बनाएँ](#build-rl-environments) · [अक्सर पूछे जाने वाले प्रश्न](#अक्सर-पूछे-जाने-वाले-प्रश्न) · [दस्तावेज़](#दस्तावेज़)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> REA केवल [morluto/rea](https://github.com/morluto/rea),
> [rea.tools](https://rea.tools/) या [rea-agents npm पैकेज](https://www.npmjs.com/package/rea-agents) से प्राप्त करें।
> इंस्टॉलेशन और रिलीज़ के लिंक इन्हीं आधिकारिक स्रोतों से लें। मिलते-जुलते
> रिपॉज़िटरी नाम या कॉपी किए गए README से यह सिद्ध नहीं होता कि कोई डाउनलोड आधिकारिक है।

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

सेटअप REA को आपके एजेंट में रजिस्टर करता है और उससे मेल खाते वर्कफ़्लो निर्देश इंस्टॉल करता है। नेटिव विश्लेषण पहले से इंस्टॉल Hopper, Ghidra, IDA या Kuna का उपयोग कर सकता है; आपकी स्वीकृति मिलने पर सेटअप वैकल्पिक रूप से Hopper इंस्टॉल कर सकता है। स्टैटिक JavaScript विश्लेषण के लिए किसी नेटिव विश्लेषण इंजन की ज़रूरत नहीं होती।

> सेटअप निर्देशों, चित्रों सहित गाइड और वास्तविक केस स्टडी के लिए **[REA वेबसाइट देखें](https://rea.tools/)**।

## त्वरित शुरुआत

Linux पर Ghidra, JADX और फ़र्मवेयर टूल लॉन्च करने तथा स्टैटिक JavaScript/Electron
विश्लेषण के लिए, प्रोसेस के स्वामित्व की जाँच हेतु procps-संगत सिस्टम `ps`
होना आवश्यक है। समस्या दूर करने के चरण `docs/getting-started/installation.md` में
"Linux owned-process prerequisite" शीर्षक के अंतर्गत दिए गए हैं।

### अपना एजेंट सेट अप करें

Node.js और npm इंस्टॉल होने पर यह चलाएँ:

```bash
npx rea-agents setup
```

अपने एजेंट चुनें, प्रस्तावित बदलावों की समीक्षा करें और उन्हें स्वीकृत करें। सेटअप
REA का MCP सर्वर और उससे मेल खाते वर्कफ़्लो निर्देश जोड़ता है, और मौजूदा
कॉन्फ़िगरेशन का बैकअप रखता है। इसके बाद अपने एजेंट को रीस्टार्ट करें। सेटअप चुने गए
रनटाइम और REA की एंट्री स्क्रिप्ट को सीधे दर्ज करता है। यदि REA किसी पैकेज रनर से
प्राप्त किया गया है, तो उसकी कैश एंट्री उपलब्ध रहने दें। पैकेज प्राप्त करने वाली कमांड
लक्ष्य प्रोजेक्ट के बाहर किसी भरोसेमंद डायरेक्टरी से चलाएँ। इंस्टॉलेशन और रिकवरी का
विवरण नीचे दी गई सेटअप गाइड में है।

सेटअप Claude Code, Codex, Cursor, Gemini CLI, Grok Build और
[अन्य एजेंटों](../getting-started/installation.md#supported-agents) को सपोर्ट करता है।
प्रोवाइडर कॉन्फ़िगरेशन, मैन्युअल MCP रजिस्ट्रेशन, Claude Code/Codex प्लगइन और Cursor
Marketplace प्लगइन के लिए [इंस्टॉलेशन और सेटअप](../getting-started/installation.md) देखें।

कॉन्टेक्स्ट का बोझ कम करने के लिए MCP कॉम्पैक्ट इनपुट स्कीमा घोषित करता है; कॉम्पैक्ट
स्कीमा में जो मार्गदर्शन छूट जाता है, वह टूल विवरण में आता है। पूरा टूल सेट और सर्वर का
कैनोनिकल वैलिडेशन नहीं बदलते। MCP कॉन्ट्रैक्ट गाइड में "Compact input schema profile"
देखें।

आउटपुट स्कीमा डिफ़ॉल्ट रूप से `tools/list` से हटा दिए जाते हैं: कोई मॉडल API उन्हें नहीं
पढ़ता, और REA हर परिणाम को खुद वैलिडेट करता है। हर आउटपुट स्कीमा को 4,096 बाइट की सीमा
के भीतर घोषित करने के लिए `REA_MCP_OUTPUT_SCHEMA_PROFILE=compact` सेट करें। दोनों सेटिंग
सर्वर-साइड कैनोनिकल वैलिडेशन और पूरे संरचित परिणाम बनाए रखती हैं। MCP कॉन्ट्रैक्ट गाइड
में "Output schemas" देखें।

### अपने एजेंट से पूछें

```text
पता लगाएँ कि Notes ऐप में सर्च कैसे काम करता है, मुझे साक्ष्य दिखाएँ और मेरे
प्रोजेक्ट के लिए वैसा ही फ़ीचर बनाएँ।
```

Notes की जगह अपना लक्ष्य ऐप और वह फ़ीचर लिखें जिसे आप समझना चाहते हैं।

### टर्मिनल का उपयोग करें

निकाली गई (extracted) JavaScript/Electron ऐप डायरेक्टरी या ASAR की जाँच करें:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

परिणाम में मॉड्यूल, इम्पोर्ट, Electron बाउंड्री और उनके साक्ष्य शामिल होते हैं।
पाथ की जगह अपना लक्ष्य दें, जैसे Windows पर `"D:/apps/example"`।

नियमित उपयोग के लिए `rea` कमांड इंस्टॉल करने हेतु:

```bash
npm install --global rea-agents
rea --help
```

नेटिव विश्लेषण के लिए पहले कोई प्रोवाइडर कॉन्फ़िगर करें। नेटिव कमांड, प्रोवाइडर चयन,
स्नैपशॉट और स्क्रिप्टिंग के लिए [CLI और Evidence गाइड](../getting-started/cli.md) देखें।

### REA अपडेट करें

REA तेज़ी से बदलता है, और नई रिलीज़ में अक्सर बग फ़िक्स शामिल होते हैं। अपना
इंस्टॉलेशन अप-टू-डेट रखें।

`npm install --global` या `bun add --global` से इंस्टॉल किए गए CLI के लिए:

```bash
rea update
```

`rea --update` इसी सत्यापित वर्कफ़्लो का उपनाम (alias) है और वही ग्लोबल आउटपुट
फ़्लैग स्वीकार करता है। इसे अन्य कमांड नियंत्रणों के साथ मिलाते समय `rea update` का
उपयोग करें।

अपडेटर कमांड stdout और stderr को मिलाकर अधिकतम 4 MiB तक ही रखती हैं। बहुत बड़े
मेटाडेटा उत्तर कमांड समाप्त होने के बाद अस्वीकार कर दिए जाते हैं; विस्तृत (verbose)
इंस्टॉलेशन सीमित डायग्नोस्टिक्स के साथ जारी रहते हैं। लोगों के पढ़ने के लिए दिखाया
जाने वाला प्रगति आउटपुट टर्मिनल के बैकप्रेशर का ध्यान रखता है और भेजे गए राइट पूरे
होने की प्रतीक्षा करता है।

Bun से ग्लोबल अपडेट के लिए Bun 1.2.17 या उसके बाद का संस्करण आवश्यक है। पुराने Bun
रिलीज़ के साथ, `rea update` चलाने से पहले Bun को मैन्युअल रूप से अपग्रेड करें।

अपने एजेंट रजिस्ट्रेशन और स्किल को रीफ़्रेश करने के लिए, अपडेट द्वारा प्रिंट की गई
सेटअप कमांड चलाएँ।

यदि आप `npx` का उपयोग करते हैं, तो अपने एजेंट का सेटअप इससे अपडेट करें:

```bash
npx rea-agents@latest setup
```

सेटअप के बदलावों की समीक्षा करें और अपने एजेंट को रीस्टार्ट करें। एक बार चलने वाली
CLI कमांड के लिए `npx rea-agents@latest` के बाद कमांड लिखें। Bun के साथ,
`npx rea-agents@latest` की जगह `bunx rea-agents@latest` का उपयोग करें।

## REA कैसे काम करता है

आपका एजेंट लक्ष्य की जाँच करने और संबंधित कोड को ट्रेस करने के लिए MCP के ज़रिए REA
को कॉल करता है। REA निष्कर्षों को उनके साक्ष्य के साथ लौटाता है। एजेंट इनका उपयोग आगे
के प्रश्न पूछने, व्यवहार समझाने, या कोई इम्प्लीमेंटेशन लिखने और टेस्ट करने के लिए
करता है। CLI कमांड भी इन्हीं वर्कफ़्लो का उपयोग करती हैं।

![REA जाँच का प्रवाह: आपका एजेंट किसी स्थानीय लक्ष्य के बारे में पूछता है, REA विश्लेषण टूल से उसकी जाँच और ट्रेसिंग करता है, और एजेंट लौटाए गए कोड, रेफ़रेंस और अज्ञात बातों का उपयोग समझाने, इम्प्लीमेंट करने और टेस्ट करने के लिए करता है।](../../website/public/assets/figures/rea-investigation-flow.svg)

[चित्र को पूरे आकार में खोलें](../../website/public/assets/figures/rea-investigation-flow.svg)।

<a id="current-status"></a>

## आप क्या विश्लेषण कर सकते हैं

REA के लिए Node.js 22.x (>=22.23.4), 24.x (>=24.22.1) या 26.12.1+ और साथ में npm
आवश्यक है। अतिरिक्त टूल और होस्ट सपोर्ट लक्ष्य पर निर्भर करते हैं:

| लक्ष्य                      | REA क्या लौटाता है                                                             | आवश्यकताएँ और गाइड                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| डेस्कटॉप इंस्टॉलेशन            | रनटाइम के संभावित विकल्प, सहायक फ़ाइलें, कंपोनेंट मार्कर और जाँच के अगले चरण              | बिल्ट-इन सीमित डायरेक्टरी/हेडर जाँच; [डेस्कटॉप एप्लिकेशन](../desktop-applications.md)                                                                             |
| नेटिव बाइनरी               | स्यूडोकोड, असेंबली, स्ट्रिंग, सिंबल, कॉल और रेफ़रेंस                                     | Hopper, Ghidra, IDA या Kuna; [नेटिव विश्लेषण](../guides/native/native-investigation.md)                                                                     |
| ऑफ़लाइन ELF लेआउट           | सेक्शन, सेगमेंट, मूल सिंबल/रीलोकेशन और स्टैटिक सुरक्षा उपायों (mitigations) के संभावित संकेत  | Linux x64 पर आपके द्वारा दिया गया pwntools; [बाइनरी डायग्नोस्टिक्स](../guides/native/binary-diagnostics.md)                                                   |
| Go बाइनरी                 | एम्बेड किया गया कंपाइलर संस्करण, मॉड्यूल, रिप्लेसमेंट और बिल्ड सेटिंग                      | बिल्ट-इन स्टैटिक ELF/PE/thin Mach-O जाँच; Go इंस्टॉलेशन आवश्यक नहीं                                                                                               |
| GPU कोड ऑब्जेक्ट             | CUDA/HIP टारगेट, चुने गए कर्नेल पैरामीटर और रिसोर्स, सुरक्षित रखा गया PTX टेक्स्ट        | बिल्ट-इन स्टैटिक ELF/PE/fatbin/CUBIN/PTX जाँच; [GPU कोड ऑब्जेक्ट](../gpu-code-objects.md)                                                                       |
| मॉडल आर्टिफ़ैक्ट              | GGUF / safetensors मेटाडेटा, टेंसर घोषणाएँ और उनसे निकाले गए कुल मान                 | बिल्ट-इन हेडर जाँच; वैकल्पिक पूरी फ़ाइल का हैश; [मॉडल फ़ाइलें](../model-artifacts.md)                                                                               |
| IL2CPP मेटाडेटा             | Unity global-metadata.dat की असेंबली इमेज, टाइप और मेथड के नाम तथा इंडेक्स रेंज        | संस्करण 24, 27, 29, 31 और 39 की बिल्ट-इन स्टैटिक डिकोडिंग; Unity आवश्यक नहीं                                                                                     |
| Godot PCK                 | आर्काइव की सूची और एक्सट्रैक्शन, मूल हेडर/डायरेक्टरी तथ्य और चुनी गई सामग्री की पहचान     | बिल्ट-इन स्टैटिक फ़ॉर्मैट 2, 3 और 4; Godot आवश्यक नहीं                                                                                                           |
| Rust बाइनरी               | एम्बेड किए गए cargo-auditable crate नाम, संस्करण, स्रोत और डिपेंडेंसी संबंध             | बिल्ट-इन स्टैटिक ELF/PE/thin Mach-O जाँच; [Rust बाइनरी](../rust-binaries.md)                                                                                 |
| PE सर्टिफ़िकेट               | Authenticode WIN_CERTIFICATE एंट्री और PKCS#7 साइनर/X.509 पहचान फ़ील्ड           | बिल्ट-इन स्टैटिक PE जाँच; [PE सर्टिफ़िकेट](../pe-certificates.md)                                                                                               |
| PE इम्पोर्ट                 | इम्पोर्ट और delay-load DLL नाम, ऑर्डिनल, IAT RVA और pefile इम्पोर्ट हैश            | बिल्ट-इन स्टैटिक PE जाँच; [PE इम्पोर्ट](../pe-imports.md)                                                                                                      |
| Windows शॉर्टकट            | Shell Link टारगेट, आर्गुमेंट, वर्किंग डायरेक्टरी, ExtraData और Tracker droid तथ्य      | बिल्ट-इन स्टैटिक LNK जाँच; [Windows शॉर्टकट](../guides/native/windows-shortcut.md)                                                                            |
| ELF नोट्स                  | PT_NOTE/SHT_NOTE ओनर, टाइप, GNU build-id और ABI-tag फ़ील्ड                     | बिल्ट-इन स्टैटिक ELF जाँच; [ELF नोट्स](../elf-notes.md)                                                                                                       |
| DWARF कंपाइल यूनिट          | कंपाइल-यूनिट नाम, डायरेक्टरी, producer, भाषा और dwo_name                         | बिल्ट-इन स्टैटिक ELF, Mach-O और PE जाँच; [DWARF कंपाइल यूनिट](../guides/native/dwarf-units.md)                                                                 |
| ELF निर्भरताएँ              | DT_NEEDED, SONAME, RPATH/RUNPATH, GNU संस्करण और अपरिभाषित इम्पोर्ट              | बिल्ट-इन स्टैटिक ELF जाँच; [ELF निर्भरताएँ](../elf-dependencies.md)                                                                                            |
| बाइनरी हार्डनिंग            | ELF, PE और Mach-O के लिए PIE, NX, RELRO, CFG और संबंधित हेडर फ़्लैग                 | बिल्ट-इन स्टैटिक हेडर जाँच; [बाइनरी हार्डनिंग](../binary-hardening.md)                                                                                          |
| Apple IPS क्रैश             | .ips मेटाडेटा, थ्रेड, इमेज, रजिस्टर और प्रलेखित क्रैश श्रेणियाँ                           | बिल्ट-इन स्टैटिक JSON जाँच; [Apple IPS](../apple-ips.md)                                                                                                     |
| Linux कर्नेल मॉड्यूल          | .modinfo कुंजियाँ, __versions CRC, this_module की उपस्थिति और सिग्नेचर ट्रेलर        | बिल्ट-इन स्टैटिक ELF जाँच; [कर्नेल मॉड्यूल](../kernel-modules.md)                                                                                                |
| Erlang BEAM               | IFF चंक, एटम, एक्सपोर्ट, इम्पोर्ट, लैम्ब्डा और Code हेडर                              | बिल्ट-इन स्टैटिक BEAM जाँच; [Erlang BEAM](../erlang-beam.md)                                                                                                 |
| NuGet पैकेज                 | पैकेज की पहचान, डिपेंडेंसी ग्रुप, लाइसेंस, रिपॉज़िटरी और ZIP की सामग्री                  | बिल्ट-इन स्टैटिक .nupkg जाँच; [NuGet पैकेज](../guides/managed/nuget-nupkg.md)                                                                                  |
| WASM आर्टिफ़ैक्ट              | वैलिडेशन, सेक्शन, सटीक import/export WAT रूप और डिकोड किया गया WAT                | आपके द्वारा दिया गया WABT 1.0.42; `inspect_wasm_artifact`                                                                                                  |
| EVM बाइटकोड               | डिस्पैच सिलेक्टर, बाइट ऑफ़सेट, अनुमानित आर्गुमेंट और mutability                         | Linux x64 पर स्थानीय raw/hex कैरियर; [ऑफ़लाइन EVM गाइड](../guides/evm/evm-bytecode.md)                                                                      |
| SQLite डेटाबेस              | टेबल, कॉलम, इंडेक्स, व्यू, ट्रिगर और साधारण टेबल की चुनी गई पंक्तियाँ                    | स्थानीय डेटाबेस/WAL स्नैपशॉट; नेटिव SQLite सीमाओं के साथ Node.js 24.x >=24.15 या 26+                                                                             |
| रिकॉर्ड किए गए Linux क्रैश   | रॉ नोट्स, हर रिकॉर्ड किए गए थ्रेड के रजिस्टर/सिग्नल और वैकल्पिक मैपिंग के संभावित मिलान   | Linux x64 पर आपके द्वारा दिया गया pwntools; वैकल्पिक GDB/pwndbg; [रिकॉर्ड किए गए क्रैश](../guides/native/recorded-crashes.md)                                   |
| JavaScript / Electron     | मॉड्यूल, इम्पोर्ट, source map, रूट, IPC, नेटिव ऐड-ऑन, `rea audit-release-exposure` | Node.js और npm; Linux: procps-संगत `ps`; [एप्लिकेशन विश्लेषण](../guides/javascript/javascript-application-workflows.md)                                       |
| वेबसाइट                    | पेज की संरचना, स्क्रिप्ट, नेटवर्क अवलोकन और माँगे गए स्क्रीनशॉट                         | Chrome-परिवार का कोई ब्राउज़र; [ब्राउज़र विश्लेषण](../guides/web/browser-observation.md)                                                                       |
| सहेजे गए नेटवर्क कैप्चर         | रिक्वेस्ट, रिस्पॉन्स, उजागर पेलोड और सोर्स में उनकी जगह                               | HAR या Fiddler Everywhere SAZ; नेटिव mitmproxy के लिए Linux पर mitmdump; [कैप्चर गाइड](../guides/web/web-network-captures.md)                                |
| .NET असेंबली                | मेटाडेटा, CIL इंस्ट्रक्शन, घोषित नेटिव डिपेंडेंसी और बिल्ड की तुलना                       | कुछ नहीं (केवल स्टैटिक); [मैनेज्ड-कोड गाइड](../guides/managed/managed-code-analysis.md)                                                                          |
| Android APK               | मैनिफ़ेस्ट घोषणाएँ, क्लास, डीकंपाइल किए गए मेथड और रेफ़रेंस                              | Linux/macOS/Windows x64 पर हेडलेस JADX और पूरा JDK; [Android गाइड](../guides/android/android-analysis.md)                                                   |
| APK सिग्नेचर                | v1/v2/v3/v3.1 साइनर, सर्टिफ़िकेट फ़िंगरप्रिंट, की रोटेशन और डाइजेस्ट की आंतरिक संगति     | कुछ नहीं (केवल स्टैटिक); `inspect_apk_signature`                                                                                                              |
| Android डिवाइस            | डिवाइस, पैकेज, प्रोसेस, लॉग, डंप, स्क्रीन कैप्चर और APK/फ़ाइल ट्रांसफ़र                   | आपके द्वारा दिया गया adb (एमुलेटर या हार्डवेयर); [ADB गाइड](../guides/android/adb-device-analysis.md)                                                          |
| JEB प्रोजेक्ट                | इंजन पर आधारित प्रोजेक्ट यूनिट, आर्टिफ़ैक्ट डाइजेस्ट और टाइप/मेथड स्यूडो-कोड               | आपके द्वारा शुरू किया गया MCP सर्व करने वाला JEB क्लाइंट, REA_JEB_MCP_URL से चुना गया; [JEB गाइड](../providers/jeb-analysis.md)                                    |
| Android रिसोर्स            | डिकोड किया गया मैनिफ़ेस्ट, स्ट्रिंग टेबल, लोकेल और संस्करण से जुड़े तथ्य                     | आपके द्वारा दिया गया Apktool लॉन्चर; [रिसोर्स गाइड](../guides/android/apktool-resource-analysis.md)                                                          |
| Flutter ऐप                | Dart स्नैपशॉट हैश, हर ABI की लाइब्रेरी के डाइजेस्ट और इंजन बिल्ड का स्रोत               | कुछ नहीं (स्टैटिक APK पार्सिंग); [Flutter गाइड](../guides/android/flutter-analysis.md)                                                                         |
| फ़र्मवेयर                    | रीजन, एक्सट्रैक्शन के परिणाम और नेटिव विश्लेषण के लिए हैंडऑफ़                            | Linux पर Binwalk / Unblob; [फ़र्मवेयर गाइड](../guides/firmware/firmware-analysis.md)                                                                        |
| रिकॉर्ड किए गए पैकेट         | चुने गए फ़ील्ड, दोहराए गए मान, फ़िल्टर और decode-as नियम                           | Linux: TShark 4.x + prlimit; [कैप्चर गाइड](../guides/data/packet-captures.md)                                                                              |
| पैकेट सारांश                 | एंडपॉइंट, DNS, TLS SNI, प्रोटोकॉल वितरण और HTTP रिक्वेस्ट                          | आपके द्वारा दिए गए tshark और capinfos (Linux पर सत्यापित); [pcap गाइड](../guides/data/pcap-analysis.md)                                                     |
| रिकॉर्ड किए गए लॉजिक सिग्नल | डिकोडर एनोटेशन, सैंपल रेंज और डायग्नोस्टिक्स                                         | Linux: sigrok-cli 0.7.2 + prlimit; [सिग्नल रिकॉर्डिंग](../guides/signals/signal-recordings.md)                                                              |
| पैकेज और रिसोर्स             | फ़ाइलों की सूची, डाइजेस्ट, plist, Apple बंडल की संरचना और निकाले गए रिसोर्स           | [आर्टिफ़ैक्ट और JavaScript गाइड](../guides/javascript/javascript-artifact-reconstruction.md), [Apple एप्लिकेशन](../guides/apple/apple-application-analysis.md) |
| प्रोसेस का व्यवहार           | टर्मिनल आउटपुट, इंटरैक्शन, एग्ज़िट और फ़ाइल सिस्टम अवलोकन, और रन की तुलना              | नेटिव PTY के साथ Linux/macOS; [प्रोसेस कैप्चर](../guides/runtime/process-capture.md)                                                                           |
| PyInstaller एक्ज़ीक्यूटेबल     | CArchive सदस्य, Python संस्करण, एंट्री स्क्रिप्ट और निकाला गया बाइटकोड               | कुछ नहीं (केवल स्टैटिक); [पैकेज किए गए Python एप्लिकेशन](../python-packaged-applications.md)                                                                      |
| Deno compile बाइनरी       | वर्चुअल फ़ाइलें, एंट्री पॉइंट, दर्ज विकल्प, npm स्नैपशॉट की लंबाई                         | कुछ नहीं (केवल स्टैटिक); [Deno compile एक्ज़ीक्यूटेबल](../deno-standalone.md)                                                                                      |

स्टैटिक JavaScript और .NET जाँच दी गई फ़ाइलों को एप्लिकेशन चलाए बिना पढ़ती है।
रनटाइम कैप्चर आपकी उपयोगकर्ता अनुमतियों के साथ चुने गए लक्ष्य को चलाता है या उससे
इंटरैक्ट करता है; हर रनटाइम गाइड उसके प्रभावों का वर्णन करती है।

ऑफ़लाइन नेटिव-बाइनरी जाँच के लिए REA आपके द्वारा दिए गए GNU objdump और Rizin को भी
सपोर्ट करता है। प्रोवाइडर सेटअप, CLI कमांड और Evidence की सीमाओं के लिए
[रिवर्स इंजीनियरिंग टूल गाइड](../reverse-engineering-tools.md) देखें। REA इनमें से
किसी भी प्रोवाइडर को इंस्टॉल या अपडेट नहीं करता।

<a id="choosing-a-deep-analysis-provider"></a>

नेटिव फ़ॉर्मैट और होस्ट सपोर्ट प्रोवाइडर के अनुसार अलग-अलग होते हैं।
[Hopper और Ghidra सेटअप](../getting-started/installation.md#hopper),
[IDA गाइड](../providers/ida-provider.md) (वैकल्पिक नेटिव MCP ब्रिज सहित),
[Kuna डीकंपाइलर गाइड](../kuna-provider.md) और
[Windows पर प्रायोगिक Ghidra सपोर्ट](../providers/windows-ghidra-p0.md) देखें।
Ghidra [16-बिट DOS विश्लेषण](../providers/ghidra-dos.md) को भी सपोर्ट करता है।
बड़ी बाइनरी के लिए `REA_GHIDRA_STARTUP_TIMEOUT_MS` या `REA_HOPPER_STARTUP_TIMEOUT_MS`
से प्रोवाइडर की स्टार्टअप समय-सीमा बढ़ाएँ। प्रोवाइडर चुनने के लिए
[CLI गाइड](../getting-started/cli.md#choose-a-provider) देखें। नवीनतम npm रिलीज़ के बाद
जोड़े गए फ़ीचर के लिए [रिलीज़ में उपलब्धता](../getting-started/installation.md#released-package-and-main)
जाँचें।

## उदाहरण

<a href="https://rea.tools/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="DX-Ball साउंड-पैन, Notion क्लिपबोर्ड ब्रिज और TH04 बुलेट-रिंग उदाहरणों के चित्र" src="../assets/rea-showcases.svg" />
  </picture>
</a>

### DX-Ball: साउंड-पैन की गणना का पुनर्निर्माण

किसी साउंड कॉल को उसके position-to-pan हेल्पर तक फ़ॉलो करें, इंस्ट्रक्शन की जाँच करें
और अधूरे स्यूडोकोड को C में बदलें। यह पुनर्निर्माण मूल x86 के 3,205 टेस्ट केस पास
करता है और कंपाइल किए गए फ़ंक्शन के सभी 63 बाइट हूबहू दोबारा बनाता है।

[केस स्टडी पढ़ें](https://rea.tools/showcase/dx-ball/) ·
[पुनर्निर्माण की रिपॉज़िटरी](https://github.com/N0zoM1z0/dx-ball)

### Notion: Electron क्लिपबोर्ड ब्रिज को ट्रेस करना

रेंडरर का क्लिपबोर्ड API खोजें, preload और IPC से होते हुए उसे मुख्य प्रोसेस तक फ़ॉलो
करें और रिच क्लिपबोर्ड फ़ॉर्मैट की जाँच करें।

[केस स्टडी पढ़ें](https://rea.tools/showcase/notion/)

### TH04: DOS बुलेट-रिंग की गणना को फिर से प्राप्त करना

मूल PC-98 गेम के 16-बिट इंस्ट्रक्शन की जाँच करें, स्थिर और निशाना साधने वाले (aimed)
कोणों की गणना फिर से प्राप्त करें, और पुनर्निर्मित C++ की तुलना उस समय के कंपाइलर
के आउटपुट से करें।

[केस स्टडी पढ़ें](https://rea.tools/showcase/th04/) ·
[पुनर्निर्माण की रिपॉज़िटरी](https://github.com/N0zoM1z0/th04)

### REA से RL एनवायरनमेंट बनाएँ

किसी वेब ऐप का सेशन रिकॉर्ड करें, उसके API को टूल में बदलें और ऐसा एनवायरनमेंट एक्सपोर्ट करें जिसे AI एजेंट उपयोग कर सके। इसे AgentEnv से चलाएँ, फिर RL ट्रेनिंग या मूल्यांकन के लिए टास्क और रिवॉर्ड जाँचें जोड़ें।

[गाइड पढ़ें](https://rea.tools/guides/rl-environments/) ·
[वीडियो देखें](https://x.com/reatools/status/2112574822584918075?s=20)

अगर आपने REA का उपयोग किसी दिलचस्प चीज़ पर किया है, तो हम उसे ज़रूर देखना चाहेंगे।
अपना केस किसी [issue](https://github.com/morluto/rea/issues) या
[pull request](https://github.com/morluto/rea/pulls) में साझा करें, और उसमें लक्ष्य,
आपका प्रश्न, REA ने कैसे मदद की और आपको क्या मिला, यह शामिल करें।

<a id="build-rl-environments"></a>

## RL एनवायरनमेंट बनाएँ

किसी AI एजेंट को एक स्थानीय एनवायरनमेंट दें, जिसमें वह मूल ऐप चलाए बिना कोई issue ढूँढने या फ़ोल्डर बनाने जैसे टास्क का अभ्यास कर सके। इसका उपयोग रीइनफ़ोर्समेंट लर्निंग (RL) के लिए करें, या यह जाँचने के लिए कि एजेंट टास्क कितनी अच्छी तरह पूरे करता है।

REA रिकॉर्ड किए गए API रिक्वेस्ट और रिस्पॉन्स को ऐसे टूल में बदलता है जिन्हें एजेंट कॉल कर सकता है। एनवायरनमेंट रिकॉर्ड किए गए डेटा का उपयोग करता है और बदलावों को केवल तभी सपोर्ट करता है जब रिकॉर्डिंग उनके प्रभावों की पुष्टि करती है।

अपने एजेंट में REA सेट अप करने के बाद, नीचे दिए गए उदाहरण URL और फ़ोल्डर टास्क को अपने टास्क से बदलें:

```text
REA का उपयोग करके मेरे टेस्ट वेब ऐप से एक RL एनवायरनमेंट बनाएँ:
http://127.0.0.1:3000
फ़ोल्डरों को सूचीबद्ध करना, बनाना, उनका नाम बदलना और उन्हें हटाना शामिल करें। आप
टेस्ट फ़ोल्डर बना और हटा सकते हैं। मौजूदा डेटा में कोई बदलाव न करें।
इसे my-env नाम के फ़ोल्डर में सहेजें। जाँचें कि कौन-से ऑपरेशन काम करते हैं और मुझे
बताएँ कि इसे कैसे चलाना है।
```

<details>
<summary>इसके बजाय कमांड लाइन का उपयोग करें</summary>

यदि आपके पास पहले से ऐसी फ़ाइल है जिसमें ऐप के रिकॉर्ड किए गए ब्राउज़र रिक्वेस्ट और रिस्पॉन्स हैं, तो ये कमांड उपयोग करें। परिणाम चलाने के लिए AgentEnv और Docker भी आवश्यक हैं।

```sh
rea environment-build ./session.har ./my-env --name my-env --json
agent-env run ./my-env
```

</details>

REA एक ऐसा एनवायरनमेंट एक्सपोर्ट करता है जिसे सीधे चलाया जा सकता है, और उसमें एक बुनियादी टेस्ट होता है जो जाँचता है कि वह शुरू होता है और जवाब देता है। टास्क के लक्ष्य तय करने, रिवॉर्ड जाँचें जोड़ने और ट्रेनिंग चलाने के लिए इसे अपने RL फ़्रेमवर्क के साथ उपयोग करें।

[एनवायरनमेंट बनाएँ](https://rea.tools/guides/rl-environments/) ·
[एनवायरनमेंट रेफ़रेंस](../agent-environments.md) ·
[X पर डेमो देखें](https://x.com/reatools/status/2112574822584918075?s=20)

### डेस्कटॉप ऐप एनवायरनमेंट

REA किसी Linux डेस्कटॉप ऐप का एनवायरनमेंट भी बना सकता है, जिसे एजेंट स्क्रीनशॉट, माउस और कीबोर्ड के ज़रिए उपयोग करता है। एक पंक्ति के अनुरोध से, जैसे "मेरे लिए एक Gnote एनवायरनमेंट बनाएँ जिसमें एजेंट शॉपिंग लिस्ट वाले नोट में जैतून का तेल जोड़ता है", आपका एजेंट एक स्थानीय बिल्ड कंप्यूटर पर ऐप इंस्टॉल करता है, टास्क लिखता है, एनवायरनमेंट एक्सपोर्ट करता है और एक नए कंप्यूटर पर टास्क की जाँच करता है। इसे बनाने वाली मशीन पर amd64 या arm64 वाला Linux, Docker और गाइड में तय किया गया agentenv फ़्रेमवर्क संस्करण होना चाहिए।

[डेस्कटॉप ऐप एनवायरनमेंट सेट अप करें](../desktop-build-computer.md)

## अक्सर पूछे जाने वाले प्रश्न

<details>
<summary><strong>कौन-से एजेंट REA का उपयोग कर सकते हैं?</strong></summary>

कोई भी एजेंट जो स्थानीय MCP सर्वर को सपोर्ट करता है। सेटअप
[समर्थित एजेंटों](../getting-started/installation.md#supported-agents) को कॉन्फ़िगर करता है;
अन्य क्लाइंट [मैन्युअल MCP रजिस्ट्रेशन](../getting-started/installation.md#mcp-registry)
का उपयोग कर सकते हैं।

</details>

<details>
<summary><strong>क्या मुझे नेटिव विश्लेषण इंजन की ज़रूरत है?</strong></summary>

गहन नेटिव विश्लेषण, लक्ष्य और ऑपरेशन के अनुसार, Hopper, Ghidra, IDA या Kuna का
उपयोग करता है। स्टैटिक JavaScript और .NET जाँच किसी नेटिव विश्लेषण इंजन के बिना काम
करती है। सेटअप आपकी स्वीकृति के बाद Hopper इंस्टॉल कर सकता है; Ghidra, IDA और Kuna के
लिए आपके मौजूदा इंस्टॉलेशन उपयोग होते हैं। विकल्पों और उनके समर्थित लक्ष्यों के लिए
[प्रोवाइडर सेटअप](../getting-started/installation.md#hopper) देखें।

</details>

<details>
<summary><strong>क्या मुझे पहले Hopper शुरू करना होगा?</strong></summary>

जब किसी ऑपरेशन को Hopper की ज़रूरत होती है, तो REA उसे शुरू कर देता है। macOS पर
पहली बार चलाने पर एक डायलॉग आपसे डेमो मोड चुनने या अपना लाइसेंस सक्रिय करने के लिए
कह सकता है। अपने पहले CLI/MCP ऑपरेशन या बिना निगरानी वाले जॉब से पहले, उसी उपयोगकर्ता
सेशन में यह प्रॉम्प्ट पूरा करें। ज़रूरत हो तो Hopper को मैन्युअल रूप से खोलें।
[Hopper स्टार्टअप और समस्या निवारण](../getting-started/installation.md#launcher-paths-and-troubleshooting)
देखें।

</details>

<details>
<summary><strong>skills.sh से स्किल इंस्टॉल करने पर क्या होता है?</strong></summary>

स्किल आपके एजेंट को जाँच करने के निर्देश देती है। REA का MCP सर्वर रजिस्टर करने और
मेल खाते निर्देश इंस्टॉल करने के लिए `npx rea-agents setup` का उपयोग करें, फिर अपने
एजेंट को रीस्टार्ट करें।
[केवल स्किल इंस्टॉलेशन](../getting-started/installation.md#skill-only-installation) देखें।

</details>

<details>
<summary><strong>REA कौन-सा कोड लौटाता है?</strong></summary>

नेटिव विश्लेषण स्यूडोकोड और असेंबली लौटाता है। JavaScript/Electron विश्लेषण मॉड्यूल
और उनके आपसी संबंध फिर से प्राप्त करता है। आपका एजेंट इन निष्कर्षों का उपयोग
इम्प्लीमेंटेशन लिखने और टेस्ट करने के लिए करता है; [उदाहरण](#उदाहरण) अनुभाग में
चरण-दर-चरण उदाहरण दिए गए हैं।

</details>

<details>
<summary><strong>क्या REA मेरा ऐप अपलोड करता है?</strong></summary>

REA लक्ष्यों का विश्लेषण स्थानीय रूप से करता है। आपके एजेंट को टूल के परिणाम मिलते
हैं, और उसके मॉडल प्रोवाइडर की अपनी डेटा नीति होती है।

</details>

<details>
<summary><strong>अगर मुझे कोई बग मिले तो मैं क्या करूँ?</strong></summary>

पहले अपडेट करें; हो सकता है कि हाल की कोई रिलीज़ उसे पहले ही ठीक कर चुकी हो।

`npm install --global` या `bun add --global` से इंस्टॉल किए गए CLI के लिए:

```bash
rea update
```

`npx` के ज़रिए एजेंट सेटअप के लिए:

```bash
npx rea-agents@latest setup
```

यदि आप किसी एजेंट का उपयोग कर रहे हैं, तो [सेटअप रीफ़्रेश](#rea-अपडेट-करें) पूरा करें
और उसे रीस्टार्ट करें। वही टास्क दोबारा आज़माएँ। अगर समस्या बनी रहती है, तो अपने REA
संस्करण, लक्ष्य के प्रकार, समस्या दोहराने के चरणों और एरर आउटपुट के साथ
[एक issue खोलें](https://github.com/morluto/rea/issues)।

</details>

## दस्तावेज़

वेबसाइट की [व्यावहारिक गाइड](https://rea.tools/guides/) से शुरुआत करें।
सटीक विकल्पों, पूर्व-आवश्यकताओं और परिणाम कॉन्ट्रैक्ट के लिए:

- [इंस्टॉलेशन और सेटअप](../getting-started/installation.md): एजेंट रजिस्ट्रेशन, प्रोवाइडर कॉन्फ़िगरेशन, अपडेट और अनइंस्टॉल।
- [तैयारी की जाँच और समस्या निवारण](../getting-started/installation.md#check-readiness-for-your-task): किसी एक एजेंट या विश्लेषण इंजन की समस्या का निदान।
- [CLI और Evidence](../getting-started/cli.md): कमांड, प्रोवाइडर चयन, स्नैपशॉट, इम्पोर्ट/एक्सपोर्ट और एग्ज़िट स्टेटस।
- [MCP कॉन्ट्रैक्ट](../reference/mcp-contracts.md) और [एजेंट प्रॉम्प्ट](../getting-started/mcp-prompts.md): टूल के परिणाम, सेशन और निर्देशित जाँच।
- [टूल कैटलॉग](../reference/mcp-contracts.md#generated-catalog): टूल, प्रोवाइडर और CLI कमांड की जनरेट की गई सूची।
- [रोडमैप](../development/roadmap.md): नियोजित काम और क्षमताओं के ट्रैकर।

सुरक्षा कमज़ोरियों की रिपोर्ट [SECURITY.md](../../SECURITY.md) के ज़रिए करें।

## स्टार इतिहास

🎉 **4,00,000 GitHub स्टार — धन्यवाद!**

REA का उपयोग करने, बग रिपोर्ट करने, फ़ीचर का अनुरोध करने, बिल्ड टेस्ट करने और फ़िक्स में योगदान देने वाले सभी लोगों का धन्यवाद।

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA का GitHub स्टार इतिहास" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## अस्वीकरण

ज़िम्मेदार उपयोग से जुड़े मार्गदर्शन के लिए [DISCLAIMER.md](../../DISCLAIMER.md) देखें।

अवैध या अनधिकृत उपयोग पर प्रोजेक्ट का रुख REA के सभी संस्करणों, वितरण चैनलों और
प्लेटफ़ॉर्म पर लागू होता है; हर प्रति पर उसके लागू लाइसेंस बने रहते हैं।

REA वैध शोध, शिक्षा, इंटरऑपरेबिलिटी, सॉफ़्टवेयर संरक्षण और ऐसे सॉफ़्टवेयर के
विश्लेषण के लिए है जिसके आप स्वामी हैं या जिसकी जाँच करने के लिए आप अधिकृत हैं।

## योगदान

REA में आपकी मदद का हमें इंतज़ार है! बग रिपोर्ट करने या कोई फ़ीचर सुझाने के लिए
[एक issue खोलें](https://github.com/morluto/rea/issues), या कोड या दस्तावेज़ सुधारने के
लिए [एक pull request भेजें](https://github.com/morluto/rea/pulls)।

डेवलपमेंट सेटअप और जाँचों के लिए [CONTRIBUTING.md](../../CONTRIBUTING.md), सत्यापन
लेन के लिए [टेस्टिंग](../development/testing.md), और चुनी गई लेयर और डिपेंडेंसी पाथ के
लिए [आर्किटेक्चर मैप](../architecture/architecture.mermaid) देखें।

## लाइसेंस

[MIT](../../LICENSE)

REA के लिए लिखा गया कोड MIT लाइसेंस के अंतर्गत है। तृतीय-पक्ष सामग्री अपने लाइसेंस और
कॉपीराइट नोटिस बनाए रखती है; डिपेंडेंसी सूची, सुरक्षित रखे गए लाइसेंस टेक्स्ट और बाहरी
टूल की शर्तों के लिए [तृतीय-पक्ष नोटिस](../../THIRD_PARTY_NOTICES.md) देखें।

**आपको व्यावसायिक टूल वैध रूप से प्राप्त करने होंगे और उनके लागू लाइसेंसों के अंतर्गत
उनका उपयोग करने के लिए अधिकृत होना होगा**, जिनमें IDA Pro / Hex-Rays डीकंपाइलर, Hopper
और JEB शामिल हैं। REA कोई टूल लाइसेंस, कुंजी या एक्टिवेशन का अधिकार नहीं देता। ट्रायल और
डेमो संस्करण विक्रेता की शर्तों के अधीन रहते हैं, जिनमें उपयोगकर्ता, फ़ीचर, ऑटोमेशन और
आउटपुट साझा करने से जुड़े प्रतिबंध शामिल हैं। क्रैक की गई प्रतियाँ, चुराई गई कुंजियाँ,
कुंजियों को अनधिकृत रूप से साझा करना और लाइसेंस प्रतिबंधों को दरकिनार करना अधिकृत नहीं
है। यह मार्गदर्शन MIT या तृतीय-पक्ष लाइसेंसों में कोई संशोधन नहीं करता।
