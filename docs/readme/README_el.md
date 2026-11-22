<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · **Ελληνικά** · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md) · [বাংলা](README_bn.md)

# REA: Reverse Engineer Anything

### Ένα MCP για αντίστροφη μηχανική δυαδικών αρχείων, εφαρμογών και της συμπεριφοράς τους κατά την εκτέλεση.

**Βρήκες μια λειτουργία που σου αρέσει; Μάθε πώς λειτουργεί, μέχρι το επίπεδο του δυαδικού κώδικα.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![Άδεια MIT](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Ιστότοπος](https://rea.tools/) · [Οδηγοί](https://rea.tools/guides/) · [Μελέτες περίπτωσης](https://rea.tools/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Έλα στην κοινότητα REA στο Discord" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Γρήγορη εκκίνηση](#γρήγορη-εκκίνηση) · [Μελέτες περίπτωσης](#μελέτες-περίπτωσης) · [Πώς λειτουργεί το REA](#πώς-λειτουργεί-το-rea) · [Τι μπορείς να αναλύσεις](#τι-μπορείς-να-αναλύσεις) · [Δημιουργία περιβαλλόντων RL](#build-rl-environments) · [Συχνές ερωτήσεις](#συχνές-ερωτήσεις) · [Τεκμηρίωση](#τεκμηρίωση)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> Κατέβασε το REA από το [morluto/rea](https://github.com/morluto/rea),
> το [rea.tools](https://rea.tools/) ή το [πακέτο rea-agents στο npm](https://www.npmjs.com/package/rea-agents).
> Ακολούθησε τους συνδέσμους εγκατάστασης και εκδόσεων από αυτές τις επίσημες πηγές.
> Ένα παρόμοιο όνομα αποθετηρίου ή ένα αντιγραμμένο README δεν αποδεικνύει ότι
> ένα αρχείο προς λήψη προέρχεται από επίσημη πηγή.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="Το REA ξεκινά τη γέφυρα ανάλυσής του μέσα στο Hopper κατά την εξέταση ενός δυαδικού αρχείου με κώδικα μηχανής" width="1200" />

<br /><br />

<table aria-label="Κοινότητα REA">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Έλα στην κοινότητα αντίστροφης μηχανικής</strong>
  </a><br />
  <sub>Discord · Ερωτήσεις και απαντήσεις · Παρουσίαση έργων</sub>
</td>
</tr>
</table>

<br />

</div>

---

Είδες σε μια εφαρμογή μια λειτουργία που θα ήθελες στο δικό σου προϊόν; Ζήτησε από τον πράκτορά σου (agent) να τη διερευνήσει με το REA. Μπορεί να εξετάσει την εφαρμογή χωρίς τον πηγαίο κώδικά της, να εξηγήσει πώς λειτουργεί η συγκεκριμένη δυνατότητα, να παρουσιάσει τα τεκμήρια και να υλοποιήσει μια αντίστοιχη έκδοση για το έργο σου.

Το REA συνδέει τον πράκτορά σου με εργαλεία εξέτασης δυαδικών αρχείων με κώδικα μηχανής, εφαρμογών JavaScript και Electron, assemblies .NET και ιστοτόπων. Μπορείς να χρησιμοποιήσεις τα ίδια εργαλεία και από το τερματικό. Η ανάλυση εκτελείται τοπικά και τα αποτελέσματα περιλαμβάνουν τα τεκμήρια και τους περιορισμούς στους οποίους βασίζεται κάθε συμπέρασμα.

Η διαδικασία εγκατάστασης καταχωρίζει το REA στον agent σου και εγκαθιστά τις αντίστοιχες οδηγίες εργασίας. Για ανάλυση κώδικα μηχανής μπορείς να χρησιμοποιήσεις μια υπάρχουσα εγκατάσταση του Hopper, του Ghidra, του IDA ή του Kuna. Η διαδικασία εγκατάστασης μπορεί επίσης να εγκαταστήσει το Hopper, εφόσον το εγκρίνεις. Η στατική ανάλυση JavaScript δεν χρειάζεται μηχανή ανάλυσης κώδικα μηχανής.

## Γρήγορη εκκίνηση

**[Γρήγορη εκκίνηση · rea.tools](https://rea.tools/el/get-started/)**

### Ρύθμιση του agent σου (MCP)

Αφού εγκαταστήσεις [Node.js και npm](../reference/supported-targets.md), εκτέλεσε την εντολή από έναν έμπιστο κατάλογο έξω από το έργο που θα αναλύσεις.

```bash
npx rea-agents setup
```

Επίλεξε τους agents σου, έλεγξε τις προτεινόμενες αλλαγές και ενέκρινέ τες. Η διαδικασία προσθέτει τον MCP server του REA και τις αντίστοιχες οδηγίες εργασίας, κρατώντας αντίγραφα ασφαλείας των υφιστάμενων ρυθμίσεων. Στη συνέχεια, επανεκκίνησε τον agent σου.

[εγκατάστασης και ρύθμισης](../getting-started/installation.md)

Ζήτησε από τον agent σου:

```text
Διερεύνησε πώς λειτουργεί η αναζήτηση στην εφαρμογή Notes, δείξε μου τα τεκμήρια και υλοποίησε μια παρόμοια λειτουργία για το έργο μου.
```

Αντικατάστησε το Notes με την εφαρμογή που θέλεις να εξετάσεις και προσδιόρισε τη λειτουργία που θέλεις να κατανοήσεις.

### Χρήση από το τερματικό (CLI)

Εξέτασε τον αποσυμπιεσμένο φάκελο μιας εφαρμογής JavaScript/Electron ή ένα αρχείο ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Το αποτέλεσμα περιλαμβάνει modules, εισαγωγές, τα όρια μεταξύ των μερών της εφαρμογής Electron και τα αντίστοιχα τεκμήρια. Αντικατάστησε τη διαδρομή με τη δική σου, για παράδειγμα `"D:/apps/example"` στα Windows.

Για να εγκαταστήσεις την εντολή `rea` για τακτική χρήση:

```bash
npm install --global rea-agents
rea --help
```

Για ανάλυση κώδικα μηχανής, ρύθμισε πρώτα έναν πάροχο ανάλυσης. Ο [οδηγός CLI και Evidence](../getting-started/cli.md) περιγράφει τις σχετικές εντολές, την επιλογή παρόχου, τα στιγμιότυπα και τη χρήση σε scripts.

[Απαιτήσεις για Linux](../getting-started/installation.md#linux-owned-process-prerequisite)

### Ενημέρωση του REA

Για CLI εγκατεστημένο με `npm install --global` ή `bun add --global`:

```bash
rea update
```

Αν χρησιμοποιείς `npx`, ενημέρωσε τη ρύθμιση του agent με:

```bash
npx rea-agents@latest setup
```

[Ενημέρωση και απεγκατάσταση](../getting-started/installation.md#diagnose-update-and-remove)

## Μελέτες περίπτωσης

<a href="https://rea.tools/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="Εικονογραφήσεις των μελετών περίπτωσης για τη στερεοφωνική τοποθέτηση ήχου στο DX-Ball, τη γέφυρα προχείρου του Notion και τον δακτύλιο βλημάτων του TH04" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: ανακατασκευή υπολογισμού στερεοφωνικής τοποθέτησης ήχου</h3>
<p>Ακολούθησε μια κλήση ήχου μέχρι τη βοηθητική συνάρτηση που μετατρέπει τη θέση σε στερεοφωνική τοποθέτηση, εξέτασε τις εντολές και μετέτρεψε τον ελλιπή ψευδοκώδικα σε C. Η ανακατασκευή περνά 3.205 δοκιμές με τον αρχικό κώδικα x86 και αναπαράγει και τα 63 bytes της μεταγλωττισμένης συνάρτησης.</p>
<p><a href="https://rea.tools/showcase/dx-ball/">Διάβασε τη μελέτη περίπτωσης</a> · <a href="https://github.com/N0zoM1z0/dx-ball">Αποθετήριο ανακατασκευής</a></p>
</td></tr>
<tr><td>
<h3>Notion: ιχνηλάτηση της γέφυρας προχείρου στο Electron</h3>
<p>Βρες το API προχείρου του renderer, ακολούθησέ το μέσω του preload και του IPC μέχρι την κύρια διεργασία και εξέτασε τη μορφή εμπλουτισμένου περιεχομένου του προχείρου.</p>
<p><a href="https://rea.tools/showcase/notion/">Διάβασε τη μελέτη περίπτωσης</a></p>
</td></tr>
<tr><td>
<h3>TH04: ανάκτηση υπολογισμού δακτυλίου βλημάτων σε DOS</h3>
<p>Εξέτασε τις εντολές 16 bit του αρχικού παιχνιδιού για PC-98, ανέκτησε τους υπολογισμούς σταθερών γωνιών και γωνιών στόχευσης και σύγκρινε τον ανακατασκευασμένο κώδικα C++ με την έξοδο του μεταγλωττιστή της εποχής.</p>
<p><a href="https://rea.tools/showcase/th04/">Διάβασε τη μελέτη περίπτωσης</a> · <a href="https://github.com/N0zoM1z0/th04">Αποθετήριο ανακατασκευής</a></p>
</td></tr>
</tbody>
</table>

Αν χρησιμοποίησες το REA για κάτι ενδιαφέρον, θα θέλαμε να το δούμε. Μοιράσου τη μελέτη σου σε ένα [issue](https://github.com/morluto/rea/issues) ή [pull request](https://github.com/morluto/rea/pulls), αναφέροντας τον στόχο, το ερώτημά σου, πώς βοήθησε το REA και τι ανακάλυψες.

## Πώς λειτουργεί το REA

Ο agent σου καλεί το REA μέσω MCP για να εξετάσει τον στόχο και να ακολουθήσει τον σχετικό κώδικα. Το REA επιστρέφει ευρήματα μαζί με τα τεκμήριά τους. Ο agent τα χρησιμοποιεί για να θέσει πρόσθετες ερωτήσεις, να εξηγήσει τη συμπεριφορά ή να γράψει και να δοκιμάσει μια υλοποίηση. Οι εντολές CLI χρησιμοποιούν τις ίδιες ροές εργασίας.

![Ροή διερεύνησης του REA: ο agent σου θέτει ένα ερώτημα για έναν τοπικό στόχο, το REA τον εξετάζει και ακολουθεί τον κώδικά του με εργαλεία ανάλυσης, και ο agent χρησιμοποιεί τον κώδικα, τις αναφορές και τα άγνωστα στοιχεία που επιστρέφονται για να εξηγήσει, να υλοποιήσει και να δοκιμάσει.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Άνοιγμα του διαγράμματος σε πλήρες μέγεθος](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Τι μπορείς να αναλύσεις

Δυαδικά αρχεία με κώδικα μηχανής · JavaScript / Electron · Ιστότοποι · Assemblies .NET · APK Android · Firmware · Συμπεριφορά διεργασιών

[Υποστηριζόμενοι τύποι και απαιτήσεις](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[Επιλογή παρόχου ανάλυσης](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## Δημιουργία περιβαλλόντων RL

Δημιούργησε ένα τοπικό περιβάλλον από καταγεγραμμένη συνεδρία ιστού ή εφαρμογή επιφάνειας εργασίας Linux, ώστε ένας πράκτορας να μπορεί να εξασκείται σε μια εργασία και να ελέγχει το αποτέλεσμα.

[Δημιουργία περιβαλλόντων RL](https://rea.tools/guides/rl-environments/)

## Συχνές ερωτήσεις

<details>
<summary><strong>Ποιοι agents μπορούν να χρησιμοποιήσουν το REA;</strong></summary>

Κάθε agent που υποστηρίζει τοπικούς MCP servers. Η διαδικασία εγκατάστασης ρυθμίζει τους [υποστηριζόμενους agents](../getting-started/installation.md#supported-agents). Οι υπόλοιποι clients μπορούν να χρησιμοποιήσουν τη [μη αυτόματη καταχώριση MCP](../getting-started/installation.md#mcp-registry).

</details>

<details>
<summary><strong>Χρειάζομαι Hopper, Ghidra, IDA ή Kuna;</strong></summary>

Η εις βάθος ανάλυση κώδικα μηχανής χρησιμοποιεί ένα από αυτά. Η στατική εξέταση JavaScript και .NET λειτουργεί χωρίς μηχανή ανάλυσης κώδικα μηχανής. Η διαδικασία εγκατάστασης μπορεί να εγκαταστήσει το Hopper μετά την έγκρισή σου· το Ghidra, το IDA και το Kuna χρησιμοποιούν τις υπάρχουσες εγκαταστάσεις σου. Δες τη [ρύθμιση παρόχων ανάλυσης](../getting-started/installation.md#hopper).

</details>

<details>
<summary><strong>Πρέπει να ξεκινήσω πρώτα το Hopper;</strong></summary>

Το REA ξεκινά το Hopper όταν το χρειάζεται κάποια λειτουργία. Στο macOS, κατά την πρώτη εκκίνηση μπορεί να εμφανιστεί παράθυρο που ζητά να επιλέξεις τη δοκιμαστική λειτουργία ή να ενεργοποιήσεις την άδειά σου. Ολοκλήρωσε αυτό το βήμα στην ίδια συνεδρία χρήστη πριν από την πρώτη λειτουργία CLI/MCP ή εργασία χωρίς επίβλεψη. Άνοιξε το Hopper χειροκίνητα αν χρειαστεί. Δες την [εκκίνηση και αντιμετώπιση προβλημάτων του Hopper](../getting-started/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>Τι προσφέρει η εγκατάσταση του skill από το skills.sh;</strong></summary>

Το skill παρέχει οδηγίες διερεύνησης για τον agent σου. Χρησιμοποίησε `npx rea-agents setup` για να καταχωρίσεις τον MCP server του REA και να εγκαταστήσεις τις αντίστοιχες οδηγίες. Στη συνέχεια, επανεκκίνησε τον agent σου. Δες την [εγκατάσταση μόνο του skill](../getting-started/installation.md#skill-only-installation).

</details>

<details>
<summary><strong>Τι κώδικα επιστρέφει το REA;</strong></summary>

Η ανάλυση κώδικα μηχανής επιστρέφει ψευδοκώδικα και assembly. Η ανάλυση JavaScript/Electron ανακτά modules και τις σχέσεις τους. Ο agent σου χρησιμοποιεί αυτά τα ευρήματα για να γράψει και να δοκιμάσει μια υλοποίηση. Οι [μελέτες περίπτωσης](#μελέτες-περίπτωσης) παρουσιάζουν ολοκληρωμένα παραδείγματα.

</details>

<details>
<summary><strong>Το REA ανεβάζει την εφαρμογή μου στο διαδίκτυο;</strong></summary>

Το REA αναλύει τους στόχους τοπικά. Ο agent σου λαμβάνει τα αποτελέσματα των εργαλείων και ο πάροχος του μοντέλου του έχει τη δική του πολιτική δεδομένων.

</details>

<details>
<summary><strong>Τι να κάνω αν συναντήσω κάποιο σφάλμα;</strong></summary>

Κάνε πρώτα ενημέρωση· μια πρόσφατη έκδοση μπορεί να το έχει ήδη διορθώσει.

Για CLI εγκατεστημένο με `npm install --global` ή `bun add --global`:

```bash
rea update
```

Για ρύθμιση agent μέσω `npx`:

```bash
npx rea-agents@latest setup
```

Αν χρησιμοποιείς agent, ολοκλήρωσε την [ανανέωση της ρύθμισης](#ενημέρωση-του-rea) και επανεκκίνησέ τον. Δοκίμασε ξανά την ίδια εργασία. Αν το πρόβλημα παραμένει, [άνοιξε ένα issue](https://github.com/morluto/rea/issues) με την έκδοση του REA, τον τύπο του στόχου, τα βήματα αναπαραγωγής και την έξοδο του σφάλματος.

</details>

## Τεκμηρίωση

Ξεκίνα από τους [οδηγούς με ολοκληρωμένα παραδείγματα](https://rea.tools/guides/) στον ιστότοπο. Για τις ακριβείς επιλογές, τις προϋποθέσεις και τις προδιαγραφές των αποτελεσμάτων:

- [Εγκατάσταση και ρύθμιση](../getting-started/installation.md): καταχώριση agents, ρύθμιση παρόχων ανάλυσης, ενημερώσεις και απεγκατάσταση.
- [Έλεγχος ετοιμότητας και αντιμετώπιση προβλημάτων](../getting-started/installation.md#check-readiness-for-your-task): διάγνωση ενός agent ή μιας μηχανής ανάλυσης.
- [CLI και Evidence](../getting-started/cli.md): εντολές, επιλογή παρόχου, στιγμιότυπα, εισαγωγή/εξαγωγή και κωδικοί εξόδου.
- [Προδιαγραφές MCP](../reference/mcp-contracts.md) και [prompts για agents](../getting-started/mcp-prompts.md): αποτελέσματα εργαλείων, συνεδρίες και καθοδηγούμενες διερευνήσεις.
- [Κατάλογος εργαλείων](../reference/mcp-contracts.md#generated-catalog): αυτόματα παραγόμενος κατάλογος εργαλείων, παρόχων και εντολών CLI.

Ανάφερε ευπάθειες ακολουθώντας το [SECURITY.md](../../SECURITY.md).

## Κοινότητα και υποστήριξη

- **Discord** — Κάνε ερωτήσεις και μοιράσου την έρευνά σου με περισσότερους από 50.000 ανθρώπους που αγαπούν την αντίστροφη μηχανική και δημιουργούν δικά τους έργα! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Ακολούθησε το [@reatools](https://x.com/reatools) για νέα.
- **Σχόλια και ιδέες** — Θέλεις μια λειτουργία ή υποστήριξη για κάποιον τύπο αρχείου; Γράψε μας στο [GitHub](https://github.com/morluto/rea/issues) ή στο [Discord](https://discord.gg/GkcryMnJDM).

## Ιστορικό αστεριών

🎉 **400.000 αστέρια στο GitHub — σας ευχαριστούμε!**

Ευχαριστούμε όλους όσοι χρησιμοποιούν το REA, αναφέρουν σφάλματα, ζητούν νέες λειτουργίες, δοκιμάζουν builds και συνεισφέρουν διορθώσεις.

<a href="https://rea.tools/el/contributors/">
  <img src="../../website/public/contributors/avatars.png" alt="Όσοι συνεισφέρουν στο REA" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="Ιστορικό αστεριών του REA στο GitHub" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Συνεισφορά

Θα χαρούμε να βοηθήσεις στο REA! [Άνοιξε ένα issue](https://github.com/morluto/rea/issues) για να αναφέρεις ένα σφάλμα ή να προτείνεις μια λειτουργία, ή [στείλε ένα pull request](https://github.com/morluto/rea/pulls) για να βελτιώσεις τον κώδικα ή την τεκμηρίωση.

Δες το [CONTRIBUTING.md](../../CONTRIBUTING.md) για τη ρύθμιση του περιβάλλοντος ανάπτυξης και τους ελέγχους, τον [οδηγό δοκιμών](../development/testing.md) για τις διαδικασίες επαλήθευσης.

## Αποποίηση ευθύνης

Δες το [DISCLAIMER.md](../../DISCLAIMER.md) για οδηγίες υπεύθυνης χρήσης.

Η θέση του έργου σχετικά με την παράνομη ή μη εξουσιοδοτημένη χρήση ισχύει για όλες τις εκδόσεις του REA, τα κανάλια διανομής και τις πλατφόρμες. Κάθε αντίγραφο διατηρεί τις άδειες που το διέπουν.

Το REA προορίζεται για νόμιμη έρευνα, εκπαίδευση, διαλειτουργικότητα, διατήρηση λογισμικού και ανάλυση λογισμικού που σου ανήκει ή για το οποίο έχεις άδεια εξέτασης.

## Άδεια χρήσης

[MIT](../../LICENSE)

Ο κώδικας που έχει δημιουργηθεί για το REA διατίθεται με την άδεια MIT. Το υλικό τρίτων διατηρεί τις δικές του άδειες και δηλώσεις πνευματικών δικαιωμάτων. Δες τις [δηλώσεις για υλικό τρίτων](../../THIRD_PARTY_NOTICES.md) για τον κατάλογο εξαρτήσεων, τα διατηρημένα κείμενα αδειών και τους όρους των εξωτερικών εργαλείων.

**Πρέπει να αποκτήσεις νόμιμα τα εμπορικά εργαλεία και να έχεις δικαίωμα χρήσης τους**, συμπεριλαμβανομένων των IDA Pro / Hex-Rays decompilers, Hopper και JEB, σύμφωνα με τις αντίστοιχες άδειές τους. Το REA δεν παρέχει άδεια εργαλείου, κλειδί ή δικαίωμα ενεργοποίησης. Οι δοκιμαστικές εκδόσεις και τα demos εξακολουθούν να υπόκεινται στους όρους του προμηθευτή, συμπεριλαμβανομένων των περιορισμών χρήστη, λειτουργιών, αυτοματοποίησης και κοινοποίησης αποτελεσμάτων. Δεν επιτρέπονται σπασμένες εκδόσεις, κλεμμένα κλειδιά, μη εξουσιοδοτημένη κοινοποίηση κλειδιών ή παράκαμψη περιορισμών αδειοδότησης. Αυτές οι οδηγίες δεν τροποποιούν την άδεια MIT ή τις άδειες τρίτων.
