<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · **Tiếng Việt** · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)
· [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · [Roman Urdu](README_ur-Latn.md) · [Română](README_ro.md) · [Български](README_bg.md)

# REA: Kỹ thuật dịch ngược cho mọi thứ

### Một MCP để dịch ngược tệp nhị phân, ứng dụng và hành vi khi chạy.

**Thấy một tính năng bạn thích? Hiểu cách nó hoạt động, đến tận mức mã nhị phân.**

[![GitHub stars](https://img.shields.io/github/stars/morluto/rea?style=flat-square&logo=github)](https://github.com/morluto/rea/stargazers)
[![Monthly npm downloads](https://img.shields.io/npm/dm/rea-agents?style=flat-square&label=npm%20downloads)](https://www.npmjs.com/package/rea-agents)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Join the REA Discord](https://img.shields.io/badge/Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
[![Follow REA on X](https://img.shields.io/badge/X-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/reatools)
[![Supported platforms: macOS, Windows, and Linux](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square)](../getting-started/installation.md)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)

**[Trang web](https://rea.tools/vi/) · [Hướng dẫn](https://rea.tools/vi/guides/) · [Các nghiên cứu điển hình](https://rea.tools/vi/showcase/)**

<a href="https://discord.com/invite/GkcryMnJDM"><img alt="Tham gia cộng đồng REA trên Discord" src="https://img.shields.io/badge/Join%20us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="40"></a>

[Bắt đầu nhanh](#bắt-đầu-nhanh) · [Các nghiên cứu điển hình](#các-nghiên-cứu-điển-hình) · [Cách REA hoạt động](#cách-rea-hoạt-động) · [Những gì bạn có thể phân tích](#những-gì-bạn-có-thể-phân-tích) · [Xây dựng môi trường RL](#build-rl-environments) · [Câu hỏi thường gặp](#câu-hỏi-thường-gặp) · [Tài liệu](#tài-liệu)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> Các nguồn chính thức của REA: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents](https://www.npmjs.com/package/rea-agents) (npm).
> Hãy dùng các liên kết cài đặt và bản phát hành từ những nguồn chính thức này. Tên kho mã tương tự hoặc README được sao chép không chứng minh rằng tệp tải xuống là bản chính thức.

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA khởi chạy cầu nối phân tích bên trong Hopper khi kiểm tra tệp nhị phân mã máy" width="1200" />

<br /><br />

<table aria-label="Cộng đồng REA">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Tham gia cộng đồng kỹ thuật dịch ngược</strong>
  </a><br />
  <sub>Discord · Hỏi đáp · Chia sẻ kết quả</sub>
</td>
</tr>
</table>

<br />

</div>

---

Bạn thấy một tính năng trong ứng dụng và muốn đưa nó vào sản phẩm của mình? Hãy nhờ tác nhân của bạn điều tra bằng REA. Tác nhân có thể kiểm tra ứng dụng mà không cần mã nguồn, giải thích cách tính năng hoạt động, đưa ra bằng chứng và xây dựng một phiên bản cho dự án của bạn.

REA kết nối tác nhân của bạn với các công cụ kiểm tra tệp nhị phân mã máy, ứng dụng JavaScript và Electron, assembly .NET và trang web. Bạn cũng có thể dùng các công cụ đó từ terminal. Việc phân tích chạy cục bộ; kết quả bao gồm bằng chứng và giới hạn làm cơ sở cho từng kết luận.

Thiết lập đăng ký REA với tác nhân và cài hướng dẫn công việc tương ứng. Phân tích native dùng Hopper, Ghidra, IDA hoặc Kuna có sẵn; có thể cài Hopper sau khi bạn chấp thuận. Phân tích tĩnh JavaScript không cần công cụ phân tích native.

## Bắt đầu nhanh

**[Bắt đầu nhanh · rea.tools](https://rea.tools/vi/get-started/)**

### Thiết lập tác nhân (MCP)

Sau khi cài [Node.js và npm](../reference/supported-targets.md), chạy lệnh sau từ một thư mục đáng tin cậy bên ngoài dự án cần phân tích.

```bash
npx rea-agents setup
```

Chọn các tác nhân, xem lại những thay đổi được đề xuất và chấp thuận. Quá trình thiết lập thêm máy chủ MCP của REA cùng hướng dẫn quy trình tương ứng, đồng thời sao lưu cấu hình hiện có. Sau đó khởi động lại tác nhân.

[cài đặt và thiết lập](../getting-started/installation.md)

Hỏi tác nhân:

```text
Tìm hiểu cách tính năng tìm kiếm trong ứng dụng Notes hoạt động, cho tôi xem bằng chứng và xây dựng tính năng tương tự cho dự án của tôi.
```

Thay Notes bằng ứng dụng mục tiêu và chỉ rõ tính năng bạn muốn hiểu.

### Sử dụng terminal (CLI)

Kiểm tra thư mục ứng dụng JavaScript/Electron đã giải nén hoặc tệp ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Kết quả bao gồm mô-đun, các khai báo import, ranh giới Electron và bằng chứng tương ứng. Thay đường dẫn bằng mục tiêu của bạn, chẳng hạn `"D:/apps/example"` trên Windows.

Để cài lệnh `rea` cho việc sử dụng thường xuyên:

```bash
npm install --global rea-agents
rea --help
```

Để phân tích mã máy, trước tiên hãy cấu hình trình phân tích. Xem [hướng dẫn CLI và Evidence](../getting-started/cli.md) về các lệnh phân tích mã máy, lựa chọn trình phân tích, ảnh chụp trạng thái và sử dụng trong script.

[Yêu cầu trên Linux](../getting-started/installation.md#linux-owned-process-prerequisite)

### Cập nhật REA

Với CLI được cài bằng `npm install --global` / `bun add --global`:

```bash
rea update
```

Nếu dùng `npx`, cập nhật thiết lập tác nhân bằng:

```bash
npx rea-agents@latest setup
```

[Cập nhật và gỡ cài đặt](../getting-started/installation.md#diagnose-update-and-remove)

## Các nghiên cứu điển hình

<a href="https://rea.tools/vi/showcase/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/rea-showcases-dark.svg" />
    <img alt="Minh họa các ví dụ về cân bằng âm thanh DX-Ball, cầu nối bảng nhớ tạm Notion và vòng đạn TH04" src="../assets/rea-showcases.svg" />
  </picture>
</a>

<table>
<tbody>
<tr><td>
<h3>DX-Ball: tái tạo phép tính phân bố âm thanh trái phải</h3>
<p>Lần theo lời gọi âm thanh đến hàm hỗ trợ chuyển vị trí thành giá trị phân bố âm thanh, kiểm tra các lệnh và chuyển mã giả chưa đầy đủ sang C. Bản tái tạo vượt qua 3.205 trường hợp kiểm thử với x86 gốc và tái tạo đủ 63 byte của hàm đã biên dịch.</p>
<p><a href="https://rea.tools/vi/showcase/dx-ball/">Đọc nghiên cứu điển hình</a> · <a href="https://github.com/N0zoM1z0/dx-ball">Kho mã tái tạo</a></p>
</td></tr>
<tr><td>
<h3>Notion: lần theo cầu nối clipboard của Electron</h3>
<p>Tìm API clipboard trong tiến trình kết xuất, lần theo qua preload và IPC đến tiến trình chính, rồi kiểm tra định dạng clipboard có dữ liệu định dạng phong phú.</p>
<p><a href="https://rea.tools/vi/showcase/notion/">Đọc nghiên cứu điển hình</a></p>
</td></tr>
<tr><td>
<h3>TH04: khôi phục phép tính vòng đạn trong DOS</h3>
<p>Kiểm tra các lệnh 16 bit của trò chơi PC-98 gốc, khôi phục phép tính góc cố định và góc nhắm mục tiêu, rồi so sánh C++ được tái tạo với đầu ra của trình biên dịch thời đó.</p>
<p><a href="https://rea.tools/vi/showcase/th04/">Đọc nghiên cứu điển hình</a> · <a href="https://github.com/N0zoM1z0/th04">Kho mã tái tạo</a></p>
</td></tr>
</tbody>
</table>

Nếu bạn dùng REA cho một mục tiêu thú vị, chúng tôi muốn biết. Chia sẻ trường hợp của bạn qua [issue](https://github.com/morluto/rea/issues) hoặc [pull request](https://github.com/morluto/rea/pulls), nêu mục tiêu, câu hỏi, cách REA giúp bạn và những gì tìm được.

## Cách REA hoạt động

Tác nhân gọi REA qua MCP để kiểm tra mục tiêu và lần theo mã liên quan. REA trả về các phát hiện kèm bằng chứng. Tác nhân dùng chúng để đặt câu hỏi tiếp theo, giải thích hành vi hoặc viết và kiểm thử một cách triển khai. Các lệnh CLI sử dụng cùng quy trình.

![Quy trình điều tra của REA: tác nhân hỏi về mục tiêu cục bộ, REA kiểm tra và lần theo mục tiêu bằng công cụ phân tích, rồi tác nhân dùng mã, tham chiếu và những điểm chưa biết được trả về để giải thích, triển khai và kiểm thử.](../../website/public/assets/figures/rea-investigation-flow.svg)

[Mở hình ở kích thước đầy đủ](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## Những gì bạn có thể phân tích

Tệp nhị phân mã máy · JavaScript / Electron · Trang web · Assembly .NET · APK Android · Phần sụn · Hành vi tiến trình

[Định dạng được hỗ trợ và yêu cầu](../reference/supported-targets.md)

<a id="choosing-a-deep-analysis-provider"></a>

[Chọn công cụ phân tích](../reference/supported-targets.md#choosing-a-deep-analysis-provider)

<a id="build-rl-environments"></a>

## Xây dựng môi trường RL

Tạo môi trường cục bộ từ phiên web đã ghi hoặc ứng dụng máy tính Linux để tác tử thực hành một nhiệm vụ và kiểm tra kết quả.

[Xây dựng môi trường RL](https://rea.tools/guides/rl-environments/)

## Câu hỏi thường gặp

<details>
<summary><strong>Tác nhân nào có thể dùng REA?</strong></summary>

Bất kỳ tác nhân nào hỗ trợ máy chủ MCP cục bộ. Quá trình thiết lập cấu hình các [tác nhân được hỗ trợ](../getting-started/installation.md#supported-agents); ứng dụng khách khác có thể dùng [đăng ký MCP thủ công](../getting-started/installation.md#mcp-registry).

</details>

<details>
<summary><strong>Tôi có cần Hopper, Ghidra, IDA hoặc Kuna không?</strong></summary>

Phân tích mã máy chuyên sâu sử dụng một trong những công cụ đó. Kiểm tra tĩnh JavaScript và .NET hoạt động mà không cần bộ máy phân tích mã máy. Quá trình thiết lập có thể cài Hopper sau khi được chấp thuận; Ghidra, IDA và Kuna dùng bản cài đặt sẵn có. Xem [thiết lập trình phân tích](../getting-started/installation.md#hopper).

</details>

<details>
<summary><strong>Tôi có cần khởi chạy Hopper trước không?</strong></summary>

REA khởi chạy Hopper khi một thao tác cần đến nó. Trên macOS, hộp thoại lần chạy đầu có thể yêu cầu chọn chế độ dùng thử hoặc kích hoạt giấy phép. Xem [khởi động Hopper và khắc phục sự cố](../getting-started/installation.md#launcher-paths-and-troubleshooting).

</details>

<details>
<summary><strong>Cài skill từ skills.sh có tác dụng gì?</strong></summary>

Skill cung cấp hướng dẫn điều tra cho tác nhân. Dùng `npx rea-agents setup` để đăng ký máy chủ MCP của REA và cài hướng dẫn tương ứng, sau đó khởi động lại tác nhân. Xem [chỉ cài skill](../getting-started/installation.md#skill-only-installation).

</details>

<details>
<summary><strong>REA trả về mã gì?</strong></summary>

Phân tích mã máy trả về mã giả và hợp ngữ. Phân tích JavaScript/Electron khôi phục mô-đun cùng quan hệ giữa chúng. Tác nhân dùng các phát hiện này để viết và kiểm thử cách triển khai; các [nghiên cứu điển hình](#các-nghiên-cứu-điển-hình) cung cấp ví dụ thực hành.

</details>

<details>
<summary><strong>REA có tải ứng dụng của tôi lên không?</strong></summary>

REA phân tích mục tiêu cục bộ. Tác nhân nhận kết quả công cụ, và nhà cung cấp mô hình của tác nhân có chính sách dữ liệu riêng.

</details>

<details>
<summary><strong>Tôi nên làm gì khi gặp lỗi?</strong></summary>

Hãy cập nhật trước; một bản phát hành gần đây có thể đã sửa lỗi.

Với CLI được cài bằng npm:

```bash
rea update
```

Với thiết lập tác nhân qua `npx`:

```bash
npx rea-agents@latest setup
```

Nếu dùng tác nhân, hãy hoàn tất [làm mới thiết lập](#cập-nhật-rea) và khởi động lại nó. Thử lại cùng tác vụ. Nếu vấn đề vẫn còn, [mở issue](https://github.com/morluto/rea/issues) với phiên bản REA, loại mục tiêu, các bước tái hiện và đầu ra lỗi.

</details>

## Tài liệu

Bắt đầu với [hướng dẫn thực hành](https://rea.tools/vi/guides/) trên trang web. Để biết tùy chọn cụ thể, điều kiện tiên quyết và hợp đồng kết quả:

- [Cài đặt và thiết lập](../getting-started/installation.md): đăng ký tác nhân, cấu hình trình phân tích, cập nhật và gỡ cài đặt.
- [Kiểm tra mức sẵn sàng và khắc phục sự cố](../getting-started/installation.md#check-readiness-for-your-task): chẩn đoán một tác nhân hoặc bộ máy phân tích cụ thể.
- [CLI và Evidence](../getting-started/cli.md): lệnh, lựa chọn trình phân tích, ảnh chụp trạng thái, nhập/xuất và trạng thái thoát.
- [Hợp đồng MCP](../reference/mcp-contracts.md) và [prompt cho tác nhân](../getting-started/mcp-prompts.md): kết quả công cụ, phiên làm việc và điều tra có hướng dẫn.
- [Danh mục công cụ](../reference/mcp-contracts.md#generated-catalog): danh sách công cụ, trình phân tích và lệnh CLI được tạo khi dựng dự án.

Báo cáo lỗ hổng theo [SECURITY.md](../../SECURITY.md).

## Cộng đồng và hỗ trợ

- **Discord** — Hãy đặt câu hỏi và chia sẻ những gì bạn đang tìm hiểu với cộng đồng hơn 50.000 người đam mê kỹ thuật đảo ngược và xây dựng các dự án mới! [![Discord](https://img.shields.io/badge/Join%20Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/GkcryMnJDM)
- **Twitter / X** — Theo dõi [@reatools](https://x.com/reatools) để nhận tin mới.
- **Góp ý và ý tưởng** — Bạn muốn thêm tính năng hoặc hỗ trợ một định dạng tệp? Hãy cho chúng tôi biết qua [GitHub](https://github.com/morluto/rea/issues) hoặc [Discord](https://discord.gg/GkcryMnJDM).

## Lịch sử sao

🎉 **400.000 sao trên GitHub — xin cảm ơn!**

Cảm ơn mọi người đã sử dụng REA, báo lỗi, đề xuất tính năng, kiểm thử bản dựng và đóng góp bản sửa lỗi.

<a href="https://rea.tools/vi/contributors/">
  <img src="../../website/public/contributors/avatars.png" alt="Những người đóng góp cho REA" />
</a>

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="Lịch sử sao GitHub của REA" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Đóng góp

Chúng tôi hoan nghênh bạn giúp phát triển REA! [Mở issue](https://github.com/morluto/rea/issues) để báo lỗi hoặc đề xuất tính năng, hoặc [gửi pull request](https://github.com/morluto/rea/pulls) để cải thiện mã hay tài liệu.

Xem [CONTRIBUTING.md](../../CONTRIBUTING.md) về thiết lập môi trường phát triển và các bước kiểm tra, [hướng dẫn kiểm thử](../development/testing.md) về các luồng xác minh.

## Miễn trừ trách nhiệm

Xem [DISCLAIMER.md](../../DISCLAIMER.md) để biết hướng dẫn sử dụng có trách nhiệm.

REA dành cho nghiên cứu, giáo dục, khả năng tương tác, bảo tồn phần mềm và phân tích phần mềm bạn sở hữu hoặc được phép kiểm tra, trong khuôn khổ pháp luật.

The project's position on illegal or unauthorized use covers all REA
versions, distribution channels, and platforms; each copy retains its
applicable licenses.

## Giấy phép

[MIT](../../LICENSE)

REA-authored code is licensed under MIT. Third-party material retains its own
licenses and copyright notices; see [Third-party notices](../../THIRD_PARTY_NOTICES.md)
for the dependency inventory, preserved license texts, and external-tool terms.

**You must legally obtain and be authorized to use commercial tools**, including
IDA Pro / Hex-Rays decompilers, Hopper, and JEB, under their applicable licenses.
REA grants no tool license, key, or activation entitlement. Trials and demos
remain subject to vendor terms, including user, feature, automation, and output
sharing restrictions. Cracked copies, stolen keys, unauthorized key sharing,
and bypassing license restrictions are not authorized. This guidance does not
amend MIT or third-party licenses.
