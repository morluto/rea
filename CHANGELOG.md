# Changelog

## [6.11.0](https://github.com/morluto/rea/compare/rea-agents-6.10.1...rea-agents-6.11.0) (2026-11-28)


### ⚠ BREAKING CHANGES

* **firmware:** report partial devicetree coverage when a property was not decoded ([#14966](https://github.com/morluto/rea/issues/14966))
* **javascript:** a decode_android_resources call that omits detail on a decode above the agent result budget now returns the retained summary. Pass detail: "complete" (--detail complete) for the previous shape.
* **gpu:** inspect_gpu_code_objects adds optional per-call budget parameters and reports details.limit with details.refusal.kind "adjustable_budget" instead of "fixed_ceiling" on top-level object, work, report, metadata, structure, and parser budget refusals.
* **macho:** select arm64e.x1 slices of universal Mach-O files by exact subtype ([#14881](https://github.com/morluto/rea/issues/14881))
* **elf:** an inspect_elf_unwind_ranges call that omits limit returns at most 64 ranges. Page with next_offset, or pass limit.
* **android:** a search_android_classes call that omits limit returns at most 256 matches. Page with next_offset, or pass a larger limit.
* **artifacts:** an extract_artifact call that omits detail on an extraction above the agent result budget now returns the retained summary. Pass detail: "complete" (--detail complete) for the previous shape.
* **dwarf:** Oversized individual PE COFF long section names in inspect_dwarf_units now project an adjustable_budget refusal (boundary max_structure_bytes with details.limit) instead of fixed_ceiling (pe-section-name-bytes).
* **native:** Oversized Android APS2 packed relocation tables in inspect_native_initializers now project a memory/adjustable_budget refusal (boundary max_structure_bytes with details.limit) instead of capacity/fixed_ceiling (native-index-capacity).
* **android:** the inspect_android_package summary no longer lists component declarations. Page them with view {kind: "android", facet: "components"}, or pass detail: "complete".
* **android:** the inspect_android_class summary, delivered for detail summary or above the agent result budget, no longer lists methods, fields, inner classes or mapping symbols. Page them with the android-class view, or pass detail: "complete".
* **android:** a trace_android_references call that omits detail on a trace above the agent result budget now returns the retained summary. Pass detail: "complete" (--detail complete) for the previous shape.
* **apktool:** a decode_android_resources call that omits detail on a decode above the agent result budget now returns the retained summary. Pass detail: "complete" (--detail complete) for the previous shape.
* **limits:** Rust dependency-parser refusals report details.limit for the binding parameter instead of a fixed_ceiling allowance.
* **limits:** apktool and assetutil output refusals report details.limit for producer_limits.output_bytes instead of a fixed_ceiling refusal.
* **native:** Go and Rust structural refusals and the WebAssembly section refusal report details.limit instead of a fixed_ceiling refusal.
* **limits:** register producer.output_bytes as the session default for bounded producer output ([#14648](https://github.com/morluto/rea/issues/14648))
* **browser:** an observe_web_execution call that omits detail on an observation above the agent result budget now returns the retained summary. Pass detail: "complete" (--detail complete) for the previous shape.
* **native:** the PE retained-text, exception-directory entry and resource metadata refusals report details.limit instead of a fixed_ceiling refusal.
* **native:** export inventory and retained-text refusals report details.limit for max_entries or max_text_bytes instead of a fixed_ceiling refusal, and MAX_NATIVE_EXPORT_ROWS is renamed DEFAULT_NATIVE_EXPORT_ROWS.
* **native:** a DWARF decompression refusal reports details.limit for max_decompressed_bytes instead of a fixed_ceiling refusal.
* **limits:** omitted input budgets for inspect_sqlite_database, inspect_go_binary, inspect_rust_binary and inspect_nuget_nupkg now admit larger files. Callers relying on the old default refusal must pass the old value explicitly.
* **native:** inspect_devicetree's decoded-representation refusal reports reported_limits.boundary "max_decoded_bytes" with details.limit, instead of "decoded_bytes".
* **native:** inspect_devicetree's decoded-representation refusal reports reported_limits.boundary "max_decoded_bytes" with details.limit, instead of "decoded_bytes".
* **limits:** the SQLite snapshot refusal reports details.limit for producer_limits.input_bytes, and the SQLite column and reply refusals carry a fixed_ceiling refusal in place of their authored remediation.
* **limits:** per-call parameter refusals gain `details.refusal`, and their `remediation.action` wording changes to the generated form.
* **trace:** PlaywrightTracePort.inspect takes the resolved limits, and trace archive and nesting refusals report details.limit instead of a fixed_ceiling refusal.
* **native:** refusals at the structural budget report reported_limits.boundary "max_structure_bytes" instead of "structure".
* **metadata:** NTFS and Maven report refusals report details.limit instead of a fixed_ceiling refusal, and parseMavenGradleMetadata and the inspect_ntfs_journal input contract gain the new controls.
* **flutter:** Flutter size, inventory and candidate refusals report details.limit instead of a fixed_ceiling refusal, and the inspect_dart_aot abi selector admits labels up to 65,521 characters.
* **artifacts:** artifactReaderLimitsSchema now requires deno, wxapkg and tar groups, so saved Evidence whose effective_limits predates them fails validation and must be re-inspected. A release-exposure refusal at max_file_bytes reports details.limit instead of a fixed_ceiling refusal.
* **limits:** discovery output_window gains record_budget_reached, a page can return fewer than limit records, and discovery no longer refuses at the record or line budget.
* **cli:** An over-budget CLI result without --evidence_output is now saved to REA's private retained-Evidence cache and reported as {summary, evidence_bundle, delivery} with delivery.retained cache-file, instead of writing nothing. Pass --no-retain, or set REA_CLI_RETAINED_EVIDENCE_BYTES=0, to write nothing as before.
* **delivery:** When a failure's details.partial_observation does not fit delivery.agent_result_budget_bytes beside the failure's own facts and the caller omitted detail, MCP and the CLI deliver its summary record instead of the complete Evidence, with details.partial_observation_delivery naming where the complete record is. Pass detail complete (--detail complete) for it inline.
* **views:** xrefs and inspect_nuget_nupkg with detail omitted now return their retained summary when complete Evidence exceeds delivery.agent_result_budget_bytes in a session that can page it. Pass detail "complete" (CLI --detail complete) for complete inline delivery.
* **delivery:** An omitted detail no longer always returns complete Evidence inline on MCP or the CLI for tools with a detail selector (including inspect_managed_members, inspect_managed_artifact, inspect_byte_entropy, inspect_artifact, analyze_javascript_application, list_procedures, list_strings and the other operations listed in src/domain/agentBudgetOperations.ts). Over the budget they return the retained summary; pass detail complete (--detail complete) for complete inline delivery. inspect_managed_members type_names narrows member_refs and exported_types.
* **errors:** inspect_plist, inspect_apk_signature, inspect_ntfs_journal, inspect_api_contract, audit_release_exposure, inspect_web_network_capture, inspect_playwright_trace, inspect_packet_capture, inspect_packet_fields, inspect_gpu_code_objects, inspect_model_artifact, inspect_native_dispatch_metadata, inspect_macho, list_architectures, inspect_sqlite_database, sigrok recording operations, Android mapping reads and the shared provider classifier report a non-change integrity check (for example admitted-identity) as artifact_operation_failed, category integrity_mismatch, retryable false, with details.reason "integrity" and details.integrity_check, instead of artifact_changed. artifact_changed errors from AnalysisArtifactChangedError now include retry "backoff".
* **macho:** selected-file malformed and truncated refusals add details.failure_kind, and a truncated target's remediation now says to re-acquire the complete file instead of choosing another target. Codes are unchanged. Affected operations: every operation that refuses a selected file's malformed or truncated bytes, including the ELF, PE, Mach-O, DWARF, Go, Rust, BEAM, pyc, devicetree, Apple IPS, kernel module, binary hardening, managed PE/CLI and IL2CPP readers.
* **cli:** selected-file malformed and truncated refusals add details.failure_kind, and a truncated target's remediation now says to re-acquire the complete file instead of choosing another target. Codes are unchanged. Affected operations: every operation that refuses a selected file's malformed or truncated bytes, including the ELF, PE, Mach-O, DWARF, Go, Rust, BEAM, pyc, devicetree, Apple IPS, kernel module, binary hardening, managed PE/CLI and IL2CPP readers.
* **errors:** selected-file malformed and truncated refusals add details.failure_kind, and a truncated target's remediation now says to re-acquire the complete file instead of choosing another target. Codes are unchanged. Affected operations: every operation that refuses a selected file's malformed or truncated bytes, including the ELF, PE, Mach-O, DWARF, Go, Rust, BEAM, pyc, devicetree, Apple IPS, kernel module, binary hardening, managed PE/CLI and IL2CPP readers.
* **errors:** selected-file malformed and truncated refusals add details.failure_kind, and a truncated target's remediation now says to re-acquire the complete file instead of choosing another target. Codes are unchanged. Affected operations: every operation that refuses a selected file's malformed or truncated bytes, including the ELF, PE, Mach-O, DWARF, Go, Rust, BEAM, pyc, devicetree, Apple IPS, kernel module, binary hardening, managed PE/CLI and IL2CPP readers.
* **errors:** selected-file malformed and truncated refusals add details.failure_kind, and a truncated target's remediation now says to re-acquire the complete file instead of choosing another target. Codes are unchanged. Affected operations: every operation that refuses a selected file's malformed or truncated bytes, including the ELF, PE, Mach-O, DWARF, Go, Rust, BEAM, pyc, devicetree, Apple IPS, kernel module, binary hardening, managed PE/CLI and IL2CPP readers.
* **errors:** selected-file malformed and truncated refusals add details.failure_kind, and a truncated target's remediation now says to re-acquire the complete file instead of choosing another target. Codes are unchanged. Affected operations: every operation that refuses a selected file's malformed or truncated bytes, including the ELF, PE, Mach-O, DWARF, Go, Rust, BEAM, pyc, devicetree, Apple IPS, kernel module, binary hardening, managed PE/CLI and IL2CPP readers.
* **errors:** selected-file malformed and truncated refusals add details.failure_kind, and a truncated target's remediation now says to re-acquire the complete file instead of choosing another target. Codes are unchanged. Affected operations: every operation that refuses a selected file's malformed or truncated bytes, including the ELF, PE, Mach-O, DWARF, Go, Rust, BEAM, pyc, devicetree, Apple IPS, kernel module, binary hardening, managed PE/CLI and IL2CPP readers.
* **errors:** add the TargetFailure model, its projection table and conformance registry ([#14247](https://github.com/morluto/rea/issues/14247))
* **artifacts:** artifactReaderLimitsSchema now requires iso9660 (descriptor_count, directory_depth, record_count, directory_bytes, path_bytes), so saved Evidence records containing effective_limits from prior versions without iso9660 fail parseInventoryPage validation and must be re-inspected.
* **artifacts:** subject.identity gains a directory kind {kind:"directory",algorithm:"rea-directory-tree",version:1,sha256}. A directory inventory's subject and root sha256 are its tree digest, and a partial walk's subject is {kind:"unknown",reason:"not-observed"}. inspect_artifact no longer requires an open target. Directory symlink occurrences record link_target and compare by it.
* **native:** procedure_references.procedure may now identify an address outside every procedure, with classification null and an unavailable body. find_xrefs_to_name adds resolved_name and candidates, and resolves bare import names on Ghidra.
* **ghidra:** in MCP sessions, Ghidra result Evidence no longer lists session-scoped limitations inline. It carries one reference limitation and links a retained session-limitations Evidence (operation health, parameters.facet session-limitations) in evidence_links. Read it with get_evidence_bundle. Defect records no longer appear on operations or architectures outside their declared scope.
* **pe:** import and delay-import walks continue to the null descriptor past a short directory Size instead of stopping with a malformed_entry issue, and inspect-pe-resources reports an unsupported optional-header magic as unsupported_target.
* **limits:** an inspect_pcap_capture refusal at the snapshot or TShark JSON budget reports details.limit for producer_limits.input_bytes or producer_limits.output_bytes and no longer carries details.refusal fixed_ceiling.
* **browser:** an MCP inspect_web_page call that omits detail on a capture above 32 KiB now returns the retained summary. Pass detail: "complete" for the previous shape, for example before compare_web_captures.
* **rizin:** record which tool and version answered execute_rizin_command ([#7487](https://github.com/morluto/rea/issues/7487))
* **ghidra:** RISC-V images with this layout, such as ESP-IDF ESP32-C6, H2 and H21 builds, report flash code at its ELF address (0x42...) instead of .flash.text:0x42..., and their analysis profiles change. RISC-V images with any other section overlap that involves executable code are now refused with the overlapping sections named. These include ESP-IDF v5.5.2 ESP32-C5 and C61 builds, whose second reservation, .ext_ram.dummy, also covers .flash.text. See docs/ghidra-riscv.md.
* **delivery:** for these seven tools, an omitted detail on a result above 32 KiB now returns the retained summary instead of complete Evidence. Pass detail: "complete" to keep the previous shape.
* **deps:** MCP callers that need every volume, file and section inline must pass detail: "complete" to inspect_uefi_firmware.
* **limits:** an inspect_il2cpp_metadata refusal at the ELF pointer index reports reported_limits.boundary "virtual-pointer-index-bytes" and details.limit for max_native_index_bytes, and no longer carries a details.refusal fixed_ceiling.
* **pe:** import and delay-import walks continue to the null descriptor past a short directory Size instead of stopping with a malformed_entry issue, and inspect-pe-resources reports an unsupported optional-header magic as unsupported_target.
* **desktop:** the desktop application result adds the native family, the ui-framework and runtime-library component categories, new probe operations, a required probe priority and deferred_probes.
* **macho:** inspect_go_binary, inspect_rust_binary, inspect_dwarf_units, inspect_native_initializers, inspect_native_dispatch_metadata, the IL2CPP binary readers and the macOS provider's lipo-selected slice reads now report a FAT header or table cut off by the file's end with details.format_failure "truncated" (previously "malformed", or an unsupported or not-universal result for a table past the end), plus details.available_bytes and details.required_bytes.
* **doctor:** audit-wide doctor reports omit scope_checks; read checks. Passing providerInspections checks report classification "healthy".
* **release-exposure:** release-exposure checks no longer use the not_applicable status, and summary.by_status has no not_applicable count. A check that cannot apply is absent from checks and listed in coverage.inapplicable_checks.
* **gpu:** amd_target_metadata gains required os_abi and abi fields, GPU objects gain a nullable amd_pal_metadata field, and PAL-ABI objects report complete, partial or unsupported instead of malformed.
* **errors:** when a managed reader stops on `unsupported-signature`, `metadata.status` is `partial` (was `malformed`) in managed artifact, member and native-boundary inspection, and the artifact `classification.status` is `managed` (was `malformed`). The field names and enum members are unchanged.
* **errors:** inspect_managed_artifact, inspect_managed_members, inspect_managed_native_boundaries, compare_managed_members, inspect_il2cpp_metadata, inspect_go_binary, inspect_rust_binary, inspect_dwarf_units and inspect_native_initializers report corrupt or truncated target bytes as code unsupported_target with details.path, format, format_failure and reason instead of invalid_request with an invalid_format issue. IL2CPP link conflicts list both path and binary_path with reason invalid_value instead of one invalid_format binary_path issue.
* **errors:** callers that parse `code` see unsupported_target instead of invalid_request for malformed or truncated bytes from inspect_erlang_beam and from the inspect_pe_certificates certificate table body. Truncated reads of a file that changed during inspect_kernel_module, inspect_kernel_build_config and inspect_elf_unwind_ranges now report artifact_changed. inspect_artifact malformed and truncated refusals gain details.format_failure and details.format. Existing fields are unchanged.
* **cli:** camelCase option spellings such as `--maxRows` or `--dryRun` are refused; use the kebab-case flag that `--help` lists.
* **pwntools:** for a request-sourced pwntools input ceiling, details.limit is now a control_kind "parameter" limit instead of a setting limit carrying setting, source, update_mode and scope fields.
* **uefi:** MCP callers that need every published file inline must pass detail: "complete" to extract_uefi_firmware.
* **uefi:** MCP callers that need every volume, file and section inline must pass detail: "complete" to inspect_uefi_firmware.

### build

* **deps:** bump write-file-atomic from 7.0.0 to 8.0.0 ([#8134](https://github.com/morluto/rea/issues/8134)) ([05b683b](https://github.com/morluto/rea/commit/05b683b72e8579ab4cf1cbb7181179d27b110965))


### Features

* **adb:** add optional limit and offset paging to list_adb_features and list_adb_services ([#13873](https://github.com/morluto/rea/issues/13873)) ([11a7a34](https://github.com/morluto/rea/commit/11a7a34dfc7748b7cf7efcdc6e6c80b7ba123783))
* **adb:** add optional limit and offset paging to list_adb_packages, list_adb_processes, and list_adb_directory ([#13843](https://github.com/morluto/rea/issues/13843)) ([dbd6057](https://github.com/morluto/rea/commit/dbd60574541fd57bdc4a9f6952dc740d77a65de5))
* **analysis-view:** count distinct retained JavaScript fact values ([e19dbcf](https://github.com/morluto/rea/commit/e19dbcf857e98f402b61b1ef793dd62d9929426a))
* **analysis-view:** filter native exports and ELF dependencies by name prefix ([a148da5](https://github.com/morluto/rea/commit/a148da56ccfb370e7a638832c2a1290fb208ca63))
* **analysis-view:** order inventory occurrences by size before paging ([386d294](https://github.com/morluto/rea/commit/386d294f90d1ebfc0d6d01374ead49fc5bc637e0))
* **analysis-view:** page retained Android reference traces ([c0f1bc6](https://github.com/morluto/rea/commit/c0f1bc6a6d1dc6d5262690ed5234bfc133977c63))
* **analysis-view:** page retained Apktool resource decodes ([8ce5c00](https://github.com/morluto/rea/commit/8ce5c00a6eb5c4634ee2e6e117a5e640b6e69419))
* **analysis-view:** page retained artifact extractions ([03626b9](https://github.com/morluto/rea/commit/03626b96a898331947106580458f95ff22da0725))
* **analysis-view:** page retained observe_web_execution observations ([38536f9](https://github.com/morluto/rea/commit/38536f9fdb8a66ff44375b888c8fabe1a4bff3ba))
* **analysis-view:** page retained UEFI extraction manifests ([5e8388a](https://github.com/morluto/rea/commit/5e8388a655e2eae83c31e6e21a611c2fc9910156))
* **analysis-view:** page retained UEFI firmware maps ([fc4c453](https://github.com/morluto/rea/commit/fc4c453683213991d2338b25c6752f24236a3052))
* **analysis-view:** select inventory occurrences by artifact kind ([e128a69](https://github.com/morluto/rea/commit/e128a69c2fd2bd51125eb36d479d7e573d07267b))
* **analysis-view:** select inventory occurrences by path glob ([dba72f1](https://github.com/morluto/rea/commit/dba72f1277534791a30cc26607c430b1a655b9ef))
* **analysis-view:** select retained JavaScript facts by property value ([25e93a8](https://github.com/morluto/rea/commit/25e93a8139abf3ad398d0366d84c53c75fcd0d82))
* **android:** add optional limit and offset paging to search_android_classes ([#13846](https://github.com/morluto/rea/issues/13846)) ([f47dbd9](https://github.com/morluto/rea/commit/f47dbd9351ac8624c409d4e37ea630c1cc35edd9))
* **android:** budget trace_android_references delivery ([3228011](https://github.com/morluto/rea/commit/32280113a72538b3663158dc0e3bfc9ac1875b72))
* **android:** count class members in summaries and page them ([5257f40](https://github.com/morluto/rea/commit/5257f40ffbaa655f0d5f6a6308bc566257ce5815))
* **android:** count components in package summaries ([e731ca7](https://github.com/morluto/rea/commit/e731ca7bbe4242ca76870f7beac160a420413dee))
* **android:** pin jadx-headless-mcp 0.8.0 ([3ca89d8](https://github.com/morluto/rea/commit/3ca89d8272b3d8e49580ed261753ad6780df2839))
* **apktool:** budget decode_android_resources delivery ([a16facb](https://github.com/morluto/rea/commit/a16facbd9f2b323f9bd575e251af6cba7b62e48f))
* **apple:** inspect Image4 (IMG4, IM4P, IM4M) firmware containers offline ([#14907](https://github.com/morluto/rea/issues/14907)) ([88373e3](https://github.com/morluto/rea/commit/88373e3fba088601388700911445121d4a5cc333))
* **artifacts:** back archive member counts with the artifact.member_count setting ([#14650](https://github.com/morluto/rea/issues/14650)) ([3129747](https://github.com/morluto/rea/commit/31297470ef829a404dc38c2acf327272e222c404))
* **artifacts:** budget extract_artifact delivery ([981dd11](https://github.com/morluto/rea/commit/981dd11ec4cd8ea7d54840550a5214acf420eb38))
* **artifacts:** decode Android Verified Boot vbmeta images offline ([#13239](https://github.com/morluto/rea/issues/13239)) ([3e8f6a4](https://github.com/morluto/rea/commit/3e8f6a43a9402fea3108e5b15dd5a152b4665960))
* **artifacts:** decode UnityFS LZMA blocks ([#14699](https://github.com/morluto/rea/issues/14699)) ([a6cca9d](https://github.com/morluto/rea/commit/a6cca9dc62a18bb7fb3708ad25d3546ab61e010a))
* **artifacts:** give Deno, wxapkg and tar readers artifact_limits controls ([#14620](https://github.com/morluto/rea/issues/14620)) ([3dae567](https://github.com/morluto/rea/commit/3dae567185ac08126d40ea38435d5cbe9aa64afe))
* **artifacts:** inspect and compare directories by a content-addressed root digest ([#14270](https://github.com/morluto/rea/issues/14270)) ([56cf155](https://github.com/morluto/rea/commit/56cf15566ee1fee1cb0d3573bf0e23b1a682e635))
* **artifacts:** inspect Debian package control metadata and contents ([#10689](https://github.com/morluto/rea/issues/10689)) ([0f5ab1e](https://github.com/morluto/rea/commit/0f5ab1e04257cc61449254c33a0e9d7a06902430))
* **artifacts:** inspect Sega Mega Drive and Genesis ROM headers offline ([#14895](https://github.com/morluto/rea/issues/14895)) ([ba1ddff](https://github.com/morluto/rea/commit/ba1ddffd7e9582165e337b895cac0e418dd056ea))
* **artifacts:** inspect VS Code extension packages offline ([#12469](https://github.com/morluto/rea/issues/12469)) ([2c89136](https://github.com/morluto/rea/commit/2c89136469e536f63961061fb8e115683975e06d))
* **artifacts:** inventory and expand Android sparse images offline ([#13244](https://github.com/morluto/rea/issues/13244)) ([192177f](https://github.com/morluto/rea/commit/192177f0c91ed94cf9b8698f7ccdb3f2e44330fe))
* **artifacts:** inventory and extract ISO 9660 disc images offline ([#13290](https://github.com/morluto/rea/issues/13290)) ([e896f60](https://github.com/morluto/rea/commit/e896f60540f03e2c1fe0f916412bddd656c1f296))
* **artifacts:** inventory and extract stored and gzip-compressed tar archives ([#14245](https://github.com/morluto/rea/issues/14245)) ([225a19a](https://github.com/morluto/rea/commit/225a19ae7a39d06d03a8d5df4d9bf44e645a6c54))
* **artifacts:** inventory auditd logs offline ([#12062](https://github.com/morluto/rea/issues/12062)) ([395a6df](https://github.com/morluto/rea/commit/395a6df911e68c80c0368b8d9384921790f6f7e2))
* **artifacts:** inventory macOS flat installer packages offline ([#11377](https://github.com/morluto/rea/issues/11377)) ([dbbe334](https://github.com/morluto/rea/commit/dbbe334ec1995f42506dc8d0b651914a55399941))
* **artifacts:** inventory Nintendo 64 ROM images and normalize byte order offline ([#14911](https://github.com/morluto/rea/issues/14911)) ([17b53ee](https://github.com/morluto/rea/commit/17b53ee004beb47ec5170c7c336dcb012b4dddd8))
* **artifacts:** inventory Nintendo DS ROM binaries, overlays and file tables offline ([#14664](https://github.com/morluto/rea/issues/14664)) ([51b3671](https://github.com/morluto/rea/commit/51b3671b08714435cc6cc2188ab495db0b70d515))
* **artifacts:** inventory Nintendo Switch NSO and NRO executables offline ([#14655](https://github.com/morluto/rea/issues/14655)) ([3970afe](https://github.com/morluto/rea/commit/3970afecc6fc3a952e10ec0db4cc21fa6cb7a71d))
* **artifacts:** inventory OCI image layouts offline ([#12470](https://github.com/morluto/rea/issues/12470)) ([6a6e7b0](https://github.com/morluto/rea/commit/6a6e7b0bbf9d233c8e99e9a2314f28ba07f88199))
* **artifacts:** inventory systemd journal headers and object table offline ([#10151](https://github.com/morluto/rea/issues/10151)) ([742cdf0](https://github.com/morluto/rea/commit/742cdf042847e1815885b14c734fed440ae38012))
* **artifacts:** recognize Zip64 archives after leading bytes ([#14105](https://github.com/morluto/rea/issues/14105)) ([b14844d](https://github.com/morluto/rea/commit/b14844d99c096c0840961d667cb44e0326e6b221))
* **artifacts:** report declared DDS, GLB, KTX and KTX2 headers and regions ([#14248](https://github.com/morluto/rea/issues/14248)) ([78d2593](https://github.com/morluto/rea/commit/78d2593a4543592636a49c0cead0ca64dcef78ea))
* **artifacts:** report declared Ogg Opus, RIFF/XMA2, Bink 2 and Vulkan pipeline-cache headers ([#14700](https://github.com/morluto/rea/issues/14700)) ([d74703f](https://github.com/morluto/rea/commit/d74703ff50d37f5059bd96ada650b516557f9ae5))
* **browser:** accept mitmproxy 12.3.1 for native capture decode ([#8088](https://github.com/morluto/rea/issues/8088)) ([4f43d74](https://github.com/morluto/rea/commit/4f43d7422f5b4666a12570105ff5e25a6df7ec6c))
* **browser:** accept retained capture references in compare_web_captures ([523d44f](https://github.com/morluto/rea/commit/523d44f6d8241b7283c8b1d6d63db3abe5475fab))
* **browser:** budget observe_web_execution delivery ([42ce0ea](https://github.com/morluto/rea/commit/42ce0ea2310e310d07794955cc254e8ced3446b7))
* **browser:** count credential-named members in HAR capture inspection ([#8708](https://github.com/morluto/rea/issues/8708)) ([3c7ea1c](https://github.com/morluto/rea/commit/3c7ea1ce850c20c067add363ffcddbc1d48f2aac))
* **browser:** resolve retained capture references before comparison ([37b9942](https://github.com/morluto/rea/commit/37b99422be482c976d5249e1af2d57efcdbb58c9))
* **browser:** size inspect_web_page delivery and page captures by section ([#14368](https://github.com/morluto/rea/issues/14368)) ([67a1e2c](https://github.com/morluto/rea/commit/67a1e2c9371131a93fb1eecb00d74bb160c6d215))
* **cli:** add human-TTY failure rendering with CLI-only issue hint ([#14355](https://github.com/morluto/rea/issues/14355)) ([64279ef](https://github.com/morluto/rea/commit/64279efb5a01fc768d66033bd69a41a647c3e175))
* **cli:** add list-procedures to produce function-matching inventories ([#14241](https://github.com/morluto/rea/issues/14241)) ([e2c0071](https://github.com/morluto/rea/commit/e2c00712fd421fc77f335d7b9f87ce162808a437))
* **cli:** keep over-budget CLI results recoverable by default ([#14610](https://github.com/morluto/rea/issues/14610)) ([2bb554e](https://github.com/morluto/rea/commit/2bb554e8b05b945b1bf6cfe7d25b9b1ca0b60e5c))
* **cli:** retain over-budget partial observations from failed CLI runs ([#14693](https://github.com/morluto/rea/issues/14693)) ([9cb0aa3](https://github.com/morluto/rea/commit/9cb0aa328b17509f0931905284ba38eac87aecbe))
* **config:** persist provider settings in a user config file ([#3023](https://github.com/morluto/rea/issues/3023)) ([8d6552e](https://github.com/morluto/rea/commit/8d6552e928704a6477edec3674a17c3ba2f4f4af))
* **delivery:** bound default results by an agent result budget ([#14252](https://github.com/morluto/rea/issues/14252)) ([123b693](https://github.com/morluto/rea/commit/123b693f0877181115b8fd7ad800ecfd566f22c0))
* **delivery:** budget the partial observation carried by failure results ([#14607](https://github.com/morluto/rea/issues/14607)) ([73d6092](https://github.com/morluto/rea/commit/73d6092687a201940d2d454feb69ed0ccf845bd5))
* **delivery:** size the default delivery of native inventories and traces ([59a7999](https://github.com/morluto/rea/commit/59a799931c13c9a8d89e490c20298882497d50d8))
* **desktop:** recognise native releases and rank application probes first ([#14264](https://github.com/morluto/rea/issues/14264)) ([46b73f5](https://github.com/morluto/rea/commit/46b73f5b8116ac71333a0c37980f166c13bedd4e))
* **elf:** inspect exports without section headers ([#9083](https://github.com/morluto/rea/issues/9083)) ([7e15884](https://github.com/morluto/rea/commit/7e158843b36c7cca8a8614687652d20e0f77e323))
* **errors:** add the TargetFailure model, its projection table and conformance registry ([#14247](https://github.com/morluto/rea/issues/14247)) ([40e9a3f](https://github.com/morluto/rea/commit/40e9a3f1a1769f3fbb24ca226aa853f42d78c42e))
* **evidence:** find direct referrers by linked Evidence ID ([#11709](https://github.com/morluto/rea/issues/11709)) ([b57671c](https://github.com/morluto/rea/commit/b57671cb42ed16687d0b0ea8ff43d3643e045aef))
* **evidence:** paginate retained evidence discovery summaries ([#9084](https://github.com/morluto/rea/issues/9084)) ([a16669a](https://github.com/morluto/rea/commit/a16669ab2adf8341b0261e9527bb26c98c1d7b21))
* **firmware:** decode ARM M-profile and RISC-V mtvec interrupt vector tables ([#14421](https://github.com/morluto/rea/issues/14421)) ([a91d9fa](https://github.com/morluto/rea/commit/a91d9fa2b57d8618dd858854c266a56f6a3c03a0))
* **firmware:** decode ESP-IDF Non-Volatile Storage (NVS) flash partitions ([#14436](https://github.com/morluto/rea/issues/14436)) ([f6cf6a8](https://github.com/morluto/rea/commit/f6cf6a867f2103dd292804e29ab289b9d4c87db9))
* **firmware:** inspect and extract Android DTBO partition images ([#14398](https://github.com/morluto/rea/issues/14398)) ([b3f7089](https://github.com/morluto/rea/commit/b3f70898e4319e616be23e86d223a0a13bdfb954))
* **firmware:** inspect Qualcomm MBN image headers and hash segments offline ([#14649](https://github.com/morluto/rea/issues/14649)) ([f78470e](https://github.com/morluto/rea/commit/f78470e36164aa4f84e7154628499bafebccfab4))
* **firmware:** inspect uClinux bFLT flat executables offline ([#14663](https://github.com/morluto/rea/issues/14663)) ([04cb70c](https://github.com/morluto/rea/commit/04cb70c1a39270e8a1fd94a69382db01a6c7c159))
* **firmware:** inventory and extract UBI image volumes offline ([#13333](https://github.com/morluto/rea/issues/13333)) ([14b4d1f](https://github.com/morluto/rea/commit/14b4d1f7ad8ede0c4c8e162e6ab55e2a09e2a6e0))
* **flutter:** give Flutter APK admission per-call apk_limits ([#14623](https://github.com/morluto/rea/issues/14623)) ([49e2eca](https://github.com/morluto/rea/commit/49e2eca4f971bc154badfae47ac80c7edcf97018))
* **frida:** add optional limit and offset paging to list_frida_processes ([#13854](https://github.com/morluto/rea/issues/13854)) ([9ec23ad](https://github.com/morluto/rea/commit/9ec23ad03bb6feef0ad208170652858eabcb3e4a))
* **ghidra:** admit RISC-V ilp32f ELF with a derived calling convention ([#8401](https://github.com/morluto/rea/issues/8401)) ([d8aadcc](https://github.com/morluto/rea/commit/d8aadcc69bc65412e1e1545e25f23256f6ab5d8b))
* **ghidra:** define function-pointer members and typedefs ([#14889](https://github.com/morluto/rea/issues/14889)) ([8ff311b](https://github.com/morluto/rea/commit/8ff311b4ca0c67bfe45d811aecb6a68483a649af)), refs [#14887](https://github.com/morluto/rea/issues/14887)
* **ghidra:** open M-profile raw images at a separate load base ([#7951](https://github.com/morluto/rea/issues/7951)) ([0b51ca0](https://github.com/morluto/rea/commit/0b51ca03de173fcf22059b5512647bc1461022df))
* **ghidra:** set function signatures and define the types they use ([#14859](https://github.com/morluto/rea/issues/14859)) ([3a8a717](https://github.com/morluto/rea/commit/3a8a717b02edcd41b9dfbf64e82e5f7a761dfd8e))
* **gpu:** add per-call object, work, report, metadata, structure, and parser budgets to inspect_gpu_code_objects ([#14882](https://github.com/morluto/rea/issues/14882)) ([2e59f08](https://github.com/morluto/rea/commit/2e59f08992271b10bedfe92b1d39fdfa521d2d21))
* **ida:** support the official Hex-Rays IDA MCP headlessly ([#4813](https://github.com/morluto/rea/issues/4813)) ([6822ebe](https://github.com/morluto/rea/commit/6822ebe1f3a4caec007fcd046754d66317d3349f))
* **javascript:** add semantic_analysis structure-only mode to analyze_javascript_application ([#14117](https://github.com/morluto/rea/issues/14117)) ([eccd18a](https://github.com/morluto/rea/commit/eccd18a2cc325bb97f66f23a4216dfcacd9e1bca))
* **javascript:** inventory Expo Router require.context route keys ([#10624](https://github.com/morluto/rea/issues/10624)) ([7b6e816](https://github.com/morluto/rea/commit/7b6e816b0b61d24d1a3b79106481f29db676ea65))
* **labview:** inspect RSRC containers and embedded VI trees ([#13337](https://github.com/morluto/rea/issues/13337)) ([f25312a](https://github.com/morluto/rea/commit/f25312a8bcfa4d1476bea8c004b953b64bedeaa2))
* **limits:** raise disk-backed admission defaults for large ordinary targets ([#14653](https://github.com/morluto/rea/issues/14653)) ([30be941](https://github.com/morluto/rea/commit/30be941a5adb36211cf0449fc980292b4cb8a470))
* **limits:** register producer.output_bytes as the session default for bounded producer output ([#14648](https://github.com/morluto/rea/issues/14648)) ([6ae722a](https://github.com/morluto/rea/commit/6ae722a660048e90c4cba36052134339250e16d0))
* **limits:** report the value a per-call limit needs and derive its recovery ([#14625](https://github.com/morluto/rea/issues/14625)) ([78cb717](https://github.com/morluto/rea/commit/78cb7172a6d38f726fe00acd530a8a8b7c21a737))
* **linux:** decode utmp, wtmp and btmp login-accounting records ([#11853](https://github.com/morluto/rea/issues/11853)) ([6a9affe](https://github.com/morluto/rea/commit/6a9affe2d9631fa0376f97f015305cdf41f36402))
* **mcp:** link retained Evidence from over-budget summaries ([#14603](https://github.com/morluto/rea/issues/14603)) ([fa65e51](https://github.com/morluto/rea/commit/fa65e51a24dc4c2983840af8d2ec119c28687cf7))
* **metadata:** give NTFS, Maven report and NuGet budgets typed per-call controls ([#14629](https://github.com/morluto/rea/issues/14629)) ([4f66985](https://github.com/morluto/rea/commit/4f6698597884d709be8a98ec43f9f5320ae598ce))
* **native:** give inspect_dwarf_units a per-call max_decompressed_bytes ([#14660](https://github.com/morluto/rea/issues/14660)) ([1cc655b](https://github.com/morluto/rea/commit/1cc655bbc0c17c7138a6457d069578fe93505d3a))
* **native:** give inspect_native_exports per-call inventory, text and structure budgets ([#14658](https://github.com/morluto/rea/issues/14658)) ([4d3fa5a](https://github.com/morluto/rea/commit/4d3fa5a0802ea31c4dc1b2ad559562e63b8dd7a2))
* **native:** give the Go and Rust readers max_structure_bytes and Rust max_wasm_sections ([#14661](https://github.com/morluto/rea/issues/14661)) ([4c9dca6](https://github.com/morluto/rea/commit/4c9dca63a0e8bc08030a703565f26e1df49a2c94))
* **native:** give the native structural decoding allowance a per-call max_structure_bytes ([#14626](https://github.com/morluto/rea/issues/14626)) ([e540cbd](https://github.com/morluto/rea/commit/e540cbdafd8170701b07b4735f8a5da40e47e10e))
* **native:** give the PE readers per-call text, entry and metadata budgets ([#14659](https://github.com/morluto/rea/issues/14659)) ([0aca049](https://github.com/morluto/rea/commit/0aca049128687828bddc32e8c4c0a39d7544c1ff))
* **native:** list Mach-O function starts and data-in-code entries offline ([#14897](https://github.com/morluto/rea/issues/14897)) ([61fb6cf](https://github.com/morluto/rea/commit/61fb6cf68adf47396e4b5b43cf4ccb032c7b8ffd))
* **native:** report the stored RVA of PE exports ([bf8448c](https://github.com/morluto/rea/commit/bf8448cdfc90c4c077f03b877cf09ea150509092))
* **native:** retain Apple bundle executable provenance ([b8995f8](https://github.com/morluto/rea/commit/b8995f81489dda3e7f8be61317f366b7fabd97c7))
* **pe:** inspect x64 exception-directory function ranges ([#14254](https://github.com/morluto/rea/issues/14254)) ([a85859e](https://github.com/morluto/rea/commit/a85859e14790795f6d13000b173cb32c82c49813))
* **pe:** report the overlay appended after a PE image's last section ([#13245](https://github.com/morluto/rea/issues/13245)) ([47daa05](https://github.com/morluto/rea/commit/47daa05a842154f883d9fb1f51eff2cd8c09d9f8))
* **providers:** retain native selection provenance in Evidence ([#9668](https://github.com/morluto/rea/issues/9668)) ([2bb086c](https://github.com/morluto/rea/commit/2bb086c87a54692561fa1f55596c56d9ba49bb50))
* **rizin:** record which tool and version answered execute_rizin_command ([#7487](https://github.com/morluto/rea/issues/7487)) ([721b25e](https://github.com/morluto/rea/commit/721b25e20db85b19b3a5cb24ea5f65177b6d917b))
* **setup:** discover project-scoped MCP registrations in doctor and … ([#7283](https://github.com/morluto/rea/issues/7283)) ([63c50ec](https://github.com/morluto/rea/commit/63c50ecfc0a849d3298c44b1ce06e2e759f1303c))
* **tools:** add optional limit and offset paging to find_xrefs_to_name ([#13858](https://github.com/morluto/rea/issues/13858)) ([1d4fadc](https://github.com/morluto/rea/commit/1d4fadceb2720b2db9a2a0674e95385117238d81))
* **tools:** add optional max_depth and max_nodes bounds to get_call_graph and trace_call_path ([#13828](https://github.com/morluto/rea/issues/13828)) ([d0560b1](https://github.com/morluto/rea/commit/d0560b1b88c3257b802b80ef4c36719c9734b996))
* **trace:** give Playwright trace import per-call trace_limits ([#14628](https://github.com/morluto/rea/issues/14628)) ([98d83d0](https://github.com/morluto/rea/commit/98d83d07870f43a583f3fe8ff1d2d49d932c8f2e))
* **uefi:** read TianoCore EDK2 NVRAM variable stores ([#14701](https://github.com/morluto/rea/issues/14701)) ([6b269db](https://github.com/morluto/rea/commit/6b269dbd97b3db65febd6a5a9817ebb241746584))
* **uefi:** record the owning FFS file of extracted payloads ([465079c](https://github.com/morluto/rea/commit/465079cb41d9cb4a6aa992c6533b8e6d617db440))
* **views:** page byte-entropy blocks and runs; budget xrefs and nupkg delivery ([#14599](https://github.com/morluto/rea/issues/14599)) ([f764105](https://github.com/morluto/rea/commit/f7641050c7336e93bcf56653e5a3946bf0f60af3))
* **web:** deduplicate bundle findings across scripts by value and mechanism ([#11354](https://github.com/morluto/rea/issues/11354)) ([23970fc](https://github.com/morluto/rea/commit/23970fc63f1c6f41ee03539216c236f85ae15593))
* **web:** report value-free header names in the api-surface view ([#9504](https://github.com/morluto/rea/issues/9504)) ([fd9cbef](https://github.com/morluto/rea/commit/fd9cbeff743cc5a685917daafc937060ee45d7a5))
* **website:** publish page-specific previews with the original REA blue ([1dd25d8](https://github.com/morluto/rea/commit/1dd25d87c7ba440b6256c644a556901eac1b3bbb))
* **website:** recognize contributors in a shared commit-ranked directory ([ba31a11](https://github.com/morluto/rea/commit/ba31a111809e727891c238d1ca5ff9d62f751f0b))
* **yara:** scan an admitted artifact with caller-supplied YARA rules ([#14688](https://github.com/morluto/rea/issues/14688)) ([bbd1540](https://github.com/morluto/rea/commit/bbd1540d10bf431138cd4e588c80d6ed5634d865))


### Bug Fixes

* **adb:** list a transport adb reports without a serial number ([#10187](https://github.com/morluto/rea/issues/10187)) ([df70b66](https://github.com/morluto/rea/commit/df70b6685edeffc1d96bc33dd47efdbc0f9388bd))
* **adb:** report macOS ownership preparation failures as typed host prerequisites ([#14140](https://github.com/morluto/rea/issues/14140)) ([604e087](https://github.com/morluto/rea/commit/604e087c3173e0a98c12409ac824017e20559094)), refs [#13943](https://github.com/morluto/rea/issues/13943)
* **analysis-view:** bound extraction summary samples by bytes ([7f07cab](https://github.com/morluto/rea/commit/7f07cab954f6ac5a1a789334e04f736434029e42))
* **analysis-view:** match inventory path globs without backtracking ([17877d9](https://github.com/morluto/rea/commit/17877d9df51ac258b447a97656f6b4e91b4c3b75))
* **analysis-view:** omit absent fields from extraction rows ([#14806](https://github.com/morluto/rea/issues/14806)) ([d002753](https://github.com/morluto/rea/commit/d002753ce77bba38317556955e09c0d8d2f45f51))
* **analysis-view:** read older UEFI extraction Evidence and drop filter-count ceilings ([ca26f2a](https://github.com/morluto/rea/commit/ca26f2ac8499fa06af59f2590ec071af8a020094))
* **analysis:** prevent self-append loop in appendAll ([#14665](https://github.com/morluto/rea/issues/14665)) ([6c1dbc4](https://github.com/morluto/rea/commit/6c1dbc4f8f4a437167de5e267b93385400b5ecef))
* **android-ota:** report unknown coverage when OTA payload blob is truncated ([#14513](https://github.com/morluto/rea/issues/14513)) ([52e3117](https://github.com/morluto/rea/commit/52e3117256947183cc66516a654538f2ad0ed17d))
* **android:** admit DEX-bearing ZIP packages by directory content ([#14399](https://github.com/morluto/rea/issues/14399)) ([803b92f](https://github.com/morluto/rea/commit/803b92f794bbb3f29d32895ae3798aa3db79151a))
* **android:** advertise the external-reference inputs the bridge accepts ([85154de](https://github.com/morluto/rea/commit/85154de8ab9107c0f403079a9bec81ab63077ea1))
* **android:** allow filtering references by the unnamed package ([#14752](https://github.com/morluto/rea/issues/14752)) ([752f576](https://github.com/morluto/rea/commit/752f5769e20998c427aa5dc4d28f8961259d5ff7))
* **android:** bound the JNI summary preview by bytes with its relations ([f3aecfa](https://github.com/morluto/rea/commit/f3aecfa5ec8005251922db54281cf78f35cac0ae))
* **android:** let the bridge advertise its own tool schemas ([2b6ede2](https://github.com/morluto/rea/commit/2b6ede2d0c0c82ea466c61a6694df3353c998637))
* **android:** page class-name search by default and name the next offset ([2b69ddd](https://github.com/morluto/rea/commit/2b69ddd368160556cfcc436c5e1c76130ab83738))
* **android:** preview 16 JNI bindings and libraries in the summary ([b827326](https://github.com/morluto/rea/commit/b827326ef3ff54a70aa5a27a0d188eb57d2891ca))
* **android:** record only caller-selected search parameters in Evidence ([d2248df](https://github.com/morluto/rea/commit/d2248dffd04b57902903b91d5c5114327cc3d792))
* **api-contract:** report details.limit for max_file_bytes and mark heap headroom exhaustion ([#14798](https://github.com/morluto/rea/issues/14798)) ([58a3364](https://github.com/morluto/rea/commit/58a33642f2ab43cbdb8cdc3833a6e2d297acb490))
* **apk:** disclose v1 scan scope without duplicate names ([#13572](https://github.com/morluto/rea/issues/13572)) ([110b990](https://github.com/morluto/rea/commit/110b990c687bdb498de0134dce8b49547983273a))
* **apktool:** restore package identity from decoded metadata ([#14767](https://github.com/morluto/rea/issues/14767)) ([5b2936c](https://github.com/morluto/rea/commit/5b2936c4e81b2835443b44235319b1de1f255997))
* **apple-application:** trust declared coverage for empty disk images ([#13678](https://github.com/morluto/rea/issues/13678)) ([01c0e5a](https://github.com/morluto/rea/commit/01c0e5a870ce1bf684fc1ced8d1cfa74d404e48c))
* **apple:** decode keyed archives that name another archiver ([11896a6](https://github.com/morluto/rea/commit/11896a6eb1864f4f45e4ab756bdfea93427b4eb9))
* **apple:** decode the ivar WORD_ALIGN sentinel as 8-byte alignment ([3dcd6b6](https://github.com/morluto/rea/commit/3dcd6b62e813e1d7808ee4d0554130b5aa207538))
* **apple:** observe keyed-archive dates when the offset table reaches the trailer ([#7166](https://github.com/morluto/rea/issues/7166)) ([853d8ef](https://github.com/morluto/rea/commit/853d8ef9efc0a10f652fd90a938700147b7a32e1))
* **apple:** preserve Interface Builder archive roles and omissions ([#13429](https://github.com/morluto/rea/issues/13429)) ([1f6a864](https://github.com/morluto/rea/commit/1f6a864a170e67fca964221ef4b0da4085e1daa6))
* **apple:** preserve unknown CPU subtype in dylib selection ([#14706](https://github.com/morluto/rea/issues/14706)) ([b06adc4](https://github.com/morluto/rea/commit/b06adc4b49e0e10630246dbf4da373eb5ad2b703))
* **apple:** report the declared archiver of a keyed archive ([2d182f8](https://github.com/morluto/rea/commit/2d182f865f5db5d59269b19b2f7115706ab79dfa))
* **apple:** require a $top dictionary, not a UID, for another archiver name ([b2a7cd9](https://github.com/morluto/rea/commit/b2a7cd91cc02b551e584ac7d774d8eab0e89f961))
* **apple:** rethrow internal invariant violations while resolving a bundle's program file ([#11392](https://github.com/morluto/rea/issues/11392)) ([6aa3898](https://github.com/morluto/rea/commit/6aa389831792a3d51ff6adb0dfe965c7443d955d))
* **apple:** traverse deep Objective-C protocol graphs iteratively ([#13431](https://github.com/morluto/rea/issues/13431)) ([0f771ab](https://github.com/morluto/rea/commit/0f771abed06378c1383ade0ebdac298c53510862))
* **artifacts:** commit package listings only after traversal ([#13339](https://github.com/morluto/rea/issues/13339)) ([667fa3d](https://github.com/morluto/rea/commit/667fa3d6465cae61ea17162d2aa056e0c8086e64))
* **artifacts:** explain ASAR PE signed-after-packing mismatches ([#14702](https://github.com/morluto/rea/issues/14702)) ([4edb2c0](https://github.com/morluto/rea/commit/4edb2c08eea80eeff05b0de8b592e9a76e554dd8))
* **artifacts:** isolate embedded Node SEA and .NET bundle probe errors from outer native inventory ([#14357](https://github.com/morluto/rea/issues/14357)) ([a7f8ab8](https://github.com/morluto/rea/commit/a7f8ab89a0fa73067d9ebb5d3b9c42b1f57b555a))
* **artifacts:** keep a ZIP inventory when one member uses an unsupported compression method ([#13026](https://github.com/morluto/rea/issues/13026)) ([f548a62](https://github.com/morluto/rea/commit/f548a62a4f0c6f98f9624f529d6998305139117d))
* **artifacts:** keep boot image coverage unknown when layout bytes are not exposed ([#14370](https://github.com/morluto/rea/issues/14370)) ([80c17a8](https://github.com/morluto/rea/commit/80c17a88f5db09783c5742ec8218a51702322585))
* **artifacts:** keep directory growth probes out of delivered bytes ([#13467](https://github.com/morluto/rea/issues/13467)) ([a3e7ed6](https://github.com/morluto/rea/commit/a3e7ed6d3b1a557be5b7e3ec2b535239525c3217))
* **artifacts:** keep each extracted file's limitations on that file ([0a80c0b](https://github.com/morluto/rea/commit/0a80c0bee2e63d64c1b35377271380709db853eb))
* **artifacts:** keep uImage coverage unknown when bytes follow the declared payload ([#14896](https://github.com/morluto/rea/issues/14896)) ([99d5ff7](https://github.com/morluto/rea/commit/99d5ff736136b6eda15a238538fd2ca3b0eee449)), refs [#14893](https://github.com/morluto/rea/issues/14893)
* **artifacts:** keep wxapkg coverage unknown when bytes lie outside every member ([#14922](https://github.com/morluto/rea/issues/14922)) ([1c9415d](https://github.com/morluto/rea/commit/1c9415da3bc1bc8b1266da5b62c33d3e7a69e775))
* **artifacts:** keep ZIP coverage on the byte account alone ([bd3c265](https://github.com/morluto/rea/commit/bd3c265212519600decd96d2a074684ef001b30d))
* **artifacts:** note omitted ./ member prefixes once per ZIP or tar reader ([72ef5d2](https://github.com/morluto/rea/commit/72ef5d20e0c700877e6b654c97e6e52937e03f5f))
* **artifacts:** omit required_value where reader limits know only a lower bound ([#14646](https://github.com/morluto/rea/issues/14646)) ([b41399d](https://github.com/morluto/rea/commit/b41399d8a61bb86586a2bfbd1b6fb11799ae325e))
* **artifacts:** preserve DMG verification cancellation at the deadline ([#13616](https://github.com/morluto/rea/issues/13616)) ([f18de40](https://github.com/morluto/rea/commit/f18de40af62ab25948fa8c94e4ecaa61a52353aa))
* **artifacts:** publish Node SEA metadata only after carrier validation ([#13411](https://github.com/morluto/rea/issues/13411)) ([120980c](https://github.com/morluto/rea/commit/120980cac0bc674584b8480187768cfd70972c08))
* **artifacts:** read the next tar header after header-only members ([#14500](https://github.com/morluto/rea/issues/14500)) ([e314337](https://github.com/morluto/rea/commit/e3143371298a27fd96620614a8aac94313a53008))
* **artifacts:** recognize standalone formats and route them to their readers ([#14192](https://github.com/morluto/rea/issues/14192)) ([6904da4](https://github.com/morluto/rea/commit/6904da4927685a864f164badfff02582fd18a9a5))
* **artifacts:** reject non-object GLB JSON roots and non-array images ([#14297](https://github.com/morluto/rea/issues/14297)) ([b9a5855](https://github.com/morluto/rea/commit/b9a58556f2edcb2c3547d318cff6c0d5abd4073b))
* **artifacts:** report incomplete Android sparse coverage ([#14883](https://github.com/morluto/rea/issues/14883)) ([54f2d5a](https://github.com/morluto/rea/commit/54f2d5a4e3bd07e97dada8996459e078e862eb85))
* **artifacts:** report S-record data after the final count ([#14260](https://github.com/morluto/rea/issues/14260)) ([90d774f](https://github.com/morluto/rea/commit/90d774ffed385edb783cfb7dbd08db8bbe86aef5))
* **artifacts:** report supported NES container layouts accurately ([#13499](https://github.com/morluto/rea/issues/13499)) ([321387c](https://github.com/morluto/rea/commit/321387c4319f5df167e488a827e38f3bed77eb36))
* **artifacts:** route native images to static readers and name their architecture ([#14189](https://github.com/morluto/rea/issues/14189)) ([8ed8195](https://github.com/morluto/rea/commit/8ed819573bb3a4c8ef7a373f896c52554dd8acdf))
* **artifacts:** share the examined-entry allowance across readers ([#13479](https://github.com/morluto/rea/issues/13479)) ([9560457](https://github.com/morluto/rea/commit/95604571965e9d1aec00a78665b4be64496eb094))
* **artifacts:** verify owned carriers before retrying package reads ([#13343](https://github.com/morluto/rea/issues/13343)) ([d35e142](https://github.com/morluto/rea/commit/d35e1427097919e94f926e67b8068dafa6c02f6b))
* **asar:** preserve lazy listing configuration errors ([#12854](https://github.com/morluto/rea/issues/12854)) ([aa5d1a8](https://github.com/morluto/rea/commit/aa5d1a82815d4e446a975c9d43c1d653a5971474))
* **asar:** preserve typed inventory configuration errors ([aa5d1a8](https://github.com/morluto/rea/commit/aa5d1a82815d4e446a975c9d43c1d653a5971474))
* **audit:** bind Electron fuse reads to the inventoried file ([#13348](https://github.com/morluto/rea/issues/13348)) ([0ecb6dd](https://github.com/morluto/rea/commit/0ecb6dde4b8bd7ebe3e56ef9096c9da63b40f726))
* **audit:** interpret Go trimpath rewrites at the flag parser ([#13349](https://github.com/morluto/rea/issues/13349)) ([caa2fab](https://github.com/morluto/rea/commit/caa2fab47654acf3131d7998796d4722c513a38e))
* **audit:** preserve distinct opaque CodeView paths ([#13346](https://github.com/morluto/rea/issues/13346)) ([25d0c53](https://github.com/morluto/rea/commit/25d0c53a4095ce0ba785a1ab279c08d59b71fd6b))
* **audit:** preserve explicit source map schemes ([#13345](https://github.com/morluto/rea/issues/13345)) ([d0929f9](https://github.com/morluto/rea/commit/d0929f9aa2b887dbbe2fc4ad6e1f757b7b1bd274))
* **audit:** preserve non-ASCII whitespace in Go build paths ([#13340](https://github.com/morluto/rea/issues/13340)) ([2691758](https://github.com/morluto/rea/commit/26917581d63ba53345ef70fe02cdc14486b2888a))
* **audit:** preserve owner failures after cleanup settles ([#13352](https://github.com/morluto/rea/issues/13352)) ([62114e9](https://github.com/morluto/rea/commit/62114e940f24c088a53b9e2d5f2b7e4d5be87bd1))
* **binary:** clear snapshot cache when a failed switch cannot restore ([667a005](https://github.com/morluto/rea/commit/667a0054d63a068a32b7028de237d598241ece5b))
* **binary:** keep an imported snapshot when the first open fails ([a963184](https://github.com/morluto/rea/commit/a9631842825574c025fa4482affb79f20336cc8c))
* **browser:** advertise the environment variable names a secret may not use ([#10876](https://github.com/morluto/rea/issues/10876)) ([e325216](https://github.com/morluto/rea/commit/e325216510f5cc96f7e1f244391a996bf89727fb))
* **browser:** bound armed timeline rows by the retained-event allowance ([#14799](https://github.com/morluto/rea/issues/14799)) ([7e01f1d](https://github.com/morluto/rea/commit/7e01f1df85879a1c9f78754086fa85c567d780f6))
* **browser:** bound mitmproxy replies by the inherited file limit ([465ae4d](https://github.com/morluto/rea/commit/465ae4d1d5ddbfb72b21f099d50495b174b52ee5))
* **browser:** clamp mitmproxy limits and always shut the decoder down ([919fbfb](https://github.com/morluto/rea/commit/919fbfb983d3206478904bb2a5d411c58df5a8e1))
* **browser:** deliver the analyze_web_bundle summary when no view is named ([ebe01e7](https://github.com/morluto/rea/commit/ebe01e78845ffcc9bb403cf18be153bcdd92cfe9))
* **browser:** name the CPU ceiling when mitmproxy dies with SIGXCPU ([39ade56](https://github.com/morluto/rea/commit/39ade5694b680dae47228ff26fcdfaafb74555ff))
* **browser:** name the inherited address-space limit on a decoder memory refusal ([92f3f28](https://github.com/morluto/rea/commit/92f3f28d2952508499668452adcdf285e43bf857))
* **browser:** preserve malformed request-body coverage ([#13219](https://github.com/morluto/rea/issues/13219)) ([d41af19](https://github.com/morluto/rea/commit/d41af199f0958a81fe0c3ba113decdf804110753))
* **browser:** preserve peer observations after a rejected page attachment ([#13841](https://github.com/morluto/rea/issues/13841)) ([6ecb70c](https://github.com/morluto/rea/commit/6ecb70c79c4e2d065cf0c9c2c72b57dd24596c21))
* **browser:** preserve terminal verifier startup outcomes ([#13228](https://github.com/morluto/rea/issues/13228)) ([39ccb1d](https://github.com/morluto/rea/commit/39ccb1d3b8347cf5b34d33fa86c52d5b9d69c1ea))
* **browser:** refuse partial HTTP source-map responses ([#13236](https://github.com/morluto/rea/issues/13236)) ([a7b195d](https://github.com/morluto/rea/commit/a7b195d0e1bd94908271d9216dd9bd257d8d0666))
* **browser:** reject a file URL with a hostname ([#14792](https://github.com/morluto/rea/issues/14792)) ([777832e](https://github.com/morluto/rea/commit/777832eff53babd00f91d51cd798e7a15335735e))
* **browser:** report only grammatical CORP and X-Content-Type-Options values ([1aa394d](https://github.com/morluto/rea/commit/1aa394d62d6f60809e9fbc1ca6cbfdb3341bc95f))
* **browser:** retain passive coverage and failure identity ([#13231](https://github.com/morluto/rea/issues/13231)) ([eba41af](https://github.com/morluto/rea/commit/eba41afd6c873258f7c8bb4d9a7f2d9a707e6653))
* **browser:** retire detached WebMCP frame descendants ([#13233](https://github.com/morluto/rea/issues/13233)) ([190395e](https://github.com/morluto/rea/commit/190395eade8c1164189b0e1ac4fb724f73e3bad0))
* **browser:** return completed scenario capture when cleanup is unconfirmed ([#6381](https://github.com/morluto/rea/issues/6381)) ([aa78851](https://github.com/morluto/rea/commit/aa78851b8565b6724efe8a68c134ba22bc8678e4))
* **browser:** separate the decoder CPU budget from an inherited ceiling ([947fa8f](https://github.com/morluto/rea/commit/947fa8f14d6c3688f29a440c6d6468e812897ab8))
* **browser:** settle Frida, Playwright, CDP, and Electron cleanup races ([#14786](https://github.com/morluto/rea/issues/14786)) ([d2940c8](https://github.com/morluto/rea/commit/d2940c8b355da02571d873b43a6c72e62c76447d))
* **browser:** share the capture resource-constraint constructor ([d6a5b32](https://github.com/morluto/rea/commit/d6a5b32ed0a1dd368eaeaca0d91ca30765a75581))
* **browser:** split mixed CRLF and LF headers in SAZ HTTP decoding ([#13691](https://github.com/morluto/rea/issues/13691)) ([87503ad](https://github.com/morluto/rea/commit/87503ad3bd9436bf06723e473156ac4cfa017244))
* **browser:** use Android/Termux temp directory, artifactsDir, and --disable-dev-shm-usage ([264e169](https://github.com/morluto/rea/commit/264e169f74632b37581d50d135f083f7412ffda9)), refs [#14745](https://github.com/morluto/rea/issues/14745)
* **build:** keep Windows import symbols independent of the build path ([#12753](https://github.com/morluto/rea/issues/12753)) ([f85fae6](https://github.com/morluto/rea/commit/f85fae63e149a8164e17949f65f7884fd043a4b5))
* **bun:** keep budget refusals out of layout selection ([#12763](https://github.com/morluto/rea/issues/12763)) ([ae72c30](https://github.com/morluto/rea/commit/ae72c30e2c4b37b1ab24028d474e8e40502feb46))
* **call-path:** bound inline shortest-path enumeration ([#4984](https://github.com/morluto/rea/issues/4984)) ([e99d0b2](https://github.com/morluto/rea/commit/e99d0b2d86431c3b20b662c3d706fb5c932079a5))
* **capture:** distinguish corrupt SAZ metadata bytes ([#13204](https://github.com/morluto/rea/issues/13204)) ([ff3919f](https://github.com/morluto/rea/commit/ff3919f3eb9bbbe311b1632990da29776a1fb407))
* **capture:** keep credential checks independent of body filters ([#13215](https://github.com/morluto/rea/issues/13215)) ([587cca5](https://github.com/morluto/rea/commit/587cca5c5c82fbb4bb86307670fe79638ff82003))
* **capture:** retain credential checks across MIME conflicts ([#13209](https://github.com/morluto/rea/issues/13209)) ([6152c02](https://github.com/morluto/rea/commit/6152c02f3f384723f6fac2470b380b682e1c6387))
* **capture:** surface unsupported decoder requirements ([#13203](https://github.com/morluto/rea/issues/13203)) ([088bc68](https://github.com/morluto/rea/commit/088bc68b1cbddb11b7432e7541ba66f47409abf2))
* **ci/tests:** bound untyped oxlint threads and fail fast on terminal POSIX poll errors ([#13447](https://github.com/morluto/rea/issues/13447)) ([07df0f1](https://github.com/morluto/rea/commit/07df0f1c04779a54f0a2b84233a3e3b9638fca4d))
* **ci:** accept a skipped selection the macOS lane runs ([2dcdacc](https://github.com/morluto/rea/commit/2dcdacce922ddafd85d0b2a9e78dbfa3ad8fa8ad)), refs [#14596](https://github.com/morluto/rea/issues/14596)
* **ci:** bind timing evidence to its workflow attempt ([#14080](https://github.com/morluto/rea/issues/14080)) ([bc19c8d](https://github.com/morluto/rea/commit/bc19c8d21fbe26be280db55faae92bac2c12c20e))
* **ci:** bound browser runtime fixture source readiness ([#14364](https://github.com/morluto/rea/issues/14364)) ([a9e34a4](https://github.com/morluto/rea/commit/a9e34a4aaef89138d7b89da7f9d1965bafe16365))
* **ci:** bound packet capture prerequisite acquisition ([#14716](https://github.com/morluto/rea/issues/14716)) ([1a09a8e](https://github.com/morluto/rea/commit/1a09a8ef469ae6fa05eb81078221e9b1896729ee))
* **ci:** check the MCP SDK validator option in its constructor slot ([#13266](https://github.com/morluto/rea/issues/13266)) ([411e78e](https://github.com/morluto/rea/commit/411e78ea64355320c034f40ea0fda6c089255b28))
* **ci:** clear stale static diagnostic context before recording ([#14713](https://github.com/morluto/rea/issues/14713)) ([2a4c8cc](https://github.com/morluto/rea/commit/2a4c8ccfba945b051d8aeddcf305cf9158e3c84b))
* **ci:** close static-check cache gaps and prune stale settings ([#14017](https://github.com/morluto/rea/issues/14017)) ([5817ebb](https://github.com/morluto/rea/commit/5817ebb288612f5aa364398ec1d5e70006888203))
* **ci:** fall back to Ubuntu Azure archive in recorded-crash container ([#14061](https://github.com/morluto/rea/issues/14061)) ([d02be92](https://github.com/morluto/rea/commit/d02be9207e3060c882273b526a5d7acb2522c781))
* **ci:** fall back when a changed test fixture has no traced consumer ([#14709](https://github.com/morluto/rea/issues/14709)) ([48adc9d](https://github.com/morluto/rea/commit/48adc9df0bddcb9f3c27eb48db7bec183fe01820))
* **ci:** include the cache retention helper dependency ([#14689](https://github.com/morluto/rea/issues/14689)) ([8d302d2](https://github.com/morluto/rea/commit/8d302d2dade726f720520fa1addaaabfda6212e5))
* **ci:** keep equal-duration shard allocation from leaving jobs empty ([#14257](https://github.com/morluto/rea/issues/14257)) ([5aef49a](https://github.com/morluto/rea/commit/5aef49a421bf6ccefc5f55dbf1b032c77dba49a8))
* **ci:** keep static diagnostics for each workflow attempt ([#14360](https://github.com/morluto/rea/issues/14360)) ([d15068e](https://github.com/morluto/rea/commit/d15068e2b441354291ea45b6a7fe4fa574e736f0))
* **ci:** make Windows native artifact uploads retryable ([#14362](https://github.com/morluto/rea/issues/14362)) ([3015c13](https://github.com/morluto/rea/commit/3015c13bcd0794e31e546d76cbfacafabb9bef9e))
* **ci:** preserve CodeQL PR checkout history and exclude non-shipped verifiers ([#14385](https://github.com/morluto/rea/issues/14385)) ([42bbf33](https://github.com/morluto/rea/commit/42bbf33f2d29aadcaedf6f25d477c8e59157bdd0))
* **ci:** preserve the 75-minute npm visibility deadline ([#14761](https://github.com/morluto/rea/issues/14761)) ([5865eee](https://github.com/morluto/rea/commit/5865eeea93a430db83bf07744237b80e435548a7))
* **ci:** read portable build plan from a file instead of a pipe ([#13456](https://github.com/morluto/rea/issues/13456)) ([60dfeec](https://github.com/morluto/rea/commit/60dfeec745235e7b8c6f524b54960dbb31729dd9))
* **ci:** recheck pull request eligibility during health scans ([#14365](https://github.com/morluto/rea/issues/14365)) ([5411689](https://github.com/morluto/rea/commit/5411689a5ca3e06b93ecbef9925e927e8d3a2708))
* **ci:** refresh health diagnostics on workflow retries ([#14349](https://github.com/morluto/rea/issues/14349)) ([5095e12](https://github.com/morluto/rea/commit/5095e1205935b7a4eb7e2d4d1140c6977c641af9))
* **ci:** reject incomplete merged test timing reports ([#14352](https://github.com/morluto/rea/issues/14352)) ([8a77faf](https://github.com/morluto/rea/commit/8a77faf842e9a3ef5ac54a5fb7aae7424d87ca80))
* **ci:** remove unused exports flagged by deep checks ([#14852](https://github.com/morluto/rea/issues/14852)) ([412f927](https://github.com/morluto/rea/commit/412f92736e099899a6a4257ffd65ce926337ea0a))
* **ci:** remove unused Mach-O classifier failing deep static checks ([#14384](https://github.com/morluto/rea/issues/14384)) ([66f6559](https://github.com/morluto/rea/commit/66f65594f57f1ed3c63db2a43af3139e6962295c))
* **ci:** require complete path references for test coverage ([#14819](https://github.com/morluto/rea/issues/14819)) ([cd744b1](https://github.com/morluto/rea/commit/cd744b1bfbca7d0951762d9711c6a1263dfe4bfd))
* **ci:** rerun TODO scans against the host interpreter ([ba093e0](https://github.com/morluto/rea/commit/ba093e0777a1480d45e4391a65b54b4b7c8bd40f))
* **ci:** retain cache generations per restore version ([#14084](https://github.com/morluto/rea/issues/14084)) ([30b8249](https://github.com/morluto/rea/commit/30b82493ab7f8a1b95be7e5a498ef3bcf5345324))
* **ci:** retry recorded crash dependency acquisition without stale index cache ([#14076](https://github.com/morluto/rea/issues/14076)) ([98beb54](https://github.com/morluto/rea/commit/98beb5424acc52e6e6116411bf738cb88fa9d8aa))
* **ci:** retry release history reads after transport disconnects ([dcb36f6](https://github.com/morluto/rea/commit/dcb36f66c7ae28b9fd7ea529a914eeea3d37cbaa))
* **ci:** run type-aware lint on changed files in fast PRs ([#14068](https://github.com/morluto/rea/issues/14068)) ([313f2f8](https://github.com/morluto/rea/commit/313f2f8372e3d9d6944197ebe4aa6ea48034a532))
* **ci:** search older successful timing runs within budget ([#14363](https://github.com/morluto/rea/issues/14363)) ([185700f](https://github.com/morluto/rea/commit/185700f49650b77b37f68711bd96f6c2c905146f))
* **ci:** select coverage guards for modified test registrations ([#12860](https://github.com/morluto/rea/issues/12860)) ([75fe508](https://github.com/morluto/rea/commit/75fe508eb45982447521be4d5849ccadf3ab8401))
* **ci:** select the macOS lane when every selected test may be gated to it ([48cef46](https://github.com/morluto/rea/commit/48cef4662f8c344aea1afabf20d88a1581b2d937))
* **ci:** shard exact test specifications before execution ([#14499](https://github.com/morluto/rea/issues/14499)) ([0069fee](https://github.com/morluto/rea/commit/0069feeccf7f06534d6abd8e960dc49526fe73b0))
* **ci:** trace test dependencies through static template imports ([#14079](https://github.com/morluto/rea/issues/14079)) ([9e24673](https://github.com/morluto/rea/commit/9e24673620e08e939980b910db7936bda1532c92))
* **ci:** track configuration inputs across cached checks ([#14015](https://github.com/morluto/rea/issues/14015)) ([4fdacbf](https://github.com/morluto/rea/commit/4fdacbf982c1bb409dda50cb80ba3eec74dd259e))
* **ci:** use retry start times in PR health reporting ([#14085](https://github.com/morluto/rea/issues/14085)) ([caf5f4e](https://github.com/morluto/rea/commit/caf5f4e38a1ec1a71dacf77130c211d6b0e3229b))
* **ci:** verify packaged Agent Environment bridges ([#12874](https://github.com/morluto/rea/issues/12874)) ([41fc470](https://github.com/morluto/rea/commit/41fc470072d441eefc3536a3de4a3ebb7902b5e4))
* **cli:** accept only the documented kebab-case option spelling ([#14204](https://github.com/morluto/rea/issues/14204)) ([c4fa5b4](https://github.com/morluto/rea/commit/c4fa5b475c26b6cce0e301154dad928634d84f2b))
* **cli:** complete inline option values ([#13366](https://github.com/morluto/rea/issues/13366)) ([0451a86](https://github.com/morluto/rea/commit/0451a8688d55c389c67048fa7764af0c0d5a8ab1))
* **cli:** count and page emitted output with tokenx 2 ([#14330](https://github.com/morluto/rea/issues/14330)) ([948835a](https://github.com/morluto/rea/commit/948835a41e04c0d0c6eacac71d6ee4428418981d))
* **cli:** deliver an unretained non-idempotent result complete ([c536c67](https://github.com/morluto/rea/commit/c536c67ee18bbde27d6a0f16bb6a3f1d3ae18ae4))
* **cli:** describe universal Mach-O slice selection without a single-dash flag ([#14912](https://github.com/morluto/rea/issues/14912)) ([3097263](https://github.com/morluto/rea/commit/3097263763611eb0c32c502d5a222060cf02f468))
* **cli:** enforce the retained Evidence cap on bundle reuse ([#14838](https://github.com/morluto/rea/issues/14838)) ([807cd63](https://github.com/morluto/rea/commit/807cd6366c55aede5466f3f9f0c0e4410a85d8c7))
* **cli:** isolate a synchronous resource-closer throw ([#14796](https://github.com/morluto/rea/issues/14796)) ([1c8b3b6](https://github.com/morluto/rea/commit/1c8b3b64e864f886b81d85b99f2ebe70536e781d))
* **cli:** list --columns among the global options in help ([#14981](https://github.com/morluto/rea/issues/14981)) ([3c60922](https://github.com/morluto/rea/commit/3c60922615b3140d70454c5b4e4d814d9c278027))
* **cli:** load Electron fuse inspection on demand ([#13922](https://github.com/morluto/rea/issues/13922)) ([b48b986](https://github.com/morluto/rea/commit/b48b9860a4e646793b9972d09b76fecb52e04d24))
* **cli:** preserve doctor routing with empty output values ([#13262](https://github.com/morluto/rea/issues/13262)) ([a06e04b](https://github.com/morluto/rea/commit/a06e04b4dfcd994a426cc6b6ab77082260b95a3f))
* **cli:** preserve explicit null output ([#13342](https://github.com/morluto/rea/issues/13342)) ([d4f78cb](https://github.com/morluto/rea/commit/d4f78cb5922d9fd83222514dda85db8bf5287f1b))
* **cli:** register Kilo in linked worktrees of bare repositories ([#13285](https://github.com/morluto/rea/issues/13285)) ([27657b7](https://github.com/morluto/rea/commit/27657b7420a765d13f6e58e212c2b897900b5154))
* **cli:** reject invalid inline values and honor requested output on terminals ([#14763](https://github.com/morluto/rea/issues/14763)) ([2bf347d](https://github.com/morluto/rea/commit/2bf347dee664793c013038514b3524edff463127))
* **cli:** reject nonnumeric output slice bounds ([#13344](https://github.com/morluto/rea/issues/13344)) ([9a6ee71](https://github.com/morluto/rea/commit/9a6ee7188697c5e99616dbb75154ce2cdbc79af7))
* **cli:** report argv parse failures as PARSE_ERROR ([c5cbb21](https://github.com/morluto/rea/commit/c5cbb212d7a3e370ffbd47df9fcb9d1393cae0ab))
* **cli:** report retained MCP registration backups on typed failures ([#13268](https://github.com/morluto/rea/issues/13268)) ([c1a1de9](https://github.com/morluto/rea/commit/c1a1de9bfb385e1ba15519779fd0680bd737ebfd))
* **cli:** spell a target failure's recovery with CLI commands and options ([#14289](https://github.com/morluto/rea/issues/14289)) ([299c592](https://github.com/morluto/rea/commit/299c592b636de2080f6ce123e5fbc58effce45f2))
* **config:** preserve unknown Harness group ownership ([#13434](https://github.com/morluto/rea/issues/13434)) ([eb3f35e](https://github.com/morluto/rea/commit/eb3f35ea05c7a1657bab40ed5fe35566092e1c88))
* **contracts/mcp:** collapse Evidence wire schemas, project type lists, preserve discover_tools guidance ([#13752](https://github.com/morluto/rea/issues/13752)) ([f6a83f1](https://github.com/morluto/rea/commit/f6a83f1fcf6a1fa95a69ade0b0176f19516015fd))
* **cutter/ghidra:** fix Cutter DAG limit rejection, guard Ghidra x86-32 SEH scan, and cache referenced address lookups ([#13478](https://github.com/morluto/rea/issues/13478)) ([ccdc887](https://github.com/morluto/rea/commit/ccdc887dc1b640b151e1cd594201a5406d72b8a2))
* **cyclonedx:** keep recorded tool references unique ([#13425](https://github.com/morluto/rea/issues/13425)) ([7db00e8](https://github.com/morluto/rea/commit/7db00e8fd6306b880a7f25e5418de5a475761485))
* **deb:** preserve byte-counted PAX values ([#14958](https://github.com/morluto/rea/issues/14958)) ([8ff3570](https://github.com/morluto/rea/commit/8ff3570430ad682061b7932b9953d45b904cb487))
* **deb:** preserve Unicode separators in md5sums filenames ([#14854](https://github.com/morluto/rea/issues/14854)) ([0a15311](https://github.com/morluto/rea/commit/0a1531145c4eb9e2504f6dafb11937e49b64df8a))
* **decompile:** keep the functions directory identity on mounts that renumber after chmod ([#14324](https://github.com/morluto/rea/issues/14324)) ([217f498](https://github.com/morluto/rea/commit/217f498945f656cef207118d241f68a80de51d6c))
* **delivery:** summarize by size only where the summary can be paged ([89919c8](https://github.com/morluto/rea/commit/89919c836d690e62b178880fd0c65e0303a33f3f))
* **deps:** parse classes extending module with Babel 8.1.3 ([#14924](https://github.com/morluto/rea/issues/14924)) ([9005a43](https://github.com/morluto/rea/commit/9005a43f341f2f30c515d2c8a28ecf35d64abde8))
* **deps:** use patched minimatch in development tooling ([#14945](https://github.com/morluto/rea/issues/14945)) ([dc31300](https://github.com/morluto/rea/commit/dc313007b9b92e01b2b83c61eb4fe75865a4126c))
* **deps:** verify Brainpool publisher signatures with OpenPGP.js 6.3.3 ([#14914](https://github.com/morluto/rea/issues/14914)) ([6cebca7](https://github.com/morluto/rea/commit/6cebca7b07dc644e2e6e55772d3ab14250a9ac70))
* **desktop:** anchor draft text checks through reflow ([#13708](https://github.com/morluto/rea/issues/13708)) ([7add65d](https://github.com/morluto/rea/commit/7add65ddec97017d7a7d7ba83057aeb9eb529e4d))
* **desktop:** avoid suggesting edits from incomparable views ([#13596](https://github.com/morluto/rea/issues/13596)) ([7673ab0](https://github.com/morluto/rea/commit/7673ab03a6cb26f045adcffe803801ee71102cb1))
* **desktop:** bound positioned note guards ([#13711](https://github.com/morluto/rea/issues/13711)) ([b988006](https://github.com/morluto/rea/commit/b9880064fd36f26672fefc755bd28030dc6a6d29))
* **desktop:** claim agentenv capture exclusively and survive FIFO write errors ([#12838](https://github.com/morluto/rea/issues/12838)) ([72f8f52](https://github.com/morluto/rea/commit/72f8f521a68722c64e229fa5174b17d1822750de))
* **desktop:** classify complete filename boundary code points ([d9f2fd3](https://github.com/morluto/rea/commit/d9f2fd365dea6622e90bad56f29b278920e0fee2))
* **desktop:** distinguish dconf export recovery causes ([#13574](https://github.com/morluto/rea/issues/13574)) ([0ab2603](https://github.com/morluto/rea/commit/0ab26032768b8c10f99b825ba498d4128f7e8d92))
* **desktop:** explain unavailable dconf descriptor paths ([#13391](https://github.com/morluto/rea/issues/13391)) ([5b2bc6c](https://github.com/morluto/rea/commit/5b2bc6c43d5cbabbce8142bf77137b20ec0a6829))
* **desktop:** keep automatically named checkpoints distinct ([#13387](https://github.com/morluto/rea/issues/13387)) ([0b62db4](https://github.com/morluto/rea/commit/0b62db4d63a57e0196e1f2bd3b1e7eccb8ac707d))
* **desktop:** keep every state-reader close failure in the cleanup composite ([10597e1](https://github.com/morluto/rea/commit/10597e10f233bb7ae1306a441e5770880cb2976a)), refs [#11859](https://github.com/morluto/rea/issues/11859)
* **desktop:** keep export and task drafts on the admitted capture ([#13418](https://github.com/morluto/rea/issues/13418)) ([cbafdaa](https://github.com/morluto/rea/commit/cbafdaa8e3f03dafdc3a454d89bde4b6c56bf64b))
* **desktop:** leave host-dependent ELF library names unresolved ([1b2299c](https://github.com/morluto/rea/commit/1b2299c7f80f831af6f5243f6ea82b887a482c00))
* **desktop:** match title filenames at Unicode boundaries ([d07d28b](https://github.com/morluto/rea/commit/d07d28b53348b820a8a3769b5b1fd45f8096015d))
* **desktop:** preserve draft selector and text boundaries ([#13703](https://github.com/morluto/rea/issues/13703)) ([2cd7ff2](https://github.com/morluto/rea/commit/2cd7ff220431eb8cca3c1e4e0fe62c12de6f393d))
* **desktop:** preserve dynamic-token refusal wording ([efe6927](https://github.com/morluto/rea/commit/efe692721ea5206cd98f0847c2978c365f8bb289))
* **desktop:** publish omissions only from completed checkpoints ([#13389](https://github.com/morluto/rea/issues/13389)) ([359f854](https://github.com/morluto/rea/commit/359f85447744ce69e7ef3389e4098f74bed3b644))
* **desktop:** recover acknowledged checkpoint after screenshot cancellation ([#13390](https://github.com/morluto/rea/issues/13390)) ([de0679e](https://github.com/morluto/rea/commit/de0679e2c0a4fa42e8aca2fc8fcb5149b99bdad4))
* **desktop:** reject invalid task pointer escapes ([361be4c](https://github.com/morluto/rea/commit/361be4cb630f54820f1b2702df0982e1dc7f81de))
* **desktop:** report JSON view depth after reviver stack exhaustion ([#12759](https://github.com/morluto/rea/issues/12759)) ([6a0a5e7](https://github.com/morluto/rea/commit/6a0a5e73790c8670631618878a5ca26b860fe758))
* **desktop:** respect TryExec when selecting Linux launchers ([b185803](https://github.com/morluto/rea/commit/b185803bc8262e41adaa34943e278ba38924939e))
* **desktop:** retain reader scratch files under its cleanup owner ([#9775](https://github.com/morluto/rea/issues/9775)) ([0d67095](https://github.com/morluto/rea/commit/0d67095295c2704ef4d92929578e3c209e5b9f05))
* **desktop:** skip only ASCII whitespace before a desktop entry key ([#13126](https://github.com/morluto/rea/issues/13126)) ([a44e705](https://github.com/morluto/rea/commit/a44e705ad820d24e95577b4f61a3dc633ca4fcb8))
* **desktop:** tear down build computers whose reader or run state is uncertain ([#14778](https://github.com/morluto/rea/issues/14778)) ([0844339](https://github.com/morluto/rea/commit/084433987d666f2b17ebd671341401438f6466aa))
* **devicetree:** validate retained report ranges and coverage ([#14066](https://github.com/morluto/rea/issues/14066)) ([a5f735c](https://github.com/morluto/rea/commit/a5f735c67b2226ec66913add6b5424a884ad5c11))
* **docs:** align translated READMEs and verify catalog links ([d2a8b8d](https://github.com/morluto/rea/commit/d2a8b8d3d639827a9800fc4dea16fd772573b054))
* **doctor:** emit each check once and classify passing checks healthy ([#14251](https://github.com/morluto/rea/issues/14251)) ([f986b25](https://github.com/morluto/rea/commit/f986b25df9e8668491096245ce8b3e5acb3325ca))
* **doctor:** report startup timeouts independently of launcher discovery ([#13420](https://github.com/morluto/rea/issues/13420)) ([255a585](https://github.com/morluto/rea/commit/255a585c0a06975d0855f169f5e80663b642658d))
* **domain:** keep worker, SQLite, and sealing invariants owned ([#14770](https://github.com/morluto/rea/issues/14770)) ([9e3a2bb](https://github.com/morluto/rea/commit/9e3a2bbc09872eba06fc4bd09b0547762d385e06))
* **domain:** make partial count switches exhaustive for typed lint ([#14048](https://github.com/morluto/rea/issues/14048)) ([4298507](https://github.com/morluto/rea/commit/42985076ac43814d3cf60a8b97687240980304d0))
* **dotnet:** retain validated bundle entries across enumerations ([f43cacb](https://github.com/morluto/rea/commit/f43cacb61b16d2d8128088480f4140ee0c8d7a5c))
* **dotnet:** reuse validated bundle entries across enumerations ([#14885](https://github.com/morluto/rea/issues/14885)) ([f43cacb](https://github.com/morluto/rea/commit/f43cacb61b16d2d8128088480f4140ee0c8d7a5c))
* **dwarf:** bound PE COFF section-name decoding with max_structure_bytes ([#14787](https://github.com/morluto/rea/issues/14787)) ([d97b796](https://github.com/morluto/rea/commit/d97b79607677d15a1588e358c2b2e887bf6fb793))
* **dwarf:** reject PE long section names when PointerToSymbolTable is zero ([#13889](https://github.com/morluto/rea/issues/13889)) ([a46bc22](https://github.com/morluto/rea/commit/a46bc22117928c04e2aefee04d629597b3393378))
* **electron:** preserve inspection frame identity and diagnostics ([#13232](https://github.com/morluto/rea/issues/13232)) ([04d399d](https://github.com/morluto/rea/commit/04d399d67539fa9fbf07a2ce6d93b058808c7101))
* **electron:** preserve waits and cancellation through renderer shutdown ([#12972](https://github.com/morluto/rea/issues/12972)) ([2533a8b](https://github.com/morluto/rea/commit/2533a8b32bf2d8e4c052f6ea5c7e616a93660a9f))
* **electron:** resolve exact local IPC channel values ([#13005](https://github.com/morluto/rea/issues/13005)) ([e66a27c](https://github.com/morluto/rea/commit/e66a27c2f2bb294a0506e6d2d6cf9d2f0125b9e2))
* **electron:** trace IPC channels and bridge keys spelled as exact templates ([#9538](https://github.com/morluto/rea/issues/9538)) ([7cf0f35](https://github.com/morluto/rea/commit/7cf0f35b4b9370ba246bbed7a8b4094b29175da8))
* **elf:** bound COPY relocation symbol lookup by dynamic hash symbol count ([#14519](https://github.com/morluto/rea/issues/14519)) ([d23c9cc](https://github.com/morluto/rea/commit/d23c9cc362d8d501299dc47ec5fc234c41166cfa))
* **elf:** bound dynamic version tables to mapped bytes ([#13446](https://github.com/morluto/rea/issues/13446)) ([2e1144b](https://github.com/morluto/rea/commit/2e1144b0ca63585bdbac189cd75b51c7c6d3f570))
* **elf:** clear the ARM Thumb bit before naming unwind ranges ([#9692](https://github.com/morluto/rea/issues/9692)) ([ce3506e](https://github.com/morluto/rea/commit/ce3506e298e1a42d111a08613821ce8868f411cd))
* **elf:** do not count SPARC register declarations as imports ([d955cd0](https://github.com/morluto/rea/commit/d955cd0d60558a3f884b057e9aa6653b7652134d))
* **elf:** establish direct initializer slot mappings ([#13452](https://github.com/morluto/rea/issues/13452)) ([bb81b0a](https://github.com/morluto/rea/commit/bb81b0a88dbb95dce6e86e737e35889e74d5deb0))
* **elf:** leave the unwind GOT base unknown when DT_PLTGOT is not established ([2761248](https://github.com/morluto/rea/commit/27612481f00f2d63db48d5e41acc9ebe1c2f5cb4)), refs [#12446](https://github.com/morluto/rea/issues/12446)
* **elf:** mark missing tables unreadable when dynamic counts are nonzero ([#14291](https://github.com/morluto/rea/issues/14291)) ([3624a9c](https://github.com/morluto/rea/commit/3624a9c1ab4f60843d786f95cb2e4871198329af))
* **elf:** name the auxv types current Linux kernels write ([#13569](https://github.com/morluto/rea/issues/13569)) ([0aecef3](https://github.com/morluto/rea/commit/0aecef3726c216d931d7b085725a50f099eb9e58))
* **elf:** preserve kernel config framing and location provenance ([#14021](https://github.com/morluto/rea/issues/14021)) ([fabe0da](https://github.com/morluto/rea/commit/fabe0da74b5f2c3807b5e01be88bff476ea74a38))
* **elf:** read build IDs without decoding unrelated notes ([#13776](https://github.com/morluto/rea/issues/13776)) ([4a62303](https://github.com/morluto/rea/commit/4a623037170d4e50e2c5e7c83f84150a726a19a6))
* **elf:** read eight-byte DT_HASH entries on 64-bit s390x and Alpha ([#14630](https://github.com/morluto/rea/issues/14630)) ([a140853](https://github.com/morluto/rea/commit/a140853e9fc43ae08d378677654c48c40d5915ac))
* **elf:** report proven version and dynamic symbol facts ([#13441](https://github.com/morluto/rea/issues/13441)) ([c7f89cd](https://github.com/morluto/rea/commit/c7f89cd8b5b11025b72672af3c010e33e40496f3))
* **elf:** respect compressed note storage across inspectors ([#13762](https://github.com/morluto/rea/issues/13762)) ([a4f9c23](https://github.com/morluto/rea/commit/a4f9c2309bc8cb2a8ababee9a8b7583d633e019d))
* **elf:** retain authenticated debug-link evidence on interruption ([#13437](https://github.com/morluto/rea/issues/13437)) ([7fc333f](https://github.com/morluto/rea/commit/7fc333ffa0cf6546716120152c2cbf5f54cd0457))
* **elf:** retain verified artifact reports through descriptor finalization ([fbf7963](https://github.com/morluto/rea/commit/fbf79630d23a02ef26bb560dbdbc17ed3055b992))
* **elf:** retain verified debug-link evidence through descriptor finalization ([#13986](https://github.com/morluto/rea/issues/13986)) ([1032be8](https://github.com/morluto/rea/commit/1032be8314085309713302d5c26f7f8d2e023e9e))
* **elf:** retain verified kernel reports through descriptor finalization ([#14022](https://github.com/morluto/rea/issues/14022)) ([1689fb3](https://github.com/morluto/rea/commit/1689fb3c1256e7a5698bf82e3079b2774a89bb39))
* **elf:** return 64 unwind ranges by default, as PE unwind ranges do ([17eef93](https://github.com/morluto/rea/commit/17eef93a0a794e3bf943af0539be562959928133))
* **elf:** validate core paths before charging mapping output ([#13771](https://github.com/morluto/rea/issues/13771)) ([7c75a5f](https://github.com/morluto/rea/commit/7c75a5f91b704105bc55711c5c6da2ec155bb077))
* **entropy:** keep the whole-file census in a counter that cannot wrap ([a3acfcf](https://github.com/morluto/rea/commit/a3acfcf003a1213c751a46051630f06023766d1f))
* **environment:** admit state records before decoding timing ([#13795](https://github.com/morluto/rea/issues/13795)) ([61e8f73](https://github.com/morluto/rea/commit/61e8f73f4be15d8cae6926fc8ca2d06a52b87d60))
* **environment:** budget request shapes at the owning view ([#13852](https://github.com/morluto/rea/issues/13852)) ([c5361cb](https://github.com/morluto/rea/commit/c5361cbe8bdd16f54cb958ad00bc8081e31727bd))
* **environment:** prefer live collection spellings for writes ([#13603](https://github.com/morluto/rea/issues/13603)) ([65943f9](https://github.com/morluto/rea/commit/65943f934b00cab7d8e02837b4b4bd4e090a67da))
* **environment:** preserve caller query provenance on writes ([#13637](https://github.com/morluto/rea/issues/13637)) ([6d8e0f0](https://github.com/morluto/rea/commit/6d8e0f09fcfbbb5dde772ca775ef72fb5e79b1a1))
* **environment:** preserve document write replay match provenance ([#13604](https://github.com/morluto/rea/issues/13604)) ([5deee1a](https://github.com/morluto/rea/commit/5deee1acf1f0163a6a5d60568a841ade32811bf5))
* **environment:** preserve state-backed read match provenance ([#13621](https://github.com/morluto/rea/issues/13621)) ([3c51cde](https://github.com/morluto/rea/commit/3c51cde2ef434c085343fb588fb6e1cfde991f9c))
* **environment:** release abort listeners when waits settle ([#14730](https://github.com/morluto/rea/issues/14730)) ([10502f8](https://github.com/morluto/rea/commit/10502f8fa1161c8f81caadb1f43cbbbf585c88d7))
* **environment:** release terminal state response readers ([#13830](https://github.com/morluto/rea/issues/13830)) ([89ecf87](https://github.com/morluto/rea/commit/89ecf87810f2db473c0b3de443604cf350d56d75))
* **erlang:** require complete positional BEAM reads ([#14045](https://github.com/morluto/rea/issues/14045)) ([2e47bc0](https://github.com/morluto/rea/commit/2e47bc09f357cf6e5bcc6c93f39e4972bd79192e))
* **erlang:** retain verified BEAM reports through descriptor finalization ([#14062](https://github.com/morluto/rea/issues/14062)) ([2e98c70](https://github.com/morluto/rea/commit/2e98c70c911f5062bad2e3045e557f90cf886d54))
* **errors:** align unsupported-signature status and split invalid-method-token at its producer ([#14230](https://github.com/morluto/rea/issues/14230)) ([eb6c281](https://github.com/morluto/rea/commit/eb6c281fec68568aa95e7cbef59fe1c9eade99e5))
* **errors:** classify failures from the first reported system code ([#14686](https://github.com/morluto/rea/issues/14686)) ([a8fdc09](https://github.com/morluto/rea/commit/a8fdc0961bb288b58f66b98aa6cfa8943a5cf814))
* **errors:** keep only changed reader integrity checks retryable ([b7f662b](https://github.com/morluto/rea/commit/b7f662bd1935378559d240f17b3ff5a8e81ef544))
* **errors:** raise container reader byte faults as malformed or truncated targets ([#14265](https://github.com/morluto/rea/issues/14265)) ([6f26702](https://github.com/morluto/rea/commit/6f267022ed076d3e0df003f03b426fad8db50c3b))
* **errors:** refuse corrupt managed, IL2CPP and universal Mach-O bytes as a malformed target ([#14224](https://github.com/morluto/rea/issues/14224)) ([57f4e3c](https://github.com/morluto/rea/commit/57f4e3c4bd7577336f344f5ec5b14a5ea0c9ce6b))
* **errors:** refuse malformed SQLite, pwntools and EVM inputs as target failures ([#14268](https://github.com/morluto/rea/issues/14268)) ([a61ff39](https://github.com/morluto/rea/commit/a61ff39c9a59c172e9ab6941a5a4c488db2968f1))
* **errors:** refuse malformed target bytes as a target, not invalid input ([#14195](https://github.com/morluto/rea/issues/14195)) ([89c1dd3](https://github.com/morluto/rea/commit/89c1dd3c327617275a0792a78a68a043f1a37533))
* **errors:** report a capability refusal as retryable once cleanup settles ([#14124](https://github.com/morluto/rea/issues/14124)) ([6a7924f](https://github.com/morluto/rea/commit/6a7924f5ed7593eb75c8f770d730fc91452a4824))
* **errors:** report inventory refusals as target failures of the selected path ([#14277](https://github.com/morluto/rea/issues/14277)) ([c214fc4](https://github.com/morluto/rea/commit/c214fc44a8db4fe678fc23823f08d44b1b79ff52))
* **errors:** report managed coverage gaps and IL2CPP pair conflicts as target failures ([#14272](https://github.com/morluto/rea/issues/14272)) ([3e01e71](https://github.com/morluto/rea/commit/3e01e71cbb4c3838be1fcde4f78cd37caca68145))
* **errors:** report unsupported and unrecognized targets on the TargetFailure model ([#14281](https://github.com/morluto/rea/issues/14281)) ([38bf511](https://github.com/morluto/rea/commit/38bf511a50c042b67c9bb0098208cf6f8a231dad))
* **errors:** split reader path refusals from malformed target bytes ([#14225](https://github.com/morluto/rea/issues/14225)) ([1a43f56](https://github.com/morluto/rea/commit/1a43f56354bcda71cc6a0e7ace27d48680073505))
* **evidence:** bound omitted validation issue locations ([#13309](https://github.com/morluto/rea/issues/13309)) ([4485912](https://github.com/morluto/rea/commit/4485912fd83b64834cc88e5af9bcd7febe2baae8))
* **evidence:** evaluate unchanged artifact members in correlation ([460d771](https://github.com/morluto/rea/commit/460d77176e9634a6e052e4993ddd03be1489bec9)), refs [#13211](https://github.com/morluto/rea/issues/13211)
* **evidence:** keep unobserved correlation paths unknown without complete coverage ([94232d0](https://github.com/morluto/rea/commit/94232d0d5f1addb2b0a45477bc67bd681e3d9282)), refs [#13211](https://github.com/morluto/rea/issues/13211)
* **evidence:** preserve saved identities with canonicalize 5 ([#8132](https://github.com/morluto/rea/issues/8132)) ([417beaf](https://github.com/morluto/rea/commit/417beaf3a5b486612f94e0af7226d99e5d7031c6))
* **evidence:** reject unknown fields in comparison record pairs ([#13523](https://github.com/morluto/rea/issues/13523)) ([0eaea65](https://github.com/morluto/rea/commit/0eaea650c0c91574c66e5383073397d652bb42eb))
* **evm:** decode Solidity metadata with cborg 7 ([#14329](https://github.com/morluto/rea/issues/14329)) ([c9b2df0](https://github.com/morluto/rea/commit/c9b2df0083f0eef00d0e818eef55542e4d1265e9))
* **evm:** report the locked EVMole engine version ([#14407](https://github.com/morluto/rea/issues/14407)) ([ef4945c](https://github.com/morluto/rea/commit/ef4945cd018aa456e1672be7442eb719a4615d81))
* **examples:** pin the CI example to the current REA release ([#14201](https://github.com/morluto/rea/issues/14201)) ([75c733a](https://github.com/morluto/rea/commit/75c733acb487791345ce93f43aa077e109136813))
* **exports:** bind provider caveats to accepted observations ([#13430](https://github.com/morluto/rea/issues/13430)) ([ac3f83f](https://github.com/morluto/rea/commit/ac3f83f0f2172448c5a61872107ec4882d665360))
* **firmware:** honor the final Android OTA timestamp record ([#13373](https://github.com/morluto/rea/issues/13373)) ([e84668c](https://github.com/morluto/rea/commit/e84668c76be4df40963dbd83f84803ec812f64c5))
* **firmware:** mark ESP flash coverage unknown when bootloader region is omitted ([#14285](https://github.com/morluto/rea/issues/14285)) ([00939f9](https://github.com/morluto/rea/commit/00939f9bd2d0596deab4824ec9107eabf6592ab7))
* **firmware:** report malformed linux,phandle and leave references unresolved ([#13734](https://github.com/morluto/rea/issues/13734)) ([b0216a0](https://github.com/morluto/rea/commit/b0216a0a7ae1c56a5a6d01dc08ca820b5ebdceb3))
* **firmware:** report partial devicetree coverage when a property was not decoded ([#14966](https://github.com/morluto/rea/issues/14966)) ([689de9d](https://github.com/morluto/rea/commit/689de9deed6e97acdd84d1f1aa4fbfa51fc794a6))
* **firmware:** summarize RISC-V vectors by decoded jumps ([#15014](https://github.com/morluto/rea/issues/15014)) ([3fad592](https://github.com/morluto/rea/commit/3fad5920b9227a489b3796f373536385d4fd3bf0))
* **fit:** report unknown coverage when an image field was not decoded ([#14986](https://github.com/morluto/rea/issues/14986)) ([40459f1](https://github.com/morluto/rea/commit/40459f16c33b41108f171025710e0775d6596b3a))
* **flutter:** distinguish Dart snapshot exports from local symbols ([#13576](https://github.com/morluto/rea/issues/13576)) ([3c74128](https://github.com/morluto/rea/commit/3c741283530bb400531540f96b85134d6a7bd029))
* **flutter:** preserve build IDs beside invalid note extents ([#13577](https://github.com/morluto/rea/issues/13577)) ([7d6c771](https://github.com/morluto/rea/commit/7d6c77106260b086717ef98e695c31257539b0e4))
* **frida:** explain refused ptrace seize during injection ([317f90e](https://github.com/morluto/rea/commit/317f90e023a96f18695790efbe903fb39a4e6b85)), refs [#9103](https://github.com/morluto/rea/issues/9103)
* **frida:** keep ptrace seize guidance from overclaiming ([2337ebe](https://github.com/morluto/rea/commit/2337ebe130dabff210bb55aa6f34c4585bbde73a)), refs [#9103](https://github.com/morluto/rea/issues/9103)
* **functions:** preserve proven referenced string membership changes ([#13421](https://github.com/morluto/rea/issues/13421)) ([afbbfff](https://github.com/morluto/rea/commit/afbbfff561a9d83689e49f61a5192b98bbfe5c07))
* **gdb:** report console stream records by size in the command summary ([f48edea](https://github.com/morluto/rea/commit/f48edeaaecb0db0d367926407c1355e9664fbe75))
* **ghidra:** admit recordless legacy MIPS32 carves missing section tables ([#4532](https://github.com/morluto/rea/issues/4532)) ([fe4e466](https://github.com/morluto/rea/commit/fe4e466ef97efdb9941414561a8c75beb0f04867))
* **ghidra:** admit recordless MIPS32 executables that declare o32 ([#14423](https://github.com/morluto/rea/issues/14423)) ([580c944](https://github.com/morluto/rea/commit/580c944a24c4d0922051cfa0724ee8d5c60f67e3))
* **ghidra:** cancel an active request without closing the session ([#14857](https://github.com/morluto/rea/issues/14857)) ([1aa301e](https://github.com/morluto/rea/commit/1aa301e149c558ad46cc5f78adcda50d234d0065))
* **ghidra:** expose NativeAOT opt-out recovery ([#12923](https://github.com/morluto/rea/issues/12923)) ([753b7e9](https://github.com/morluto/rea/commit/753b7e908c5ab91508cbda7b954aaa8138822712))
* **ghidra:** forget an elapsed startup only after close settles ([ae2bbe0](https://github.com/morluto/rea/commit/ae2bbe056158eac51aaf0d6ff12d1c2eddc1e5f5))
* **ghidra:** let sessions share a checkpointed target ([#14856](https://github.com/morluto/rea/issues/14856)) ([dc12e57](https://github.com/morluto/rea/commit/dc12e5768b57ae8b78dec5c3eb453929b255cf7f))
* **ghidra:** link the published installation guide from decompiler remediation ([62ec695](https://github.com/morluto/rea/commit/62ec69530319a17552f52dbfb7bdf3c4575ac85b)), refs [#7018](https://github.com/morluto/rea/issues/7018)
* **ghidra:** load ESP-IDF flash code in Ghidra's default address space ([#8464](https://github.com/morluto/rea/issues/8464)) ([5e56bd0](https://github.com/morluto/rea/commit/5e56bd0a2311d92afe7ab8be1cb143f5b467c369))
* **ghidra:** name contract operations and fields in selector and type-edit recovery ([b6163bf](https://github.com/morluto/rea/commit/b6163bfbc0a2074548afafd48c1c2eaed254502c))
* **ghidra:** name invalid installed language definition files ([#13401](https://github.com/morluto/rea/issues/13401)) ([1d85f68](https://github.com/morluto/rea/commit/1d85f680f9aeee634ff3da8cd20c9209c6275b9e))
* **ghidra:** name the code seed recovery for addresses outside the listing ([#10682](https://github.com/morluto/rea/issues/10682)) ([33ecda0](https://github.com/morluto/rea/commit/33ecda025f0f21ebe7abd73e6ebd5c43a21a5822))
* **ghidra:** pass inspected JDK to the Windows verifier ([#10752](https://github.com/morluto/rea/issues/10752)) ([0053ad5](https://github.com/morluto/rea/commit/0053ad589cb282d9a027d0a22211a6bc1a2652cb))
* **ghidra:** point to the LC_MAIN entry when a stripped Mach-O has no main symbol ([#12966](https://github.com/morluto/rea/issues/12966)) ([3db9120](https://github.com/morluto/rea/commit/3db9120c5e8af1e60e6d0e8ea7a0da35c181e085))
* **ghidra:** preserve cancellation and failure order in language discovery ([#13399](https://github.com/morluto/rea/issues/13399)) ([8ee0ffe](https://github.com/morluto/rea/commit/8ee0ffe0862721e928feb6cb18f7684403b58d77))
* **ghidra:** refuse over-deep caller types before Ghidra parses them ([#14930](https://github.com/morluto/rea/issues/14930)) ([c24ec44](https://github.com/morluto/rea/commit/c24ec44c94a845c69c6fa88dea9369b26586e25e))
* **ghidra:** report a bare selector outside every mapping as a missing procedure ([87a45dd](https://github.com/morluto/rea/commit/87a45dda1cfcf54c9e85bcd20307410d094be8d3))
* **ghidra:** report a held checkpoint lease as retryable contention ([#14844](https://github.com/morluto/rea/issues/14844)) ([059df00](https://github.com/morluto/rea/commit/059df00e70ee7067252f0ce10fa104cd45c51011))
* **ghidra:** report a wait-bounded owner probe timeout as busy regardless of clock skew ([#14935](https://github.com/morluto/rea/issues/14935)) ([cd87f99](https://github.com/morluto/rea/commit/cd87f998e44c7b1fde8f7832d4f241945ffedfd2))
* **ghidra:** report incomplete language catalogs at the file size limit ([#13407](https://github.com/morluto/rea/issues/13407)) ([3d3e7db](https://github.com/morluto/rea/commit/3d3e7db5b53329fa0a43c35cb26b9bfade0ee045))
* **ghidra:** return an elapsed startup instead of importing again ([691c277](https://github.com/morluto/rea/commit/691c277d641f401ec473835c893bd9c50be1ba9b))
* **ghidra:** reuse completed decompiles and decompile code outside functions ([#14843](https://github.com/morluto/rea/issues/14843)) ([a3a491c](https://github.com/morluto/rea/commit/a3a491c3893ca68359b0a22329c7992c91044116))
* **ghidra:** say byte-search pages read match metadata live ([#10684](https://github.com/morluto/rea/issues/10684)) ([e7a0232](https://github.com/morluto/rea/commit/e7a023263bdd1221ab1fb1c2cafcf1b848152436))
* **ghidra:** say how to build a missing macOS or Linux arm64 decompiler ([cc8716c](https://github.com/morluto/rea/commit/cc8716ce22e5d9a9a7c889e900c5e5cf196d91ef)), refs [#7018](https://github.com/morluto/rea/issues/7018)
* **ghidra:** scope defect notes and state session limitations once ([#14267](https://github.com/morluto/rea/issues/14267)) ([e309e15](https://github.com/morluto/rea/commit/e309e15bf861e58f6ae97dde078d382092610285))
* **go:** reject contradictory module coverage in retained views ([#14029](https://github.com/morluto/rea/issues/14029)) ([be459ab](https://github.com/morluto/rea/commit/be459abee5f9c4f6a07d24b8ec4e8bdcb165967d))
* **go:** report only admitted string candidate limits ([#13451](https://github.com/morluto/rea/issues/13451)) ([22042af](https://github.com/morluto/rea/commit/22042af848c2cfe4fbb1d6764771da570c421d4d))
* **go:** retain verified reports through descriptor finalization ([#14026](https://github.com/morluto/rea/issues/14026)) ([6d7bf58](https://github.com/morluto/rea/commit/6d7bf586377f9c58419d884d5962bf192031aa02))
* **gpu:** accept non-negative signed MessagePack integer keys in AMDGPU metadata ([#14517](https://github.com/morluto/rea/issues/14517)) ([0cbde34](https://github.com/morluto/rea/commit/0cbde34808caa46cf1854918df5b559d88fa5257))
* **gpu:** decode UTF-8 CUBIN kernel symbol names ([#13101](https://github.com/morluto/rea/issues/13101)) ([23cf85e](https://github.com/morluto/rea/commit/23cf85ef24fbc598125d0d3a2cddb42eeb2337b5))
* **gpu:** dispatch AMDGPU note metadata on the declared ELF ABI ([#14244](https://github.com/morluto/rea/issues/14244)) ([0a145c8](https://github.com/morluto/rea/commit/0a145c84231372980c5543b5550f2368657c576c))
* **gpu:** keep kernel resources in their owning coordinate space ([#13564](https://github.com/morluto/rea/issues/13564)) ([2be4cc4](https://github.com/morluto/rea/commit/2be4cc468e2bcfc62b0818049297fa1ee59c6f5b))
* **gpu:** keep the PTX target unknown when braces are unbalanced ([#12888](https://github.com/morluto/rea/issues/12888)) ([313e892](https://github.com/morluto/rea/commit/313e89206d94040654edbeaf4c44e724bd436a24))
* **gpu:** mark conflicting CUDA shared sections partial and clear register provenance ([#13963](https://github.com/morluto/rea/issues/13963)) ([4c27f48](https://github.com/morluto/rea/commit/4c27f4866715bdf08e2deaf205e4654176a2ccd4))
* **gpu:** name an unreadable shared section instead of a bare null count ([#14133](https://github.com/morluto/rea/issues/14133)) ([4d7594f](https://github.com/morluto/rea/commit/4d7594f6728d73dcf891f322cbf03920d499af7a))
* **guidance:** direct workflow errors to the scoped inventory ([#13321](https://github.com/morluto/rea/issues/13321)) ([11a75a5](https://github.com/morluto/rea/commit/11a75a5c19bee0bd030d4bbbab9bcf789a2d26a6))
* **har:** fall back to postData.params when postData.text is empty or unreadable ([#14256](https://github.com/morluto/rea/issues/14256)) ([83c4c34](https://github.com/morluto/rea/commit/83c4c34de84f90379e6cd95efc69f0bc84a57561))
* **har:** keep Chromium DevTools captures that report an empty server address ([#13027](https://github.com/morluto/rea/issues/13027)) ([af0d69e](https://github.com/morluto/rea/commit/af0d69ee91e2ae8225b94257d8354382bd0b263b))
* **hermes:** resolve nested HERMES_HOME selection from the override root ([#13792](https://github.com/morluto/rea/issues/13792)) ([6542e81](https://github.com/morluto/rea/commit/6542e81a120864e2ed0d62476632c506cee1e43c))
* **hopper:** name xrefs when a selector resolves outside every procedure ([#14188](https://github.com/morluto/rea/issues/14188)) ([b1b0bdf](https://github.com/morluto/rea/commit/b1b0bdf01115df8c66589e059bee45e299e03403))
* **hopper:** refuse downloads redirected to another origin ([#6700](https://github.com/morluto/rea/issues/6700)) ([8575dfe](https://github.com/morluto/rea/commit/8575dfe370c585d198392063dd71c040380537aa))
* **hopper:** report the stalled export function and shell recovery ([#14855](https://github.com/morluto/rea/issues/14855)) ([cc888f5](https://github.com/morluto/rea/commit/cc888f5f7d7a1210be0b2ff36486d84593b3546b))
* **ida:** extend verifier admission check deadline to 90s ([d7ba8ad](https://github.com/morluto/rea/commit/d7ba8adbc3b8dc009549d6405873e68c8934c814))
* **ida:** name contract operations in procedure lookup recovery ([402474b](https://github.com/morluto/rea/commit/402474b08289783fff09e5a290c3844bf4789f26))
* **ida:** report an idb_open rejection with its upstream reason ([0cf7483](https://github.com/morluto/rea/commit/0cf7483322e0499cec72cc3df06d761871a75929)), refs [#13286](https://github.com/morluto/rea/issues/13286)
* **ida:** report the supervisor's open deadline as provider_timeout ([ddf2cd9](https://github.com/morluto/rea/commit/ddf2cd9102ddcc6da901aa37f752223de61b289d)), refs [#13286](https://github.com/morluto/rea/issues/13286)
* **interface-builder:** preserve budget-omitted destination evidence ([#13674](https://github.com/morluto/rea/issues/13674)) ([e1be55d](https://github.com/morluto/rea/commit/e1be55dcaff944a06ca6eccdca9090f74a246cbb))
* **iso9660:** read Joliet trees whose .. records name their own directory ([#14817](https://github.com/morluto/rea/issues/14817)) ([55bb5e7](https://github.com/morluto/rea/commit/55bb5e78a38599c408009e0dbd31c12a035427c8))
* **iso9660:** read the descriptor's root record from its fixed 34-byte field ([#15002](https://github.com/morluto/rea/issues/15002)) ([43e0567](https://github.com/morluto/rea/commit/43e0567ebfeb904a15931526e35a3beb1b3841c4))
* **java:** classify Maven BOM imports by declaration scope ([#13393](https://github.com/morluto/rea/issues/13393)) ([0482135](https://github.com/morluto/rea/commit/048213525a661f213387f9ad8811383f5fb87540))
* **java:** enforce format-specific metadata reports at the Evidence boundary ([#13400](https://github.com/morluto/rea/issues/13400)) ([103e1a7](https://github.com/morluto/rea/commit/103e1a71f24c7566d3d05d00409b652cc2874bd1))
* **java:** preserve Gradle declaration spelling in Evidence ([#13397](https://github.com/morluto/rea/issues/13397)) ([d0f3a48](https://github.com/morluto/rea/commit/d0f3a4858e43ccb80ecbd3d27c0b82405a7c1a31))
* **java:** refuse nested XML in Maven text declarations ([#13398](https://github.com/morluto/rea/issues/13398)) ([232bd11](https://github.com/morluto/rea/commit/232bd1181cf5b730ac83e406581927d76403d02c))
* **javascript:** account for active nullish pattern defaults ([c1943f1](https://github.com/morluto/rea/commit/c1943f196cde8d232029e184648bf0a1356b685a))
* **javascript:** answer an over-budget member-mutation query by escaping whole objects ([#14153](https://github.com/morluto/rea/issues/14153)) ([c4916a6](https://github.com/morluto/rea/commit/c4916a6ff779c1ef39f998bf49b0e11840bd8889))
* **javascript:** drop a stream acquisition whose options Node refuses ([#9262](https://github.com/morluto/rea/issues/9262)) ([afa3482](https://github.com/morluto/rea/commit/afa34825a81496b6de427ca11ffb9b4781902855))
* **javascript:** escape values stored into an object that escapes ([#14273](https://github.com/morluto/rea/issues/14273)) ([26741b0](https://github.com/morluto/rea/commit/26741b03bebb6e7d4624ea2265835bca02e7c780))
* **javascript:** include the underscore in the http token class ([62c4c25](https://github.com/morluto/rea/commit/62c4c25d19b67363784b58961072cd12c509de52))
* **javascript:** keep Electron options visible past conditional literal spreads ([#9510](https://github.com/morluto/rea/issues/9510)) ([abdf383](https://github.com/morluto/rea/commit/abdf383939bd4190c9a06dd6576f3d698718d842))
* **javascript:** name minified receiverless import calls by their final callee ([#9095](https://github.com/morluto/rea/issues/9095)) ([f8a12eb](https://github.com/morluto/rea/commit/f8a12eba17e95d0897c4438f629d7bd30b3380cc))
* **javascript:** omit requests rejected by the default agent protocol ([f54cc2f](https://github.com/morluto/rea/commit/f54cc2f3acf5e73b1007aafe8db69bc4b0ca29c3))
* **javascript:** preserve abrupt destructuring boundaries ([#13433](https://github.com/morluto/rea/issues/13433)) ([365bbd9](https://github.com/morluto/rea/commit/365bbd9008ddde7b4ff6c0ba3b239e24309a7a64))
* **javascript:** preserve CommonJS exports through TypeScript wrappers ([#4784](https://github.com/morluto/rea/issues/4784)) ([a2b1986](https://github.com/morluto/rea/commit/a2b1986b2a1ba7e1b64ab8752c6da4f590ac64c1))
* **javascript:** preserve Electron identity beside unrelated alias exhaustion ([#12988](https://github.com/morluto/rea/issues/12988)) ([c2870f9](https://github.com/morluto/rea/commit/c2870f91320721222a6157b5728eaff92a6c5a2a))
* **javascript:** preserve uncertainty after nullish patterns ([8ae636b](https://github.com/morluto/rea/commit/8ae636b6abaaf3ac76a657be085a1abb1f571e1d))
* **javascript:** preserve Webpack slots outside finite writes ([#13006](https://github.com/morluto/rea/issues/13006)) ([91a68a8](https://github.com/morluto/rea/commit/91a68a8b7cd374b0b5a09cf5b57b05b8bb304162))
* **javascript:** qualify response consumers with uncertain receivers ([a8d714f](https://github.com/morluto/rea/commit/a8d714f0e31f976df4efb2ed47bf9dfa90a86d0c))
* **javascript:** read the target of method-first request(method, url) calls ([73bc6f4](https://github.com/morluto/rea/commit/73bc6f48c72d02069ef7a3e4f73869cbeeff11bc))
* **javascript:** record the collapsed-query resource limit on observations ([#14220](https://github.com/morluto/rea/issues/14220)) ([df6454c](https://github.com/morluto/rea/commit/df6454c3fd9092954078501f133d784a57ea49b3))
* **javascript:** reject an http method token Node refuses at the call site ([adf186d](https://github.com/morluto/rea/commit/adf186d5ffb831fb674aa02e5323e579d8710e9c))
* **javascript:** report no loader call in a program that names no CommonJS loader ([#14191](https://github.com/morluto/rea/issues/14191)) ([998512e](https://github.com/morluto/rea/commit/998512eeb86a682f104e6ac80217c61be292ee9f)), refs [#14190](https://github.com/morluto/rea/issues/14190)
* **javascript:** resolve literal spreads and const aliases in kill signals ([4bcd0d8](https://github.com/morluto/rea/commit/4bcd0d864a82c89a15c1152516bf0c46fd224731))
* **javascript:** route directories by JavaScript input presence and name directory-capable operations ([#14186](https://github.com/morluto/rea/issues/14186)) ([6dadd30](https://github.com/morluto/rea/commit/6dadd30fb685e39d9f2f8eaca6d8b3900b7af6a7))
* **javascript:** share widened reference-store propagation ([#12990](https://github.com/morluto/rea/issues/12990)) ([fba5e44](https://github.com/morluto/rea/commit/fba5e44bf5f393dcd6bd3269d88d7101f1586ff0))
* **javascript:** track shared ESM HTTP agent mutations ([d500638](https://github.com/morluto/rea/commit/d500638d5d4b666cf0b255085ce4d75a29cbc35e))
* **javascript:** unwrap pure SequenceExpression call targets ([#14396](https://github.com/morluto/rea/issues/14396)) ([c9831a9](https://github.com/morluto/rea/commit/c9831a9d4f256964de2bf7d25700647210d41388))
* **javascript:** validate literal options.port on net and tls connects ([#14760](https://github.com/morluto/rea/issues/14760)) ([352f608](https://github.com/morluto/rea/commit/352f6085e50325a31185affad68c4f8ec53d5a6f))
* **javascript:** verify Expo context getter ownership ([#13803](https://github.com/morluto/rea/issues/13803)) ([8c16d7d](https://github.com/morluto/rea/commit/8c16d7d18f71c0057240db4122c5df9a8b907a95))
* **labview:** read section names past the declared block-info extent ([#14970](https://github.com/morluto/rea/issues/14970)) ([8e057e0](https://github.com/morluto/rea/commit/8e057e08d6e1a9590e745af39ad0d63aa46ba431))
* **limits:** apply producer.output_bytes within each producer's maximum ([#14668](https://github.com/morluto/rea/issues/14668)) ([05e5c91](https://github.com/morluto/rea/commit/05e5c915263b766dfcdc03319723f2ca40d9b420))
* **limits:** budget Rust dependency parser ceilings per call ([#14666](https://github.com/morluto/rea/issues/14666)) ([1557159](https://github.com/morluto/rea/commit/155715942e6d8f549bb240529b887e0f86457d2b))
* **limits:** let apktool and assetutil take producer_limits.output_bytes and type Android and process capture refusals ([#14624](https://github.com/morluto/rea/issues/14624)) ([0eb19a3](https://github.com/morluto/rea/commit/0eb19a395ec42ed40b575663dc8a8b2defce0643))
* **limits:** let inspect_pcap_capture take producer_limits for its snapshot and TShark output ([#14280](https://github.com/morluto/rea/issues/14280)) ([fd09e2b](https://github.com/morluto/rea/commit/fd09e2b9a1ca8e6730d3d030ae23d012c5dea6f9))
* **limits:** let inspect_sqlite_database take producer_limits.input_bytes and type SQLite, Kuna and web-bundle refusals ([#14627](https://github.com/morluto/rea/issues/14627)) ([a5c71e8](https://github.com/morluto/rea/commit/a5c71e8c88e75b1c8906a47996dbe4b360bb65a0))
* **limits:** make the IL2CPP pointer index adjustable and require owned refusal limits ([#14243](https://github.com/morluto/rea/issues/14243)) ([6ab595c](https://github.com/morluto/rea/commit/6ab595cfd6fc67f6bfe7313e39f736ed67f036a3))
* **limits:** omit required_value when PE/native read budgets know only a lower bound ([#14645](https://github.com/morluto/rea/issues/14645)) ([49187f1](https://github.com/morluto/rea/commit/49187f1ab39288182447537558c41a90f1976c3b))
* **limits:** report details.limit for KernelModuleProvider refusals ([#14306](https://github.com/morluto/rea/issues/14306)) ([2c07552](https://github.com/morluto/rea/commit/2c07552b643bddc7c58c3ff0b4a58893e6c05548))
* **limits:** report packet and signal producer budgets as details.limit and page discovery at its record budget ([#14621](https://github.com/morluto/rea/issues/14621)) ([33e4e07](https://github.com/morluto/rea/commit/33e4e07dd05f6968d106c6671ca9b38033b10f11))
* **macho:** correct encryption range VM mapping ([#13918](https://github.com/morluto/rea/issues/13918)) ([0fb1d11](https://github.com/morluto/rea/commit/0fb1d112f699b5619607f564f95fe52f14b7b061))
* **macho:** document what a null build platform means ([#14128](https://github.com/morluto/rea/issues/14128)) ([7fe260d](https://github.com/morluto/rea/commit/7fe260de1d145de5d9984dd4cc60485cbda723a9))
* **macho:** keep header reads inside declared slices ([#13913](https://github.com/morluto/rea/issues/13913)) ([1172d7e](https://github.com/morluto/rea/commit/1172d7ed7d3fc76e664d6ad79abc8e7fa44b2c97))
* **macho:** preserve legacy bind stream bounds and target scope ([#13874](https://github.com/morluto/rea/issues/13874)) ([a8ccf8b](https://github.com/morluto/rea/commit/a8ccf8b5b883f5df3394c7753d7edc0caaffa524))
* **macho:** preserve retained magic from valid FAT ranges ([#13910](https://github.com/morluto/rea/issues/13910)) ([9dba673](https://github.com/morluto/rea/commit/9dba67368d01092f723bc074416eefcbe7546293))
* **macho:** report a FAT header or table cut off by the file's end as truncated ([#14233](https://github.com/morluto/rea/issues/14233)) ([187793b](https://github.com/morluto/rea/commit/187793ba6158b23efe81160ac8ae6334a700bf35))
* **macho:** report Mach-O read failures as target failures and delete MachoReadIssue ([#14416](https://github.com/morluto/rea/issues/14416)) ([5b79ae5](https://github.com/morluto/rea/commit/5b79ae5d62be355c5f955fe43c42a8e15b891a64))
* **macho:** select arm64e.x1 slices of universal Mach-O files by exact subtype ([#14881](https://github.com/morluto/rea/issues/14881)) ([92b082b](https://github.com/morluto/rea/commit/92b082bcaf3e224fd0d03d7279728516fcbd45e7))
* **macho:** validate encryption mapping segment and section bounds against the slice ([#14287](https://github.com/morluto/rea/issues/14287)) ([0b7388e](https://github.com/morluto/rea/commit/0b7388ebe1f54375896eb5897c643406bd1653b2))
* **managed:** isolate invalid string loads from member coverage ([#13588](https://github.com/morluto/rea/issues/13588)) ([4d507e8](https://github.com/morluto/rea/commit/4d507e861282e8ffa5f0e2e09fc523e40a5dd6e7))
* **maven:** preserve property value spelling ([#13442](https://github.com/morluto/rea/issues/13442)) ([b43084c](https://github.com/morluto/rea/commit/b43084c7fd892524bce20982719ef08df3310687))
* **maven:** read Maven 4.1.0 model POMs ([#14089](https://github.com/morluto/rea/issues/14089)) ([0c59c2e](https://github.com/morluto/rea/commit/0c59c2ed4e46ff52c69cb9f216c069e7b703f658))
* **mcp:** accept discover_tools in exact-name discovery batches ([#13288](https://github.com/morluto/rea/issues/13288)) ([fd40fd9](https://github.com/morluto/rea/commit/fd40fd9ab2a0238529e2c2bc55264af778b439a3))
* **mcp:** keep doctor launches target-free on Windows ([#13250](https://github.com/morluto/rea/issues/13250)) ([0209d3e](https://github.com/morluto/rea/commit/0209d3e1b580d83497a7b04bc274001670311bd6))
* **mcp:** name the discover_tools call for an unloaded hot-cold tool ([#14845](https://github.com/morluto/rea/issues/14845)) ([427c660](https://github.com/morluto/rea/commit/427c66018e54012ab4d9705bdfaa3317ade48b74))
* **mcp:** name the HTTP option that requires --http ([2fbcec8](https://github.com/morluto/rea/commit/2fbcec84eb5054c7f014729021172173df1742c8))
* **mcp:** paginate tools/list under the FastMCP SSE limit ([#9142](https://github.com/morluto/rea/issues/9142)) ([a00511e](https://github.com/morluto/rea/commit/a00511e88e1008d233c89b8911dddb6d493a1cbd))
* **mcp:** rank multi-word discover_tools queries by matched terms ([#14584](https://github.com/morluto/rea/issues/14584)) ([c58de7f](https://github.com/morluto/rea/commit/c58de7f77efc738b414376fa7b7a1e98b1499c99))
* **mcp:** refuse stale sessions and serialize initialize handovers ([#13195](https://github.com/morluto/rea/issues/13195)) ([7b4d84a](https://github.com/morluto/rea/commit/7b4d84a48e5c1ecabdced7fbc78185be434225ac))
* **mcp:** replay direct Ghidra reads that omit document ([#14842](https://github.com/morluto/rea/issues/14842)) ([366e1d9](https://github.com/morluto/rea/commit/366e1d98c1b3ba31e7f9e33cd8779713f86b3099))
* **mcp:** retain doctor initialization when catalog requests fail ([#13255](https://github.com/morluto/rea/issues/13255)) ([87889b8](https://github.com/morluto/rea/commit/87889b8729da8a02a4159bc7274c92be52464031))
* **mcp:** settle independent launch preparation owners ([#13259](https://github.com/morluto/rea/issues/13259)) ([178467f](https://github.com/morluto/rea/commit/178467f6a7c77f6c61f81008ccffeaa7d0061d38))
* **mcp:** share catalog tool search to suggest advertised tools on unknown tool calls ([#14305](https://github.com/morluto/rea/issues/14305)) ([16c972b](https://github.com/morluto/rea/commit/16c972bb91637dfabda11c77ef9246e6dbed5694))
* **model:** name and size Q4_0_4_4 GGUF tensors ([#14532](https://github.com/morluto/rea/issues/14532)) ([ed9e664](https://github.com/morluto/rea/commit/ed9e664c2a046737ffae7e17aa23e41b867bf8e7))
* **model:** recognize F8_E4M3 GGUF tensors from ggml v0.29.0 ([afc040c](https://github.com/morluto/rea/commit/afc040ccebb9af1f8b9eb6c5dbbdbc322a58ded2))
* **mutation:** unblock the daily mutation sweep ([#14748](https://github.com/morluto/rea/issues/14748)) ([3273cbd](https://github.com/morluto/rea/commit/3273cbd1e27a73084a368b332c9101d02b0288e8))
* name the violated rule in nested input refusals ([#14766](https://github.com/morluto/rea/issues/14766)) ([b3e769d](https://github.com/morluto/rea/commit/b3e769d9716783580f02095d2cbe7cf3c61039b9))
* **native-exports:** preserve uncertainty in incomplete ELF version lookups ([#13666](https://github.com/morluto/rea/issues/13666)) ([02d5e6e](https://github.com/morluto/rea/commit/02d5e6e3f83727f4234303bf6fadbc3509d1aedd))
* **native-exports:** verify the declared PE directory size ([#13661](https://github.com/morluto/rea/issues/13661)) ([ef3eb1e](https://github.com/morluto/rea/commit/ef3eb1e46e37836fe91984ec15a8a1d0a352fe5c))
* **native:** admit every recognized dyld_info refusal when it exits 0 ([2d8309d](https://github.com/morluto/rea/commit/2d8309dfe73d4283853f381e6245da6fc16b65f1))
* **native:** admit the missing-UUID dyld_info refusal when it exits 0 ([0e8f9d0](https://github.com/morluto/rea/commit/0e8f9d05864028da3ef5d0099463d63daca96f01))
* **native:** bound Android packed relocations with max_structure_bytes ([#14788](https://github.com/morluto/rea/issues/14788)) ([47875ba](https://github.com/morluto/rea/commit/47875ba073c5c6049e5cce67ff72aeb5a8f876b5))
* **native:** decode Objective-C categories that Swift lists in __objc_catlist2 ([#14025](https://github.com/morluto/rea/issues/14025)) ([94c1c6a](https://github.com/morluto/rea/commit/94c1c6aec0b65fc34c6e0516a7330ac24f38a11f))
* **native:** do not count an object file's LINKEDIT tables as misplaced ([#14933](https://github.com/morluto/rea/issues/14933)) ([1adba0f](https://github.com/morluto/rea/commit/1adba0f4172fb037caeb0285866c9a8f1bed5b7c))
* **native:** label XML plists that file calls data as xml ([#12910](https://github.com/morluto/rea/issues/12910)) ([f03cce9](https://github.com/morluto/rea/commit/f03cce9c01d184ffade34dcb36fd05c0c0350a5e))
* **native:** preserve Apple tool diagnostics across macOS versions ([a9d1031](https://github.com/morluto/rea/commit/a9d103167484234027415cf7816f4bd8335bf8a7))
* **native:** preserve bundle provenance in partial reports ([9ffaca5](https://github.com/morluto/rea/commit/9ffaca54477d33c0f41f7042688b8e11f08d25b0))
* **native:** refresh bundle provenance on reopen ([e35780d](https://github.com/morluto/rea/commit/e35780d042a9428c0a619ec42cf11794f5d7525c))
* **native:** report details.limit for native reader per-call budgets ([#14622](https://github.com/morluto/rea/issues/14622)) ([50d13f9](https://github.com/morluto/rea/commit/50d13f9f08dd4f026f190b2ee27c885f95b6e0b5))
* **native:** report details.limit for remaining native reader budgets and make BEAM table rows adjustable ([#14631](https://github.com/morluto/rea/issues/14631)) ([1badb6a](https://github.com/morluto/rea/commit/1badb6a8ae9d5a9696bc13091fa32485a0392183))
* **native:** report non-native bytes as unrecognized, not malformed ([#14936](https://github.com/morluto/rea/issues/14936)) ([13f618e](https://github.com/morluto/rea/commit/13f618e8e3e48dc67a21ef86598d59fa87774e78))
* **native:** require dyld's __restrict section before reporting a restricted Mach-O ([#13024](https://github.com/morluto/rea/issues/13024)) ([7a11884](https://github.com/morluto/rea/commit/7a11884c0897062867e62c0c6d1079342ef8d861))
* **native:** resolve name and import selectors through one owner ([#14250](https://github.com/morluto/rea/issues/14250)) ([cab39c6](https://github.com/morluto/rea/commit/cab39c640a50726d7766f202046a403ba8e72fff))
* **native:** resolve Objective-C protocol _classProperties via pointer fixups ([#14283](https://github.com/morluto/rea/issues/14283)) ([5a283a5](https://github.com/morluto/rea/commit/5a283a5f874fdb472afdd4355733aced05c38d02))
* **native:** validate SHT_GNU_HASH bounds and fall back to DT_GNU_HASH ([#13713](https://github.com/morluto/rea/issues/13713)) ([e6b30f9](https://github.com/morluto/rea/commit/e6b30f945ec214e05ca13c36874e155737a6d4cb))
* **nuget:** preserve explicitly spaced publisher metadata ([#14906](https://github.com/morluto/rea/issues/14906)) ([bbed314](https://github.com/morluto/rea/commit/bbed314998666ed84128aa25f532ce27a6380e64))
* **objc:** preserve class import reader failures ([#13892](https://github.com/morluto/rea/issues/13892)) ([99c2104](https://github.com/morluto/rea/commit/99c2104da9b3e4d179436cbed477c98668a935a3))
* **objdump:** summarize command output by its size ([285af34](https://github.com/morluto/rea/commit/285af34aead58d24cd503bb49047d238b4f25053))
* **package:** declare the projected manifest scripts without prepare ([68e1ec3](https://github.com/morluto/rea/commit/68e1ec3e3633af005bbac8ab3a077a3741107e41))
* **package:** leave the source-checkout prepare script out of the published manifest ([30c8721](https://github.com/morluto/rea/commit/30c87211f384c389eedd0e85065304dd17c28572))
* **pe-unwind:** mark exception directory coverage partial when trailing bytes exist ([#14515](https://github.com/morluto/rea/issues/14515)) ([b1907ae](https://github.com/morluto/rea/commit/b1907ae5915245c283487a8c2be03bc543881952))
* **pe:** accept Qualcomm MBN as a PE overlay leading format ([cd614ee](https://github.com/morluto/rea/commit/cd614ee6c6fc02924e14a4df214105a27ae0f459))
* **pe:** bound static readers by the bytes they read, not file size ([#14262](https://github.com/morluto/rea/issues/14262)) ([789ca04](https://github.com/morluto/rea/commit/789ca0412579d2a1ae84ad1683dfe8808937908a))
* **pe:** exclude section padding from RVA metadata reads ([#12755](https://github.com/morluto/rea/issues/12755)) ([c5b5d9f](https://github.com/morluto/rea/commit/c5b5d9f7ea3f0f32a3ebf0834314ae3888ab4132))
* **pe:** keep pefile's unrounded raw offset for a sub-page section ([985fa2f](https://github.com/morluto/rea/commit/985fa2fac939d0da5de31d59a4df055d90df1cd8))
* **pe:** preserve TLS section ownership across named ranges ([#13743](https://github.com/morluto/rea/issues/13743)) ([9808545](https://github.com/morluto/rea/commit/9808545d6f57e3a3d4d0f87773f8111d4531ac6f))
* **pe:** share one loader-equivalent PE header owner across static readers ([#14253](https://github.com/morluto/rea/issues/14253)) ([f585acc](https://github.com/morluto/rea/commit/f585acc748058ca24da5f03395a37b3cc36e941f))
* **pkg:** report unexamined data after cpio trailers ([#14909](https://github.com/morluto/rea/issues/14909)) ([e1fb417](https://github.com/morluto/rea/commit/e1fb417c9773e1b15de3bb01baf1bc6f2ad2657f))
* **process:** find dotted Windows command names on PATH ([#13833](https://github.com/morluto/rea/issues/13833)) ([dc9db1f](https://github.com/morluto/rea/commit/dc9db1f35a00c5b384a12ce463dce579f826c3f1))
* **process:** name the fixed finalization delivery grace ([ab47c97](https://github.com/morluto/rea/commit/ab47c970a7bdbcda8df9e54242c05fce8b068d02))
* **process:** record PTY session-leader SIGHUP limitation in Evidence ([95dfbae](https://github.com/morluto/rea/commit/95dfbae68e31a01901deab358db572c472866bcf))
* **process:** report exits during Linux credential reads as absence ([c8d8127](https://github.com/morluto/rea/commit/c8d812785e849ccde41d1fe063a13558aac5c7bc))
* **process:** retain proven file differences with partial coverage ([#13364](https://github.com/morluto/rea/issues/13364)) ([ec29a6d](https://github.com/morluto/rea/commit/ec29a6deae22ba82c5a88db092fbe65bd03b8bd4))
* **process:** retain stdout collection failures through cleanup ([#13725](https://github.com/morluto/rea/issues/13725)) ([835ed06](https://github.com/morluto/rea/commit/835ed060dd9783d42eb815f33a83f6b3654b60ea))
* **process:** retain synchronous command launch failures ([#13350](https://github.com/morluto/rea/issues/13350)) ([3a36311](https://github.com/morluto/rea/commit/3a3631100480109a7d2ef8b9ac8ff1f58df5904e))
* **process:** settle worker, scope, and capture retries against close ([#14779](https://github.com/morluto/rea/issues/14779)) ([548fc2c](https://github.com/morluto/rea/commit/548fc2c811ee9f91310f2903ecba1eaf82b81b5f))
* **process:** verify nested worker exit after parent cleanup ([#13242](https://github.com/morluto/rea/issues/13242)) ([75a75a1](https://github.com/morluto/rea/commit/75a75a1bd14eeec233650623e8b839bdf26b793d))
* **providers:** bind client cleanup state to the exact client ([#14777](https://github.com/morluto/rea/issues/14777)) ([d77d6b1](https://github.com/morluto/rea/commit/d77d6b158b266eb671b0a5ad44439951efd3fead))
* **providers:** resolve a PATH-only JDK for Windows Ghidra ([#14654](https://github.com/morluto/rea/issues/14654)) ([d27e728](https://github.com/morluto/rea/commit/d27e7284c715b6dfaa65fbefda4297bab0f26154))
* **providers:** settle debugger and engine close races ([#14783](https://github.com/morluto/rea/issues/14783)) ([55c7eaa](https://github.com/morluto/rea/commit/55c7eaa0631b072330f522ab64fa7f7abec49101))
* **pwntools:** release each PLT emulator so CET binaries keep their PLT map ([#13213](https://github.com/morluto/rea/issues/13213)) ([6357f77](https://github.com/morluto/rea/commit/6357f775a01f623b96603cf6237951a5c57a0a93))
* **pwntools:** report a per-call input ceiling as its producer_limits parameter ([#14208](https://github.com/morluto/rea/issues/14208)) ([fc795dd](https://github.com/morluto/rea/commit/fc795dd260cb28799f4a247ba61a31e9d7aab4cb))
* **pyinstaller:** distinguish declared-size overruns from limits ([#13648](https://github.com/morluto/rea/issues/13648)) ([ae3a225](https://github.com/morluto/rea/commit/ae3a225f79c1dfd672ef728c104d2d26cd7cbddc))
* **python:** validate marshal coverage and consolidate pyc tests ([#14036](https://github.com/morluto/rea/issues/14036)) ([4ff98b8](https://github.com/morluto/rea/commit/4ff98b84fb5a3b231910ac816575bcf798017126))
* **reference:** preserve file cleanup when directory enumeration fails ([#14081](https://github.com/morluto/rea/issues/14081)) ([26ce3d1](https://github.com/morluto/rea/commit/26ce3d1325e8905be5754fd3c6a65685ce118186))
* **reference:** preserve host spelling for Git metadata paths ([ae8cd50](https://github.com/morluto/rea/commit/ae8cd50ff755e810643ee7f6918121796becbc31))
* **reference:** render invalid Git config path with native separators ([0d71123](https://github.com/morluto/rea/commit/0d7112321d52013fb2be5a593b5bfbe7006a8888))
* **reference:** retain physical Git read failure after cleanup refusal ([#12848](https://github.com/morluto/rea/issues/12848)) ([f4937a0](https://github.com/morluto/rea/commit/f4937a04be3148a7f9a191f1114a8210b7264108))
* **release-exposure:** omit checks that cannot apply to the detected formats ([#14240](https://github.com/morluto/rea/issues/14240)) ([5f63d24](https://github.com/morluto/rea/commit/5f63d244e95caafc6ac0a7d4a89534ca7d29c355))
* **release-exposure:** settle cancellation and package cleanup together ([#13383](https://github.com/morluto/rea/issues/13383)) ([3daf6aa](https://github.com/morluto/rea/commit/3daf6aacdd327b3cf5a23c9b92c2567a3dfe001f))
* **release:** bind checkpoint references to frozen history ([#13392](https://github.com/morluto/rea/issues/13392)) ([16732c6](https://github.com/morluto/rea/commit/16732c6b721d5570df20d7399ce535630ce69c4a))
* **resources:** close unadmitted output handles and preserve caller directories ([#13201](https://github.com/morluto/rea/issues/13201)) ([36c6c61](https://github.com/morluto/rea/commit/36c6c61003f68e7c1309ae0cfc4683dc2ccf82a6))
* **resources:** refresh open handle identity after chmod on virtualized mounts ([#14579](https://github.com/morluto/rea/issues/14579)) ([8e9d712](https://github.com/morluto/rea/commit/8e9d712df51289ff31b5fb9f1b11ee1082b3e58a))
* **rizin:** report the required inferior terminal field ([#13019](https://github.com/morluto/rea/issues/13019)) ([d84652e](https://github.com/morluto/rea/commit/d84652e55b43ad7c494efe67d8324b35d4a05695))
* **rizin:** terminate the owned debugger when cleanup cannot resynchronize ([#10462](https://github.com/morluto/rea/issues/10462)) ([f6a019a](https://github.com/morluto/rea/commit/f6a019a34660a989e7870d92490d7db03d3c258e))
* **rust:** admit valid reports at the configured byte limit ([#13570](https://github.com/morluto/rea/issues/13570)) ([0b1dcb4](https://github.com/morluto/rea/commit/0b1dcb413d8c1a7f64f3bebbf664c4f2f419718f))
* **rust:** retain verified reports through descriptor finalization ([#14034](https://github.com/morluto/rea/issues/14034)) ([dba1c01](https://github.com/morluto/rea/commit/dba1c014ef22988a0a2aae97c130cf09c3dcc2b6))
* **server:** reject duplicate in-flight MCP request IDs ([#14776](https://github.com/morluto/rea/issues/14776)) ([2edef1e](https://github.com/morluto/rea/commit/2edef1e2ccd0a150a6b8c75b2b8109a150d95274))
* **session:** settle snapshot, shutdown, and cleanup-retry races ([#14757](https://github.com/morluto/rea/issues/14757)) ([aad2967](https://github.com/morluto/rea/commit/aad296795ce37e8e56337af7ec49317d4791bb04))
* **setup:** accept hyphenated client names and suggest the closest one ([ed5c3dd](https://github.com/morluto/rea/commit/ed5c3dd10d937eb5e6bb8c41afa44eb6b0af2052))
* **setup:** attribute malformed environment keys to their source ([#13522](https://github.com/morluto/rea/issues/13522)) ([4657cdd](https://github.com/morluto/rea/commit/4657cdd2196eaec8bc2915fd347798d094e6cf6d))
* **setup:** keep incomplete Windows roots unresolved ([#13298](https://github.com/morluto/rea/issues/13298)) ([c34bdab](https://github.com/morluto/rea/commit/c34bdabeae5ed0e38edc7a854abb624f73595368))
* **setup:** keep MCP launchers usable after session cleanup ([#13185](https://github.com/morluto/rea/issues/13185)) ([1587b46](https://github.com/morluto/rea/commit/1587b46a9faa54b1fac925e0d4c827383e80b1ff))
* **setup:** list supported clients instead of a suggestion for an empty client name ([244cb64](https://github.com/morluto/rea/commit/244cb646771dfe594b10e6031cc176df4f1ef560))
* **setup:** normalize win32 paths and trailing backslashes in fxLocation ([#14725](https://github.com/morluto/rea/issues/14725)) ([65311cf](https://github.com/morluto/rea/commit/65311cff1e8f02b76f2eca6cdf52a07fc59d82b9))
* **setup:** preserve caller comments on detached DSH aliases ([#13032](https://github.com/morluto/rea/issues/13032)) ([270c3a6](https://github.com/morluto/rea/commit/270c3a6b285b30c71bcd2f57fad451417769840f))
* **setup:** preserve Goose configuration root selection ([#13297](https://github.com/morluto/rea/issues/13297)) ([e726f89](https://github.com/morluto/rea/commit/e726f89bcb5d07af5699301856454aff9416d482))
* **setup:** preserve unresolved registration settings ([#13573](https://github.com/morluto/rea/issues/13573)) ([df87857](https://github.com/morluto/rea/commit/df8785796fc868c452652f9ed912fc9fa84cffa6))
* **setup:** recognize DSH registrations nested in Cordis groups ([#13037](https://github.com/morluto/rea/issues/13037)) ([9fd8c8d](https://github.com/morluto/rea/commit/9fd8c8d90331a16164a9849d56bf84ed8682b139))
* **setup:** refuse Hermes profiles with an unreadable deletion marker ([#13296](https://github.com/morluto/rea/issues/13296)) ([625bd4b](https://github.com/morluto/rea/commit/625bd4b70aaf920623557e2639e8c2809604998a))
* **setup:** register aube's bin shim instead of its versioned store path ([#5311](https://github.com/morluto/rea/issues/5311)) ([abba1f4](https://github.com/morluto/rea/commit/abba1f43bb08f71af584a1b4d26895f1e1ece90b))
* **setup:** reject impossible Hopper archive lengths before download ([#13737](https://github.com/morluto/rea/issues/13737)) ([d7ccd30](https://github.com/morluto/rea/commit/d7ccd30985737470183a8876d9a9f8b87f953e5e))
* **setup:** remove a deleted JSON member's line break and indentation ([ff930a9](https://github.com/morluto/rea/commit/ff930a92f8408e0b249eb2df5af4f584f4287322))
* **setup:** run the macOS Hopper installer's tools from /usr/bin ([b1e8aa8](https://github.com/morluto/rea/commit/b1e8aa8b1971b52729198001ea521db7d7694c55))
* **setup:** take an emptied JSONC object's trailing comma gap ([d41d103](https://github.com/morluto/rea/commit/d41d1032d959733c731b61020f16a3f9f2f6dbd0))
* **setup:** unify OpenCode layer resolution and alias ownership ([#13226](https://github.com/morluto/rea/issues/13226)) ([d6c4776](https://github.com/morluto/rea/commit/d6c4776e651474728b17f984346bdf4481d1b55e))
* **setup:** use Windows launch settings for registration deadlines ([#13512](https://github.com/morluto/rea/issues/13512)) ([411f8a4](https://github.com/morluto/rea/commit/411f8a434275228a5ba735211773a7587f3dbcd1))
* **setup:** verify restored files before reporting rollback ([#13491](https://github.com/morluto/rea/issues/13491)) ([a329ce6](https://github.com/morluto/rea/commit/a329ce621af3b4d25a8205c0d014aa17b706f746))
* **setup:** verify the effective OpenCode project launcher ([#13538](https://github.com/morluto/rea/issues/13538)) ([d185754](https://github.com/morluto/rea/commit/d1857543f3caecbc3db6734b7c54adb814898aa4))
* **signals:** report an unsupported host as a capability limit ([#14127](https://github.com/morluto/rea/issues/14127)) ([a35bfb9](https://github.com/morluto/rea/commit/a35bfb909813199dd86ecb9cc5c27d499254ff39))
* **snapshot:** replay every one-shot Ghidra read and say when a live result cannot replay ([#14249](https://github.com/morluto/rea/issues/14249)) ([95190b1](https://github.com/morluto/rea/commit/95190b1ebcfe1007e81f431ede5f74ac97c16c6c))
* **source-maps:** cancel requests waiting for decoder admission ([#13844](https://github.com/morluto/rea/issues/13844)) ([72eede7](https://github.com/morluto/rea/commit/72eede75d1211e5ffa78de861ce9c5dae29ec387))
* **source-maps:** report details.limit for source_map_limits refusals ([#14797](https://github.com/morluto/rea/issues/14797)) ([3eb030c](https://github.com/morluto/rea/commit/3eb030ccb44ef7a76a89ea9a910787455634c729))
* **sqlite:** accept the documented sqlite_master spelling of the schema catalog ([#10277](https://github.com/morluto/rea/issues/10277)) ([3ab1db2](https://github.com/morluto/rea/commit/3ab1db27e3b52f225d037ad667373bf945d41bc5))
* **sqlite:** state the runtime requirement in supported-runtime terms ([#14206](https://github.com/morluto/rea/issues/14206)) ([7b056d2](https://github.com/morluto/rea/commit/7b056d2ff86b742dd68ffab2bdad865cc359d943))
* **state-view:** preserve partial list status when total count is invalid ([1d78e6a](https://github.com/morluto/rea/commit/1d78e6abe61ab9ed49669ee0a2ecf7c691acf81d))
* **state-view:** reject unsafe integers in recorded item counts ([00b4082](https://github.com/morluto/rea/commit/00b4082d4c3040116a625cd492c8cc5b7a5bf96e))
* **tar:** compare stored symlink targets ([#14964](https://github.com/morluto/rea/issues/14964)) ([a04fcd8](https://github.com/morluto/rea/commit/a04fcd85ab2fd7ef3fa26e4f6ffc798f9973dd88))
* **target:** preserve IDA signatures across short reads ([#13613](https://github.com/morluto/rea/issues/13613)) ([bb51d8e](https://github.com/morluto/rea/commit/bb51d8e7ea82324fa216c99b840aae0119b1d0de))
* **tar:** read pax values that hdrcharset=BINARY leaves as raw bytes ([#14632](https://github.com/morluto/rea/issues/14632)) ([b4fd7f7](https://github.com/morluto/rea/commit/b4fd7f7b8c49b80382d7391081e3b04d5bc503a7))
* **tar:** recognize gzip archives with long extra fields ([#14861](https://github.com/morluto/rea/issues/14861)) ([f1ca91e](https://github.com/morluto/rea/commit/f1ca91efd31003a194c4e2886759f96b3237a507))
* **tar:** require both end-of-archive blocks for complete coverage ([#14884](https://github.com/morluto/rea/issues/14884)) ([fb27ba2](https://github.com/morluto/rea/commit/fb27ba223a5120d03d0fc9d91f0ccd1b5e589bd9))
* **test:** reap synthetic test-stub processes on cleanup failure and fail fast on unavailable exit polling ([#13368](https://github.com/morluto/rea/issues/13368)) ([bd9a7fa](https://github.com/morluto/rea/commit/bd9a7fad7efba6a2aad1ace7a9e4388f6cf11101))
* **tests:** assert the Mach-O file-type refusal's structured facts ([f1a775b](https://github.com/morluto/rea/commit/f1a775bbaf4588d81f73cb62640baa513597580c))
* **tests:** bound oxlint test threads, throttle export spin loop, align process-boundary workers, and use level-1 zlib in large synthetic fixtures ([#13471](https://github.com/morluto/rea/issues/13471)) ([9e9cfba](https://github.com/morluto/rea/commit/9e9cfba67dc4a0a050552aedd364d8436c7b4186))
* **tests:** damage Deno PE resource framing the loader-equivalent reader reads ([271bad7](https://github.com/morluto/rea/commit/271bad782b312f037660e0600400b19e7cb47252))
* **tests:** disable Vitest fsModuleCache in nested test-runner fixtures ([#14371](https://github.com/morluto/rea/issues/14371)) ([7503364](https://github.com/morluto/rea/commit/7503364df8c4b7b90ae6b8e161becc030e6cb91e))
* **tests:** expect [#14225](https://github.com/morluto/rea/issues/14225)'s reader reasons in the boundary tests ([#14238](https://github.com/morluto/rea/issues/14238)) ([83877c8](https://github.com/morluto/rea/commit/83877c88b97cbd2d38f204f4589902715acd0fdd))
* **tests:** expect the path reason for a FIFO root and a symlinked ZIP ([#14242](https://github.com/morluto/rea/issues/14242)) ([0af067d](https://github.com/morluto/rea/commit/0af067d766c43a44e4d6b696b6d8d4470f18556d))
* **tests:** give CI workflow fixtures a hermetic GitHub context ([26cb5b5](https://github.com/morluto/rea/commit/26cb5b53ceeb1b3288c430ba1b222c2537457740))
* **tests:** narrow markdown-it attributes to strings in doc link checks ([#14217](https://github.com/morluto/rea/issues/14217)) ([e39b56f](https://github.com/morluto/rea/commit/e39b56fc5de5a8791bdf8fa85b8366de213804a9))
* **uefi:** attribute a refused output directory to output_directory ([c01c168](https://github.com/morluto/rea/commit/c01c16833635c30375f61fe0fba1f28ddffb685f))
* **uefi:** decode LZMA sections through one shared LZMA1 owner ([#14918](https://github.com/morluto/rea/issues/14918)) ([943a1f3](https://github.com/morluto/rea/commit/943a1f329ece8a1ff4f398a9b33bc0a1fe7a7a28))
* **uefi:** preserve verified source identity through descriptor finalization ([#14073](https://github.com/morluto/rea/issues/14073)) ([ce277e3](https://github.com/morluto/rea/commit/ce277e3974f565f8edb46c88465b293c170fd582))
* **uefi:** verify image identity before publishing inventory ([#13624](https://github.com/morluto/rea/issues/13624)) ([ae02c73](https://github.com/morluto/rea/commit/ae02c73adc8d2ad33eecb4cd57fc235fa9788dc1))
* **uninstall:** keep emptied DSH inserts from applying overrides ([#13036](https://github.com/morluto/rea/issues/13036)) ([76da8fd](https://github.com/morluto/rea/commit/76da8fd8baa9ffe61be1d772a3cc1d0ac65dbf8b))
* **uninstall:** report verified removal after staging cleanup failure ([#13293](https://github.com/morluto/rea/issues/13293)) ([2af8248](https://github.com/morluto/rea/commit/2af8248a441a4d49bb2202001393e5ac9c626e6a))
* **v8:** admit the six-word code cache header of V8 8.8 through 11.7 ([cc19240](https://github.com/morluto/rea/commit/cc19240ca963a263f8c33a061782385e76344e0f))
* **v8:** preserve verified code cache results and require exact payload reads ([#14067](https://github.com/morluto/rea/issues/14067)) ([71cea56](https://github.com/morluto/rea/commit/71cea564fb3707c85be8688fa7df6f3bb001e0b1))
* **v8:** report details.limit for V8 code cache per-call budgets ([#14793](https://github.com/morluto/rea/issues/14793)) ([4b56f61](https://github.com/morluto/rea/commit/4b56f617f8ae29d60aed5e32d092ba731cb478d1))
* **verification:** bind DeepSeek skill evidence to its installed directory ([#13238](https://github.com/morluto/rea/issues/13238)) ([e3ce2b5](https://github.com/morluto/rea/commit/e3ce2b53d4225eed98977727534f97c0e0e06433))
* **verification:** distinguish MCP probe refusals from local deadlines ([#13246](https://github.com/morluto/rea/issues/13246)) ([eacbd25](https://github.com/morluto/rea/commit/eacbd2522a4ab17310a1708179fdf118ba76f2cd))
* **verification:** isolate MCP package canaries from target settings ([#13256](https://github.com/morluto/rea/issues/13256)) ([ac0dd6b](https://github.com/morluto/rea/commit/ac0dd6b3716285516cbbc79362468d192faeec56))
* **verification:** read back Qwen skill output before analysis ([#13240](https://github.com/morluto/rea/issues/13240)) ([63ff46e](https://github.com/morluto/rea/commit/63ff46e9ee3c1ea678c33891032c0e70eec67987))
* **verification:** require Gemini native answer and skill provenance ([#13241](https://github.com/morluto/rea/issues/13241)) ([34c69f6](https://github.com/morluto/rea/commit/34c69f606dd5032089de091adaefd6f179afb059))
* **verify:** bound concurrent file reads in architecture and limit guards ([#14720](https://github.com/morluto/rea/issues/14720)) ([d5b4c4b](https://github.com/morluto/rea/commit/d5b4c4bb61390ab77f2f098e272171451871b7bb))
* **verify:** cancel owned DeepSeek Harness commands ([#13035](https://github.com/morluto/rea/issues/13035)) ([42a34f8](https://github.com/morluto/rea/commit/42a34f8a7fea243b1f8e9b3574c814b1d52438b9))
* **verify:** require confirmed DeepSeek process cleanup ([#13043](https://github.com/morluto/rea/issues/13043)) ([4aed56e](https://github.com/morluto/rea/commit/4aed56eccb68e49f411e472134feafd6b2a7996f))
* **verify:** require DeepSeek Harness terminal JSON ([#13034](https://github.com/morluto/rea/issues/13034)) ([9b1631a](https://github.com/morluto/rea/commit/9b1631a1d73e44156b5347838198da358341fc34))
* **views:** bound the evidence-json serialization cache ([#14588](https://github.com/morluto/rea/issues/14588)) ([62ae333](https://github.com/morluto/rea/commit/62ae33320a6a8d239be241cfd931ffe68a9ec2af))
* **views:** validate Android class rows against the selected facet ([#14754](https://github.com/morluto/rea/issues/14754)) ([88a36f7](https://github.com/morluto/rea/commit/88a36f70f00cf65b7a043261fc7768db02a927ac))
* **views:** validate retained web rows against their collection ([#14690](https://github.com/morluto/rea/issues/14690)) ([673e85f](https://github.com/morluto/rea/commit/673e85ffdb3481bda37805b1aa9227a431981425))
* **views:** validate retained web source metadata against producer rules ([#14729](https://github.com/morluto/rea/issues/14729)) ([f9d674e](https://github.com/morluto/rea/commit/f9d674e748b98b024e0b174099eb0171cdad958c))
* **vsix:** read manifest fields in the package namespace ([#14851](https://github.com/morluto/rea/issues/14851)) ([6712d52](https://github.com/morluto/rea/commit/6712d528403984b392f7ab604f09438e5ff744e7))
* **vsix:** resolve the exact web extension entry point ([#14862](https://github.com/morluto/rea/issues/14862)) ([af5db9d](https://github.com/morluto/rea/commit/af5db9d4c821949123f8aa7ec302f4c6a00263d9))
* **vsix:** retain metadata without an identity element ([#14941](https://github.com/morluto/rea/issues/14941)) ([1a61236](https://github.com/morluto/rea/commit/1a61236395fbeb3b85fbe0106af48f5301dbe3c4))
* **wasm:** report details.limit for max_interface_bytes refusals ([#14795](https://github.com/morluto/rea/issues/14795)) ([c366df0](https://github.com/morluto/rea/commit/c366df0bf0db99aea975af62afc90592e5a707f1))
* **wasm:** report observed WABT diagnostic bytes ([#13436](https://github.com/morluto/rea/issues/13436)) ([c60cf4e](https://github.com/morluto/rea/commit/c60cf4e3b8683e3209e51693e02826f85a7e7761))
* **wasm:** state the accepted WABT release range from its owning constant ([#14205](https://github.com/morluto/rea/issues/14205)) ([af53dd9](https://github.com/morluto/rea/commit/af53dd9df125f6e7f2f2e374cbe5a28f8429bc08))
* **web:** align scenario schema guidance with admitted inputs ([#13170](https://github.com/morluto/rea/issues/13170)) ([03b99c2](https://github.com/morluto/rea/commit/03b99c2bcf16463792ed9d096d57de8454ba5390))
* **web:** keep unreadable cookie partitions incomplete ([#13187](https://github.com/morluto/rea/issues/13187)) ([c096373](https://github.com/morluto/rea/commit/c0963732a73415ee855fdcc0c923d6e77c0bb8de))
* **web:** require root identity in CDP session and runtime captures ([#13186](https://github.com/morluto/rea/issues/13186)) ([4807b31](https://github.com/morluto/rea/commit/4807b31749e7882d3ca4a184174ebc1012ea23c0))
* **web:** retain CDP scope and request identity during session preparation ([#13188](https://github.com/morluto/rea/issues/13188)) ([5c39019](https://github.com/morluto/rea/commit/5c390198f78f0b867f7e00a6d3830b089dbf80bd))
* **web:** retain Chromium navigation kind in session evidence ([#13194](https://github.com/morluto/rea/issues/13194)) ([9230f69](https://github.com/morluto/rea/commit/9230f698b34f34c683449fbe34f87fbbbfe34324))
* **website:** format the favicon link ([#13222](https://github.com/morluto/rea/issues/13222)) ([ff04f31](https://github.com/morluto/rea/commit/ff04f31a4af0c200f05863479c6dce20375fb4f8))
* **website:** honor validators and restore the implicit design system ([#14768](https://github.com/morluto/rea/issues/14768)) ([188e2bd](https://github.com/morluto/rea/commit/188e2bd684b1e3be64e5d1332b0db6b19ffb9ea2))
* **website:** improve page loading, image labels, and legacy redirects ([e1c37d6](https://github.com/morluto/rea/commit/e1c37d68a4e44fa2cd3311e49e3980692bc65c00))
* **website:** match social preview accents to REA blue ([753321d](https://github.com/morluto/rea/commit/753321dda66d840c58008119a9e6852cd7c64f25))
* **website:** refresh favicon links and serve a root icon ([b33b674](https://github.com/morluto/rea/commit/b33b6743d9bab514c7131d31e5b28ef645bb59ab))
* **website:** resolve tagged and latest release download links ([#9238](https://github.com/morluto/rea/issues/9238)) ([331808d](https://github.com/morluto/rea/commit/331808dcd28e70f01c1515cf311fd5c64f68b753))
* **website:** restore shared theme script formatting ([#13117](https://github.com/morluto/rea/issues/13117)) ([a1c8f67](https://github.com/morluto/rea/commit/a1c8f67e9934efc0153b3bc2864c13370389b5d3))
* **website:** use the blue REA wordmark for site icons ([2c4776d](https://github.com/morluto/rea/commit/2c4776d9aa9c1167da96f75a27645a23ef3a348e))
* **website:** verify markdown fragments from parsed headings ([#13265](https://github.com/morluto/rea/issues/13265)) ([88d1d9b](https://github.com/morluto/rea/commit/88d1d9b8b5245ce25165f5da3a5eea19740f4886))
* **windows-shortcut:** keep target_extension unknown when declared LinkInfo or RELATIVE_PATH is unread ([#13946](https://github.com/morluto/rea/issues/13946)) ([f9e9e8e](https://github.com/morluto/rea/commit/f9e9e8e4c018f2cac92e7f2f2eb13daf0da7d2d9))
* **windows-shortcuts:** preserve unread target uncertainty ([#13653](https://github.com/morluto/rea/issues/13653)) ([8018344](https://github.com/morluto/rea/commit/8018344145b2d6f77a2379f015c81205312cd542))
* **windows:** accept a private DACL when the user is SYSTEM ([#14769](https://github.com/morluto/rea/issues/14769)) ([62a4bee](https://github.com/morluto/rea/commit/62a4bee42cabefe8979d82229c67e266c79e784d))
* **windows:** keep N-API failures inside the callback ([#13193](https://github.com/morluto/rea/issues/13193)) ([5c9d0aa](https://github.com/morluto/rea/commit/5c9d0aa0b31e56bc9c3798945b185ab428239d63))
* **windows:** recover from a corrupt Node header cache ([#14259](https://github.com/morluto/rea/issues/14259)) ([a19b3db](https://github.com/morluto/rea/commit/a19b3dbaab323be37bb8e20bde833f064d3957d7))
* **yara:** refuse rule files with include directives before yara starts ([#14937](https://github.com/morluto/rea/issues/14937)) ([72c0f5c](https://github.com/morluto/rea/commit/72c0f5caf2b3c19144c6bc8c50a7361a76f2c103))
* **zip:** account apksigner alignment padding before the APK Signing Block ([#14232](https://github.com/morluto/rea/issues/14232)) ([6d408c0](https://github.com/morluto/rea/commit/6d408c048006c54f7e4ca371e78caee3f0d6c43a))


### Performance Improvements

* **adapters/server:** use ownedJsonValueSchema for freshly constructed internal results ([#13459](https://github.com/morluto/rea/issues/13459)) ([6c6005c](https://github.com/morluto/rea/commit/6c6005ca9a9330dc28138d69021d7510d9e49ae6))
* **adapters:** eliminate hot-path overhead across WASM, EVM, Frida, web modules, and HAR ([#13356](https://github.com/morluto/rea/issues/13356)) ([26465e8](https://github.com/morluto/rea/commit/26465e8ae63045372f28383b1dcc4856e9b41644))
* **analysis-view:** cache HAR/scenario capture parsing and avoid repeated JSON.stringify ([#13759](https://github.com/morluto/rea/issues/13759)) ([f32bd1d](https://github.com/morluto/rea/commit/f32bd1da8c829bc988bf637b39b0e5531b9dc65f))
* **analysis-view:** index documents/entities/reads and avoid array reallocations in EnvironmentStateWriteSimulation ([#13497](https://github.com/morluto/rea/issues/13497)) ([d853221](https://github.com/morluto/rea/commit/d8532215396f087e1198584f7a4c4e1b236e60b0))
* **analysis-view:** page unfiltered Go and Rust metadata directly ([#14030](https://github.com/morluto/rea/issues/14030)) ([a6324bd](https://github.com/morluto/rea/commit/a6324bd0740f252d2bfc007967afcca12d45dd1c))
* **analysis-view:** retain frozen snapshots across parent readers and index view lookups ([#13315](https://github.com/morluto/rea/issues/13315)) ([1854918](https://github.com/morluto/rea/commit/185491879816fccd925ec2f75cd1ed2146423845))
* **android:** reuse stat-verified SHA-256 digests across JADX operations ([#13460](https://github.com/morluto/rea/issues/13460)) ([8601170](https://github.com/morluto/rea/commit/86011705e5c65b2436230ca550ec872dd5dedc85))
* **apk-signature:** stream APK signature inspection over FileHandle ([#13877](https://github.com/morluto/rea/issues/13877)) ([6ce7f93](https://github.com/morluto/rea/commit/6ce7f932bdfa0a09e227361ecb3bef02853c684e))
* **apktool/nativeaot:** skip ApktoolDecodeResult deep-clone and index NativeAOT MethodTables by type path ([#13548](https://github.com/morluto/rea/issues/13548)) ([824a994](https://github.com/morluto/rea/commit/824a994ad7e902cd636d7a1b1fedbfaa65c1926e))
* **app/contracts:** O(N) diff multiset, Set filters, and schema fast path ([#13718](https://github.com/morluto/rea/issues/13718)) ([8cb7b19](https://github.com/morluto/rea/commit/8cb7b1990502f5e5821697c3677df600c6be64bb))
* **apple-application:** reuse exact bundle ancestor lookup ([#13682](https://github.com/morluto/rea/issues/13682)) ([ac5cdcb](https://github.com/morluto/rea/commit/ac5cdcbd18791c29f128078ed26b4f54c26df1e0))
* **apple-ips:** stream Mach-O join headers over FileHandle ([#13894](https://github.com/morluto/rea/issues/13894)) ([8e379a3](https://github.com/morluto/rea/commit/8e379a31d86c99d32fee0218dd3cd1bc8bca6836))
* **apple:** eliminate Mach-O multi-pass schema/export re-parses and fuse AppleDispatchCoverage scans ([#13550](https://github.com/morluto/rea/issues/13550)) ([69a691e](https://github.com/morluto/rea/commit/69a691e058e020fc327c0cdaa4709bede3bfe46b))
* **apple:** parse Mach-O on single open during dylib root discovery and pipeline image SHA-256 hashing ([#13629](https://github.com/morluto/rea/issues/13629)) ([8699e69](https://github.com/morluto/rea/commit/8699e69c191bf1379af1df724e22a0abe87d0eea))
* **application/cli:** reuse CapabilityInventory map, avoid BinarySessionStatus deep-clone, and cache admitsOmission ([#13552](https://github.com/morluto/rea/issues/13552)) ([08f6365](https://github.com/morluto/rea/commit/08f6365e9fcfb2587c1d5d154480ee9e994057a8))
* **application/server:** bucket ReleaseExposure layouts, use Set in environmentStateStore, and avoid owned-payload deep-clones ([#13558](https://github.com/morluto/rea/issues/13558)) ([2b5f495](https://github.com/morluto/rea/commit/2b5f495228b0091b886b8447c451f3ab3ade5be1))
* **application:** stat-verify cached packaged guidance bundle and index sections by guide and ordinal ([#13561](https://github.com/morluto/rea/issues/13561)) ([295a63d](https://github.com/morluto/rea/commit/295a63dde311c493eb4139f3deb9067f175908c4))
* **artifacts/android:** reuse ASAR snapshot descriptors and index JADX bridge lookups ([#13361](https://github.com/morluto/rea/issues/13361)) ([4d7a971](https://github.com/morluto/rea/commit/4d7a9710fe19af7e70693ea56c1e5d3a0268baa1))
* **artifacts/browser/contracts:** binary-search Deno owned ranges, fuse ManagedMemberInspector checks, drop redundant Playwright step re-parse, and use Set in schema projection ([#13587](https://github.com/morluto/rea/issues/13587)) ([d328e28](https://github.com/morluto/rea/commit/d328e2852d40cf9d9f98541184b9d31eafe3bbd9))
* **artifacts/contracts:** replace O(N^2) scans with hash joins/sweep-line and hoist expandToolAvailability group maps ([#13585](https://github.com/morluto/rea/issues/13585)) ([afad95f](https://github.com/morluto/rea/commit/afad95fc911f824599a872876ebb646bf772f2ec))
* **artifacts/gpu:** seam-buffer binary scans and cached BinaryReaders ([#13700](https://github.com/morluto/rea/issues/13700)) ([328a1af](https://github.com/morluto/rea/commit/328a1afeae7b6b0ae784b428179f78f5207bd9a4))
* **artifacts:** decide the FAT header once per classified stream ([ba0c50c](https://github.com/morluto/rea/commit/ba0c50ca0e727c6fdab8a363745962107cb85312))
* **artifacts:** eliminate format-dispatch read amplification and prefix/suffix copies ([#13600](https://github.com/morluto/rea/issues/13600)) ([c9c8e1e](https://github.com/morluto/rea/commit/c9c8e1e08884fc14792ad73b2ce098fd6a73238f))
* **artifacts:** keep the inspection's inventory Evidence sealed ([e9bfd51](https://github.com/morluto/rea/commit/e9bfd51266370f4cdc55e4e289746014cb787134))
* **artifacts:** reuse the streamed XML plist verdict when classifying ([743e222](https://github.com/morluto/rea/commit/743e222631d7dfaea8d5a9f80d05646cbf31ff97))
* **artifacts:** skip unused PE carrier hashing for Node SEA ([#13555](https://github.com/morluto/rea/issues/13555)) ([9c7800b](https://github.com/morluto/rea/commit/9c7800b82dd888c908534270b3a3b3c9afc8a4a3))
* **binary:** avoid redundant evidence cloning and probe copies ([#13636](https://github.com/morluto/rea/issues/13636)) ([c0c0801](https://github.com/morluto/rea/commit/c0c080176da241f112eddead30d2044c55c30e29))
* **browser/artifacts/js:** fuse Playwright TraceInventory passes and index ReleaseExposure and Wakaru lookups ([#13514](https://github.com/morluto/rea/issues/13514)) ([8880382](https://github.com/morluto/rea/commit/8880382f216b78eb56cfd48ab453faa7a83e35c1))
* **browser/artifacts/js:** fuse Playwright TraceInventory passes and index ReleaseExposure and Wakaru lookups ([#13518](https://github.com/morluto/rea/issues/13518)) ([8880382](https://github.com/morluto/rea/commit/8880382f216b78eb56cfd48ab453faa7a83e35c1))
* **browser:** avoid owned-payload deep-clones and memoize CDP execution context validation ([#13583](https://github.com/morluto/rea/issues/13583)) ([b627636](https://github.com/morluto/rea/commit/b6276368ee7cf6af8aaae612de68d99fdc0005c4))
* **browser:** eliminate duplicate CaptureRedaction scans, per-event Buffer allocs, and QLOG flatMap churn ([#13581](https://github.com/morluto/rea/issues/13581)) ([5502891](https://github.com/morluto/rea/commit/550289154e35eaecc3cb9ebfebbc0ab1cbff249a))
* **browser:** fetch source maps with bounded lookahead and in-order admission ([#14115](https://github.com/morluto/rea/issues/14115)) ([6ff972d](https://github.com/morluto/rea/commit/6ff972da997e52aa87a295b89152f401d95349a2))
* **browser:** precompile redaction markers, eliminate quadratic secret scans, and scope HAR validation ([#13267](https://github.com/morluto/rea/issues/13267)) ([2afc34e](https://github.com/morluto/rea/commit/2afc34ec6eb2aee43c87a60eee9636db38d22c37))
* **browser:** single-pass CaptureJson parser and zero-allocation Playwright trace skipping ([#13427](https://github.com/morluto/rea/issues/13427)) ([275b574](https://github.com/morluto/rea/commit/275b5740f6c7b52db6556bd555d6e5acc2302982))
* **browser:** wake the bundle worker on observed events ([#13225](https://github.com/morluto/rea/issues/13225)) ([60e0998](https://github.com/morluto/rea/commit/60e099848d3a78860cf8982b28ce88e3a469d52f))
* **captures/io:** stream artifact hashes and preserve bounded export reads ([#13755](https://github.com/morluto/rea/issues/13755)) ([16c827a](https://github.com/morluto/rea/commit/16c827a25f0e29098d9625292580a6ee19656faa))
* **ci:** check out only the cache retention inputs ([#14677](https://github.com/morluto/rea/issues/14677)) ([d0de596](https://github.com/morluto/rea/commit/d0de59653f198f93370ac088db75f67e2336caf7))
* **ci:** check out only timing reporter inputs ([#14378](https://github.com/morluto/rea/issues/14378)) ([79efc75](https://github.com/morluto/rea/commit/79efc75a11dffc857792b6dfb12ac4f24d4412a8))
* **ci:** check recent runs first for a trusted baseline ([#14403](https://github.com/morluto/rea/issues/14403)) ([af06970](https://github.com/morluto/rea/commit/af06970015088f6185e4e01a7e4cffb27695db1b))
* **ci:** defer failure artifacts until main comparison is possible ([#14379](https://github.com/morluto/rea/issues/14379)) ([f145aca](https://github.com/morluto/rea/commit/f145aca28fca368669f1f1af11cb62e248ce58eb))
* **ci:** fail before report setup when no test group ran ([#14483](https://github.com/morluto/rea/issues/14483)) ([d8da811](https://github.com/morluto/rea/commit/d8da811b5c58052a4cb9b43a3b8642d7882e2949))
* **ci:** keep health report changes on portable checks ([#14430](https://github.com/morluto/rea/issues/14430)) ([15d5944](https://github.com/morluto/rea/commit/15d5944ab7c60002bd77eee1bd7456653338af8b))
* **ci:** limit classifier checkouts to inputs used by the tier ([#14546](https://github.com/morluto/rea/issues/14546)) ([e2c0926](https://github.com/morluto/rea/commit/e2c092613c4990039e49e1aacae3a0fab9ae643d))
* **ci:** limit push and qualification classifier checkouts to scripts ([#14341](https://github.com/morluto/rea/issues/14341)) ([62b5d27](https://github.com/morluto/rea/commit/62b5d27638ab12dbc756b4d4252e38a311573f34))
* **ci:** narrow cache retention checkouts ([#14402](https://github.com/morluto/rea/issues/14402)) ([8e4c1c5](https://github.com/morluto/rea/commit/8e4c1c5f8d7e38a68f180738d8335f1eacb10c18))
* **ci:** narrow pull request classifier checkouts to traced inputs ([#14376](https://github.com/morluto/rea/issues/14376)) ([5ef6cd8](https://github.com/morluto/rea/commit/5ef6cd89b5b8cc192683c2e97762bb4c4422fb21))
* **ci:** narrow the CodeQL selector checkout ([#14940](https://github.com/morluto/rea/issues/14940)) ([b3cb15b](https://github.com/morluto/rea/commit/b3cb15bfecb8ff370e6cf89f67a88be20cbf0be4))
* **ci:** omit development tools from failure reporting ([#14332](https://github.com/morluto/rea/issues/14332)) ([30fe9d9](https://github.com/morluto/rea/commit/30fe9d9f424447926ca0b8fb3006ddd6f95f279b))
* **ci:** omit unused PR associations from timing queries ([#14636](https://github.com/morluto/rea/issues/14636)) ([43117a8](https://github.com/morluto/rea/commit/43117a8ae074be6aaddf0f06ea16f562caad4d25))
* **ci:** query static diagnostics by artifact name ([#14476](https://github.com/morluto/rea/issues/14476)) ([02c4209](https://github.com/morluto/rea/commit/02c420939d63a5c983e98815c518dc5d59a379bb))
* **ci:** read each source file once in architecture guards ([#14808](https://github.com/morluto/rea/issues/14808)) ([0de6029](https://github.com/morluto/rea/commit/0de6029fb66258bb1a331e3f3df38bdc48b60a14))
* **ci:** resolve small pinned test batches directly ([#14638](https://github.com/morluto/rea/issues/14638)) ([fb1b4c0](https://github.com/morluto/rea/commit/fb1b4c0fbb4a7bfcc0112fe68d59782c610b9f61))
* **ci:** resolve test snapshot blobs in one tree walk ([#14334](https://github.com/morluto/rea/issues/14334)) ([73c1689](https://github.com/morluto/rea/commit/73c1689aefeabd29d235f8d4341d71f1d3316544))
* **ci:** reuse collected job lists for failure reports ([#14537](https://github.com/morluto/rea/issues/14537)) ([f148353](https://github.com/morluto/rea/commit/f148353ff1737619b8bfa4f4a72430339ecb7d6f))
* **ci:** reuse installed website rendering packages ([#14337](https://github.com/morluto/rea/issues/14337)) ([1e1db9e](https://github.com/morluto/rea/commit/1e1db9e342ad13d26c27f34af8a2d7a5648387c9))
* **ci:** run architecture guards once in full qualification ([#14812](https://github.com/morluto/rea/issues/14812)) ([39d3dba](https://github.com/morluto/rea/commit/39d3dbaac555e138c718e88e3a15c07f565ef6ed))
* **ci:** run scheduled full qualification every six hours ([#14374](https://github.com/morluto/rea/issues/14374)) ([14b9167](https://github.com/morluto/rea/commit/14b916795c9c80ba46109bdb0ea6b9aafe5daf44))
* **ci:** run the Windows typecheck once per matrix ([#14875](https://github.com/morluto/rea/issues/14875)) ([f894805](https://github.com/morluto/rea/commit/f89480536df8cc7ea4187bc686d37e7a202bf135))
* **ci:** skip ancestor lookup for reused scheduled runs ([#14431](https://github.com/morluto/rea/issues/14431)) ([079f426](https://github.com/morluto/rea/commit/079f426eb57f354cdd6034fa93f90a6cf6031f7a))
* **ci:** skip the portable report runner for non-code changes ([#14333](https://github.com/morluto/rea/issues/14333)) ([7e16cb3](https://github.com/morluto/rea/commit/7e16cb3600489aedb28bffd3e79d9e21c75b1c7b))
* **ci:** skip timing downloads for single-test selections ([#14477](https://github.com/morluto/rea/issues/14477)) ([a0390ba](https://github.com/morluto/rea/commit/a0390ba8775a17f2d5123ee326c8ba0966118fe1))
* **ci:** skip unused test runtime uploads ([#14903](https://github.com/morluto/rea/issues/14903)) ([e7c203a](https://github.com/morluto/rea/commit/e7c203a5d97523ae18f4c4ded9efe7abcb4dd03e))
* **ci:** trace fixed-ceiling baselines and owned bridge sources in PR test selection ([#14375](https://github.com/morluto/rea/issues/14375)) ([229ba77](https://github.com/morluto/rea/commit/229ba77b1aa552192ab7b714c93bb3313f130392))
* **ci:** warm caches on main push and run scheduled fast main sweeps ([#14383](https://github.com/morluto/rea/issues/14383)) ([c718143](https://github.com/morluto/rea/commit/c718143643658c81b3d0c1ed4f60b43ce680eed0))
* **cli/mcp:** decouple analysis view contracts and defer tshark PATH probes ([#13316](https://github.com/morluto/rea/issues/13316)) ([787b5aa](https://github.com/morluto/rea/commit/787b5aafb94f69f3b529a13bf47235a1b5ec4295))
* **cli/mcp:** eliminate eager JSON schema work, double projection, and O(N^2) error compaction ([#13466](https://github.com/morluto/rea/issues/13466)) ([8688eb0](https://github.com/morluto/rea/commit/8688eb0195896d3083271dd73c8a490122f64c80))
* **cli/server/dotnet:** single-pass --token-count JSON, indexed CLI command lookup, single status parse, and direct loops ([#13631](https://github.com/morluto/rea/issues/13631)) ([2532add](https://github.com/morluto/rea/commit/2532adda8449989fc12bebef215fbcb3494ff243))
* **cli:** decouple guided-workflows and comparison commands from applicationToolContracts ([#13448](https://github.com/morluto/rea/issues/13448)) ([edbb844](https://github.com/morluto/rea/commit/edbb844e6b11eecb92ddb505e5d5b2b2202aa115))
* **cli:** decouple lazy CLI startup from AnalysisView, session contracts, and MCP registration ([#13435](https://github.com/morluto/rea/issues/13435)) ([3f83c87](https://github.com/morluto/rea/commit/3f83c8720158bb90a480355b449fb98aa903fa61))
* **cli:** keep single-command discovery lazy and skip throwaway Zod parses ([#13254](https://github.com/morluto/rea/issues/13254)) ([38bc4fe](https://github.com/morluto/rea/commit/38bc4fe907973800c1f6469c3d8ad46f1476f51c))
* **cli:** parse valid strict client settings once ([#13271](https://github.com/morluto/rea/issues/13271)) ([82cd526](https://github.com/morluto/rea/commit/82cd526a8115445e04c5edd3c8c5054ee4a17f4e))
* **contracts:** prune only over-depth schema branches instead of reducing whole schemas ([#14107](https://github.com/morluto/rea/issues/14107)) ([d72dc9d](https://github.com/morluto/rea/commit/d72dc9d979c330de90a1f5ed8a62c5f27a8a1dc4))
* **contracts:** simplify inspectWebPageInputSchema to single strictObject ([#13832](https://github.com/morluto/rea/issues/13832)) ([9514e63](https://github.com/morluto/rea/commit/9514e63d2adecd0eff73da8b89346c2f9680a5dd)), refs [#13831](https://github.com/morluto/rea/issues/13831)
* **core:** hoist stateless decoders/regexes and avoid redundant copies ([#13696](https://github.com/morluto/rea/issues/13696)) ([f404cde](https://github.com/morluto/rea/commit/f404cdefa4aa85597e82ffc7fa9d0315f9c8ec96))
* **debuggers/frida:** remove per-line GDB slabs, Rizin double-copies, and Frida per-char allocs ([cd76c54](https://github.com/morluto/rea/commit/cd76c546e0de9d36a60d96adee2960cf92dbabdb))
* **debuggers:** remove GDB slabs, Rizin copies, Frida char allocs ([#13676](https://github.com/morluto/rea/issues/13676)) ([cd76c54](https://github.com/morluto/rea/commit/cd76c546e0de9d36a60d96adee2960cf92dbabdb))
* **debugger:** stop repeating command results as raw_result ([#14146](https://github.com/morluto/rea/issues/14146)) ([609b58b](https://github.com/morluto/rea/commit/609b58b109ebf1034922219472b0c0828d9a0e86))
* **decompile-all:** group durable writes per batch of functions ([#14858](https://github.com/morluto/rea/issues/14858)) ([eb47944](https://github.com/morluto/rea/commit/eb479440030452c26ccf84f2309be615e536f841))
* **deno:** batch reads of redirect table records ([#13416](https://github.com/morluto/rea/issues/13416)) ([d03f470](https://github.com/morluto/rea/commit/d03f4700e645c852c191735dc234217110143f97))
* **desktop:** bound retained text lines while counting full files ([#10207](https://github.com/morluto/rea/issues/10207)) ([71a7e0d](https://github.com/morluto/rea/commit/71a7e0d9ff20cfd79b90ff94d57b6380eb5fec4f))
* **domain:** eliminate canonicalJson sort comparators, multi-pass summary scans, duplicate processObservation parse, and O(W^2) write simulation scan ([#13590](https://github.com/morluto/rea/issues/13590)) ([d4f6703](https://github.com/morluto/rea/commit/d4f67030f79b87c96bd87a3453f8e3ed205e215e))
* **domain:** eliminate per-member object allocations and Reflect.get overhead in jsonSerialization ([#13501](https://github.com/morluto/rea/issues/13501)) ([bc1f867](https://github.com/morluto/rea/commit/bc1f8674f9e026ec5ecb154b060a957cfffc3d03))
* **domain:** eliminate per-member object allocations and Reflect.get overhead in jsonSerialization ([#13502](https://github.com/morluto/rea/issues/13502)) ([bc1f867](https://github.com/morluto/rea/commit/bc1f8674f9e026ec5ecb154b060a957cfffc3d03))
* **domain:** eliminate redundant canonicalJson Zod re-parses, hoist snapshot evidence keys, and fuse O(N^2) write attribution/replay loops ([#13537](https://github.com/morluto/rea/issues/13537)) ([110140c](https://github.com/morluto/rea/commit/110140c41046ff88a91411ad9e88dc6292dfb0c7))
* **domain:** fuse multi-pass application projection classification scans into single passes ([#13540](https://github.com/morluto/rea/issues/13540)) ([c7401ea](https://github.com/morluto/rea/commit/c7401ea330b78b1f166f3ee0f3f8b4b6a9221b8b))
* **domain:** index managed views and avoid bundle re-parse ([#13626](https://github.com/morluto/rea/issues/13626)) ([49b8470](https://github.com/morluto/rea/commit/49b8470f4ea62ab85068e66ccc4b10eb43f9d219))
* **domain:** use Set/Map joins in reconstructionCoverageEvaluation and single-pass summary in managedApplicationGraph ([#13592](https://github.com/morluto/rea/issues/13592)) ([0558c24](https://github.com/morluto/rea/commit/0558c249240d1ad0c9e835abd57ccf3c6151bd10))
* **dotnet:** push down native boundary and member selection predicates ([#13317](https://github.com/morluto/rea/issues/13317)) ([e0d8cc9](https://github.com/morluto/rea/commit/e0d8cc942faa4c96ce7f36b86731316b5872d76a))
* **dwarf/model:** LRU DwarfAbbrevCache and iterative Safetensors JSON ([#13669](https://github.com/morluto/rea/issues/13669)) ([fbd39b2](https://github.com/morluto/rea/commit/fbd39b257042992069663475a6f3012ec7e440a7))
* **dwarf:** stream DWARF compile-unit inspection over FileHandle for ELF, PE, and Mach-O ([#13948](https://github.com/morluto/rea/issues/13948)) ([dcea4ff](https://github.com/morluto/rea/commit/dcea4ff5524396ad27975e70ec2cffcb6cb4c42c))
* **electron/js:** index IPC/package/file lookups and fuse summary passes ([#13507](https://github.com/morluto/rea/issues/13507)) ([5262268](https://github.com/morluto/rea/commit/5262268826932fed264d0e7d2036826cb60c2a76))
* **electron/js:** index IPC/package/file lookups and fuse summary passes ([#13510](https://github.com/morluto/rea/issues/13510)) ([5262268](https://github.com/morluto/rea/commit/5262268826932fed264d0e7d2036826cb60c2a76))
* **elf:** bound kernel module signature digest reads ([#14024](https://github.com/morluto/rea/issues/14024)) ([7487261](https://github.com/morluto/rea/commit/7487261a35ba30e9362be71d9c922d932f5f4674))
* **elf:** cache BinaryReader and support offset reads in elfNoteLayout ([#13688](https://github.com/morluto/rea/issues/13688)) ([43f5d2a](https://github.com/morluto/rea/commit/43f5d2a78b9b05b4a114c93dea99425b242fdbdf))
* **elf:** fuse dynamic symbol hardening predicates into single-pass scan with __ prefix pre-filter ([#13513](https://github.com/morluto/rea/issues/13513)) ([8da89da](https://github.com/morluto/rea/commit/8da89da5e4e1959cd83c0c6ffbf9ce5380d80b10))
* **elf:** fuse initializer section scans into one pass and eliminate symbol-map cloning ([#13475](https://github.com/morluto/rea/issues/13475)) ([366dbc2](https://github.com/morluto/rea/commit/366dbc20bf9e4dd02282c19939cee6c16a6a62f0))
* **elf:** fuse initializer section scans into one pass and eliminate symbol-map cloning ([#13476](https://github.com/morluto/rea/issues/13476)) ([366dbc2](https://github.com/morluto/rea/commit/366dbc20bf9e4dd02282c19939cee6c16a6a62f0))
* **elf:** read only needed debug-link section bytes ([#13980](https://github.com/morluto/rea/issues/13980)) ([b7d29e4](https://github.com/morluto/rea/commit/b7d29e45cd33fb909ded9d51b7e5d2e08d26c1c6))
* **elf:** reuse proven symbol suffixes in unwind lookup ([#14014](https://github.com/morluto/rea/issues/14014)) ([33b4563](https://github.com/morluto/rea/commit/33b4563a3e49e27296fb16fa324cb252878e04c4))
* **elf:** stream ELF debug-link inspection over FileHandle ([#13928](https://github.com/morluto/rea/issues/13928)) ([8e1e4c3](https://github.com/morluto/rea/commit/8e1e4c3966c3fc7803c8f8a468b3bbaa8feafbf9))
* **elf:** stream ELF dependency inspection over FileHandle ([#13915](https://github.com/morluto/rea/issues/13915)) ([2c38fd1](https://github.com/morluto/rea/commit/2c38fd16287085867848ce152ae2e57bf68d2015))
* **elf:** stream ELF note inspection over FileHandle ([#13904](https://github.com/morluto/rea/issues/13904)) ([37c37e3](https://github.com/morluto/rea/commit/37c37e32e7989fe8d5fc0944c9d1d47495071359))
* **elf:** stream ELF unwind-range inspection over FileHandle ([#13931](https://github.com/morluto/rea/issues/13931)) ([b5c7937](https://github.com/morluto/rea/commit/b5c79379fc6896fb6757ba3a3aab25c53766d02e))
* **elf:** stream kernel build-config inspection over FileHandle ([#13942](https://github.com/morluto/rea/issues/13942)) ([f759286](https://github.com/morluto/rea/commit/f759286f35b55630d2f3fc791ec449ffbb6f88cc))
* **elf:** stream kernel module inspection over FileHandle ([#13917](https://github.com/morluto/rea/issues/13917)) ([9291cd6](https://github.com/morluto/rea/commit/9291cd62197eadb5306f4d1939ead32f4d136ddc))
* **entropy:** count bytes by index into an integer table ([5d3276d](https://github.com/morluto/rea/commit/5d3276d14c162b559a500189096a733692212bfc))
* **entropy:** count bytes through one shared loop ([d777c3c](https://github.com/morluto/rea/commit/d777c3c55f90421a35a7a032336c6f4f1c21dd17))
* **entropy:** count selected bytes once and honor admission cancellation ([#13660](https://github.com/morluto/rea/issues/13660)) ([9d64f92](https://github.com/morluto/rea/commit/9d64f92f16afab7c4ac7e6cc217c7f4b196ace7e))
* **environment:** defer tombstone scans until held lookup misses ([#13404](https://github.com/morluto/rea/issues/13404)) ([9119533](https://github.com/morluto/rea/commit/91195338d07d4bb7398afa29fc1a8550f555827d))
* **environment:** reuse measured state reply sizes ([#13824](https://github.com/morluto/rea/issues/13824)) ([1157ff5](https://github.com/morluto/rea/commit/1157ff5d69b223d0718ef9db7e17f04209e6ac08))
* **environment:** streamline recorded list query processing ([#13840](https://github.com/morluto/rea/issues/13840)) ([e31ccfd](https://github.com/morluto/rea/commit/e31ccfd858aa801f3ba0ec693f167703e807abc0))
* **env:** update EnvironmentStateStore indexes incrementally on mutations ([#13791](https://github.com/morluto/rea/issues/13791)) ([1dadbdd](https://github.com/morluto/rea/commit/1dadbdd1d19c75c65eb8db0704091c27e353ac8b))
* **erlang:** stream BEAM IFF inspection over FileHandle ([#13886](https://github.com/morluto/rea/issues/13886)) ([bf1a971](https://github.com/morluto/rea/commit/bf1a9719ed3ea335aef1b68d6f317dd3a796704f))
* **evidence:** eliminate redundant bundle re-validation, cloning, and nested generator yields ([#13257](https://github.com/morluto/rea/issues/13257)) ([9e379c9](https://github.com/morluto/rea/commit/9e379c958951ed245ba6bdadd9ed56bd1f2b5857))
* **evidence:** reuse parsed source inventories across correlation mappings ([a486423](https://github.com/morluto/rea/commit/a486423e0e9e933c78875eadf33d85e15e1efb77))
* **firmware/desktop:** fuse range-snapshot SHA-256 in FirmwareFiles and eliminate owned JSON deep-clones ([#13504](https://github.com/morluto/rea/issues/13504)) ([18a197f](https://github.com/morluto/rea/commit/18a197fb3c4ed85ba752d714f26356f75171c8e8))
* **firmware/desktop:** fuse range-snapshot SHA-256 in FirmwareFiles and eliminate owned JSON deep-clones ([#13505](https://github.com/morluto/rea/issues/13505)) ([18a197f](https://github.com/morluto/rea/commit/18a197fb3c4ed85ba752d714f26356f75171c8e8))
* **firmware:** bound DfuSe overlap diagnostics before formatting ([#13371](https://github.com/morluto/rea/issues/13371)) ([95220bc](https://github.com/morluto/rea/commit/95220bcde12f085144b34a425e8f9bf4557249b0))
* **firmware:** hoist per-record Zod schemas, fuse report scans, and fast-path extractionProblemFacts ([#13542](https://github.com/morluto/rea/issues/13542)) ([234f42b](https://github.com/morluto/rea/commit/234f42bec1e13b43ac83d20e0298502c831d91ef))
* **firmware:** reuse HEX/SREC scratch buffer and eliminate OTA extent cloning ([#13633](https://github.com/morluto/rea/issues/13633)) ([b3aaa3d](https://github.com/morluto/rea/commit/b3aaa3da52353e074b3896f933ae23000941ef82))
* **firmware:** stream the owned reconstructed OTA buffer ([#13380](https://github.com/morluto/rea/issues/13380)) ([457f90e](https://github.com/morluto/rea/commit/457f90e5cd1bf4886870d0819e6257e50480c961))
* **functions:** skip line diffs for identical provider text ([#13422](https://github.com/morluto/rea/issues/13422)) ([ea05f41](https://github.com/morluto/rea/commit/ea05f412045fb8f9c3a4270d039f297d2230f1b3))
* **ghidra/kuna:** fuse checkpoint publish stream-hash+fsync and pre-filter Kuna regex searches ([#13468](https://github.com/morluto/rea/issues/13468)) ([4e581dd](https://github.com/morluto/rea/commit/4e581dd350dcf6ef03ba84c62ee8501dd55449a5))
* **ghidra:** decompile upcoming export functions in parallel ([#14847](https://github.com/morluto/rea/issues/14847)) ([06fa8d0](https://github.com/morluto/rea/commit/06fa8d06343c26c651e339faf2c00d4aca64af59))
* **ghidra:** eliminate non-ASCII search flood, compact bridge inventories, and stream JSON responses ([#13305](https://github.com/morluto/rea/issues/13305)) ([297630c](https://github.com/morluto/rea/commit/297630cbf37dad6b08b196b77e1ff1cf5cd2930e))
* **ghidra:** fuse project snapshot I/O, parallelize language catalog, drop double validation, and add callTool progress heartbeats ([#13310](https://github.com/morluto/rea/issues/13310)) ([5b3ef76](https://github.com/morluto/rea/commit/5b3ef76e4db8f128f3632693cd45b9f99ecf7d25))
* **ghidra:** gate SLEIGH getPcode/getFlows in swiftStringPairs, cache swiftProgram, and index typedJumpTableCases ([#13531](https://github.com/morluto/rea/issues/13531)) ([3ed8c85](https://github.com/morluto/rea/commit/3ed8c857e6c3a16cc51338f52778fab7037a0819))
* **ghidra:** push longest ASCII-foldable substring into bridge for non-ASCII case-insensitive literal searches ([#13485](https://github.com/morluto/rea/issues/13485)) ([bdfd0a1](https://github.com/morluto/rea/commit/bdfd0a16f5cbce3b6ba63b116d6b5014d31208f5))
* **ghidra:** read ahead in the background and for batch_decompile ([#14898](https://github.com/morluto/rea/issues/14898)) ([f7f6757](https://github.com/morluto/rea/commit/f7f67575ac794113c7b9b2144fcf9fd5f125c13d))
* **ghidra:** retain literal search candidates only when filtering narrows them ([#14143](https://github.com/morluto/rea/issues/14143)) ([cebfae5](https://github.com/morluto/rea/commit/cebfae50d906bbacf17516ed467089d1d8c6f3a8))
* **ghidra:** scan defined data for selective string search instead of materializing inventory ([#14101](https://github.com/morluto/rea/issues/14101)) ([107073c](https://github.com/morluto/rea/commit/107073cdb464a56c2ac78e249c515e9a7bc25e92))
* **ghidra:** scan procedures for selective search without retaining inventory ([#14103](https://github.com/morluto/rea/issues/14103)) ([24b0ed5](https://github.com/morluto/rea/commit/24b0ed56dd4b6babf8dfae4bdfb47c089ef6b521))
* **ghidra:** skip redundant leaf matching in ReaGhidraBridge literal searches ([#13439](https://github.com/morluto/rea/issues/13439)) ([beff3a2](https://github.com/morluto/rea/commit/beff3a284280692a27aeea0048793c876b475bd7))
* **ghidra:** stream inventory and search replies directly via JsonWriter ([#13453](https://github.com/morluto/rea/issues/13453)) ([1df51e3](https://github.com/morluto/rea/commit/1df51e3247bf6ed40b7e52b08cb878192ff965d1))
* **go:** stream Go binary inspection over FileHandle for ELF, PE, and Mach-O ([#14003](https://github.com/morluto/rea/issues/14003)) ([08f4b25](https://github.com/morluto/rea/commit/08f4b25e45b4ab1bac8ff4d66b988afabcbc7522))
* **gpu/deno:** reuse CUDA info BinaryReader and seam-buffer Deno scan ([#13710](https://github.com/morluto/rea/issues/13710)) ([2e97220](https://github.com/morluto/rea/commit/2e972207761775e4bb0ce0c58827ee7cb126fac8))
* **gpu:** single-pass embedded PTX parse and reuse sha256 ([#13639](https://github.com/morluto/rea/issues/13639)) ([c1c0509](https://github.com/morluto/rea/commit/c1c0509280603339fe1ead856fbd96ca074450d1))
* **har:** reuse normalized Base64 for retained response bodies ([#13847](https://github.com/morluto/rea/issues/13847)) ([a6847ae](https://github.com/morluto/rea/commit/a6847ae3624b733e45eafb85363e1806cae6c0c1))
* **hopper:** eliminate full name-inventory rebuilds in analyze_function, list_names, and caller reconciliation ([#13307](https://github.com/morluto/rea/issues/13307)) ([ed234b2](https://github.com/morluto/rea/commit/ed234b20163accc77577c1cf7b55c4645e62807a)), refs [#13277](https://github.com/morluto/rea/issues/13277)
* **hopper:** materialize pre-casefolded search inventory in hopper_bridge.py ([#13458](https://github.com/morluto/rea/issues/13458)) ([747656b](https://github.com/morluto/rea/commit/747656b995ccef27d6a9f2e8b9c75e2e3d44b696))
* **hopper:** memoize containing procedure/identity lookups and fuse instruction/block passes in hopper_bridge.py ([#13534](https://github.com/morluto/rea/issues/13534)) ([60a50f1](https://github.com/morluto/rea/commit/60a50f183aa3931c8ba737c6ec072165f1a3723f))
* **hopper:** stat-verify cached Hopper launcher digests in HopperAnalysisProfile ([#13520](https://github.com/morluto/rea/issues/13520)) ([7fa76e9](https://github.com/morluto/rea/commit/7fa76e9fb58e57a44ed8d5f88e226634f6100427))
* **ida/hopper:** push required regex literal candidates to provider bridges ([#13438](https://github.com/morluto/rea/issues/13438)) ([acb714a](https://github.com/morluto/rea/commit/acb714aaf53c9f196319df76760586fda7d827ee))
* **ida:** avoid double full-binary SHA-256 re-hashing and redundant observation cloning ([#13445](https://github.com/morluto/rea/issues/13445)) ([d8a0e06](https://github.com/morluto/rea/commit/d8a0e06c61b2295eeaedf0f43a89a781e678505d))
* **ida:** bootstrap Hex-Rays bridge once, push down string_at and list_funcs filter, and cache imports ([#13469](https://github.com/morluto/rea/issues/13469)) ([522452d](https://github.com/morluto/rea/commit/522452da70edb478b73b6dec8b493819470efd68))
* **ida:** push literal patterns down to find_regex on all protocols and drop catch-all non-ASCII wildcard ([#13291](https://github.com/morluto/rea/issues/13291)) ([dff9b47](https://github.com/morluto/rea/commit/dff9b479ed3228a27bc49037c03ea970123f5a43))
* **il2cpp:** fix 8x yields and hoist opcode checks before BigInt math in executable scans ([#13272](https://github.com/morluto/rea/issues/13272)) ([7269165](https://github.com/morluto/rea/commit/726916532371dfc65643aa1a9d6723b6edc833ed))
* **il2cpp:** keep fastRaw scans active on relocated ELF segments via sorted overlay merge cursor ([#13482](https://github.com/morluto/rea/issues/13482)) ([2d3569d](https://github.com/morluto/rea/commit/2d3569d6d843a483c3c04e70e3019cdcab081151))
* **infrastructure:** memoize EvidenceLedger bundle, remove JSON tree generators, and borrow immutable snapshot members ([#13606](https://github.com/morluto/rea/issues/13606)) ([1b828be](https://github.com/morluto/rea/commit/1b828be15b5385625124bd0c8947706af2dbb262))
* **io:** stream SQLite snapshots, chunk stable artifact reads, and bound procfs and staging-budget I/O ([#13360](https://github.com/morluto/rea/issues/13360)) ([58af29e](https://github.com/morluto/rea/commit/58af29e6b0ad56aaff1c6f714d9c5dfc9690315f))
* **javascript:** build loader context keys without JSON serialization ([2a581ed](https://github.com/morluto/rea/commit/2a581ed95381e461b084b83770a257ebdde3159e))
* **javascript:** cache ambient resolver and fix O(n^2) semantic hot paths ([#13716](https://github.com/morluto/rea/issues/13716)) ([0f987ff](https://github.com/morluto/rea/commit/0f987ff71ed48d855cb2e88ea620fc61d98eb6c2))
* **javascript:** eliminate double preload AST pass and index feature/semantic/IPC/sourcemap lookups ([fde2c87](https://github.com/morluto/rea/commit/fde2c87b86bea29c4b536685c19581e6d61834ef))
* **javascript:** group renderer scripts without repeated copies ([#13328](https://github.com/morluto/rea/issues/13328)) ([0437d74](https://github.com/morluto/rea/commit/0437d74bd021e4ed48e41fb01527e861dfb8cc54))
* **javascript:** index artifact package directory lookups ([#13327](https://github.com/morluto/rea/issues/13327)) ([4b86932](https://github.com/morluto/rea/commit/4b86932527819cfa33fc234c0cdcb4919e1653f7))
* **javascript:** index feature, semantic, IPC, and source map lookups ([#13319](https://github.com/morluto/rea/issues/13319)) ([fde2c87](https://github.com/morluto/rea/commit/fde2c87b86bea29c4b536685c19581e6d61834ef))
* **javascript:** index widened summary coverage by root ([#13007](https://github.com/morluto/rea/issues/13007)) ([f2d5cd6](https://github.com/morluto/rea/commit/f2d5cd633734c1baeda7ac73a31fc7f2e40550fe))
* **javascript:** keep the worker reusable after a final discovery refusal ([c2779ae](https://github.com/morluto/rea/commit/c2779ae514730f8fd1e568d60d3ca107698aaceb))
* **javascript:** merge data-effect traversals and look up callable kinds ([#14149](https://github.com/morluto/rea/issues/14149)) ([8f4f397](https://github.com/morluto/rea/commit/8f4f397341df68fbe665da34082f8649ab86721d)), refs [#14147](https://github.com/morluto/rea/issues/14147)
* **javascript:** park the worker after preload-discovery allowance refusals ([ef59a1f](https://github.com/morluto/rea/commit/ef59a1f0a331c61f1fcfea184ff734dc49fa0d34))
* **javascript:** reuse completed CommonJS module-source queries ([2e0a791](https://github.com/morluto/rea/commit/2e0a79115a9f8a7c4999c47fa724cc7a58792fdf))
* **javascript:** reuse lexical returned-reference facts across ambient writes ([#13004](https://github.com/morluto/rea/issues/13004)) ([d43fc10](https://github.com/morluto/rea/commit/d43fc1051134823b1f52a7a3ed564051948e0aa1))
* **javascript:** reuse preload-discovery static checkpoints in the normal pass ([5b280e1](https://github.com/morluto/rea/commit/5b280e1f9faac0df1ec5310c7037e88ca6c4c94e))
* **javascript:** share one lexical index between static and semantic analysis ([#14148](https://github.com/morluto/rea/issues/14148)) ([24d2c4f](https://github.com/morluto/rea/commit/24d2c4f16b6422f81a56c9e5f8029b35eef49e5b))
* **javascript:** share settled ambient call continuations ([#13010](https://github.com/morluto/rea/issues/13010)) ([2e45687](https://github.com/morluto/rea/commit/2e45687dfde28274a5451223695a14f0ae6e5afd))
* **javascript:** skip captured-selection normalization without captures ([42a4bb5](https://github.com/morluto/rea/commit/42a4bb51703b1b2598fc7ce02c53d03c3b4102af))
* **javascript:** skip checkpoint encoding without reuse capacity ([d78eee1](https://github.com/morluto/rea/commit/d78eee196aa045445fbb0fe31e09036b3c70ac9b))
* **java:** validate the Maven XML node allowance in one scan ([#13395](https://github.com/morluto/rea/issues/13395)) ([66c192a](https://github.com/morluto/rea/commit/66c192a4508e947863b3ce5208a17957c60b9f91))
* **js/browser/uefi:** index export shape coverage and AST writes, eliminate CdpRuntimeRequests re-parse and UefiLzmaWorker JSON round-trip ([#13535](https://github.com/morluto/rea/issues/13535)) ([5930204](https://github.com/morluto/rea/commit/593020442d2cffa67d9c668b96075267bfd3a5a7))
* **js/env-state:** index chunk/document/bulk-target lookups and fuse Electron IPC/boundary scans ([#13554](https://github.com/morluto/rea/issues/13554)) ([f3ec898](https://github.com/morluto/rea/commit/f3ec898845793111e371b0543999ecc5bd1d4a5c))
* **json:** eliminate per-object generators and defineProperty overhead in jsonValue ([#13444](https://github.com/morluto/rea/issues/13444)) ([1e6880c](https://github.com/morluto/rea/commit/1e6880cef7f8f623b2a698cae0276b18fdb859e3))
* **json:** eliminate redundant JSON validation and deep-clone tree walks ([#13805](https://github.com/morluto/rea/issues/13805)) ([6cda340](https://github.com/morluto/rea/commit/6cda340ec9483b3f67969e5a6debb2634dce5dc2))
* **kuna:** avoid per-line Buffer.concat allocations in KunaProjectFiles.scanLines ([#13270](https://github.com/morluto/rea/issues/13270)) ([f7355b1](https://github.com/morluto/rea/commit/f7355b1b61cf01098ce3bf1bc8d67bd659418e25))
* **kuna:** share stat-verified executable cache and fuse .c export hashing with source scanning ([#13508](https://github.com/morluto/rea/issues/13508)) ([963535f](https://github.com/morluto/rea/commit/963535fb15ec0fa01fced2a8272c7b0acf4da748))
* **macho:** bound positional command string probes ([#13925](https://github.com/morluto/rea/issues/13925)) ([8ad7517](https://github.com/morluto/rea/commit/8ad75170fdb25b0d4e83cf8dcaf7815981cf5ee1))
* **macho:** defer segment geometry until lazy metadata needs it ([#13949](https://github.com/morluto/rea/issues/13949)) ([622c9a7](https://github.com/morluto/rea/commit/622c9a79d63c328a6fb082293ab8200c919a8beb))
* **macho:** streamline legacy rebase run marking ([#13881](https://github.com/morluto/rea/issues/13881)) ([4d6ca25](https://github.com/morluto/rea/commit/4d6ca255459e052a6a91d454aa24d308b26a04cb))
* **macho:** streamline native export inventory merging ([#13932](https://github.com/morluto/rea/issues/13932)) ([5142124](https://github.com/morluto/rea/commit/5142124ca3d52367b1266b14d8587f4a65cb633a))
* **macho:** streamline slice selection diagnostics ([#13905](https://github.com/morluto/rea/issues/13905)) ([389d984](https://github.com/morluto/rea/commit/389d984b4fda665ca5f27c7dc4a38c89a98aed77))
* **mcp/cli:** skip unused output schema projection, error deep-clones, and startup z.toJSONSchema ([#13426](https://github.com/morluto/rea/issues/13426)) ([375483b](https://github.com/morluto/rea/commit/375483b6b3f8969e10fd5d96f5d38eee5cf9770a))
* **mcp/providers:** accelerate toolResultEncoding via C++ byteLength/stringify, memoize tshark PATH probes, and enlarge managed hash buffer ([#13474](https://github.com/morluto/rea/issues/13474)) ([90ca43e](https://github.com/morluto/rea/commit/90ca43e05240981db5749ac048dcb8fe93e0e7d0))
* **mcp/providers:** eliminate ErrorEvidenceTransport double-encoding and redundant deep-clones ([#13495](https://github.com/morluto/rea/issues/13495)) ([5b63cf1](https://github.com/morluto/rea/commit/5b63cf16eea03282a8ff96a71ef0157c84e4a3bd))
* **mcp:** filter prompt completions before sorting ([#13251](https://github.com/morluto/rea/issues/13251)) ([0299413](https://github.com/morluto/rea/commit/0299413e86660456f5abd4f0c46921a16cbb1102))
* **mcp:** index tool contracts, skip unadvertised projection, parallelize status probes, and stream tool result sizing ([#13263](https://github.com/morluto/rea/issues/13263)) ([7a2e8da](https://github.com/morluto/rea/commit/7a2e8da4959d73f88365aec6de48859dd6a6346e))
* **mcp:** reduce deferred catalog startup data ([#13039](https://github.com/morluto/rea/issues/13039)) ([8f2b865](https://github.com/morluto/rea/commit/8f2b865c0645aab11a1d5d4c027d34089a925bf2))
* **mcp:** serve compact output schemas from the build-recorded catalog ([#14121](https://github.com/morluto/rea/issues/14121)) ([54d62c7](https://github.com/morluto/rea/commit/54d62c75da2f2bd9267415899b4a0548c7900d35))
* **model/uefi/rizin:** cache GGUF/UEFI BinaryReaders and share O(1) FifoQueue ([#13745](https://github.com/morluto/rea/issues/13745)) ([91b45c0](https://github.com/morluto/rea/commit/91b45c0aee520ff83355d8d11ff7fb2f49decda4))
* **model:** reduce GGUF header parsing overhead ([#13634](https://github.com/morluto/rea/issues/13634)) ([33ca1be](https://github.com/morluto/rea/commit/33ca1be61cdb79e9bee579c9de1e050a8025e923))
* **native-aot:** reuse PeImage BinaryReader and hoist hot-path math ([#13685](https://github.com/morluto/rea/issues/13685)) ([36b8675](https://github.com/morluto/rea/commit/36b8675833b40a38955b910a6836499d357a7747))
* **native/apple:** optimize RELR bitmap loop, BFS queue, and Mach-O legacy rebase checks ([fe982a1](https://github.com/morluto/rea/commit/fe982a1d7ce149ec96b28ea01a8d30548caf4c19))
* **native/apple:** optimize RELR loop, BFS queue, and Mach-O rebases ([#13681](https://github.com/morluto/rea/issues/13681)) ([fe982a1](https://github.com/morluto/rea/commit/fe982a1d7ce149ec96b28ea01a8d30548caf4c19))
* **native/process:** avoid symbol BigInt/string allocs and trim process polls ([#13720](https://github.com/morluto/rea/issues/13720)) ([f92a062](https://github.com/morluto/rea/commit/f92a06226ae6e55fed2526ef14c5ac106935a7ec))
* **native/sqlite/apple:** eliminate double full-payload Zod re-validation and owned JSON deep-cloning ([#13511](https://github.com/morluto/rea/issues/13511)) ([0a88a24](https://github.com/morluto/rea/commit/0a88a24d7aa6ccefee5228ce5f2a59d502511e02))
* **native/sqlite/apple:** eliminate double full-payload Zod re-validation and owned JSON deep-cloning ([#13516](https://github.com/morluto/rea/issues/13516)) ([0a88a24](https://github.com/morluto/rea/commit/0a88a24d7aa6ccefee5228ce5f2a59d502511e02))
* **native:** eliminate hot allocations in ELF/DWARF readers and enlarge signature copy chunks ([#13318](https://github.com/morluto/rea/issues/13318)) ([79887f7](https://github.com/morluto/rea/commit/79887f7a3bc75e26118bc26ce65095c3ba9c59ae))
* **native:** eliminate quadratic lookups, comparator Zod/stringify churn, and redundant clones across native workflows ([#13306](https://github.com/morluto/rea/issues/13306)) ([6cc7de3](https://github.com/morluto/rea/commit/6cc7de3005e42457fc05240d0e8b6d364f7843f7))
* **native:** maintain owner index for ObjC dispatch implementations instead of O(C*M) filtering ([#13269](https://github.com/morluto/rea/issues/13269)) ([b38a496](https://github.com/morluto/rea/commit/b38a49656aa314cc3a84afaa1a11d6c4324a29d6))
* **native:** pre-screen IL2CPP slots and reuse ObjC/PE indices ([#13314](https://github.com/morluto/rea/issues/13314)) ([ac4f655](https://github.com/morluto/rea/commit/ac4f65585846fc8542234ce1366b8a251336a790))
* **native:** stream binary hardening inspection over FileHandle for ELF, PE, and Mach-O ([#13934](https://github.com/morluto/rea/issues/13934)) ([9d204d4](https://github.com/morluto/rea/commit/9d204d40d858c404cf7a627a22be5c4fa6293225))
* **native:** stream PE and ELF export-table inspection over FileHandle ([#13951](https://github.com/morluto/rea/issues/13951)) ([7283e8e](https://github.com/morluto/rea/commit/7283e8e67836a2978e10ddfd03dee77692680897))
* **ntfs:** stream MFT record decoding in O(recordBytes) memory ([#13957](https://github.com/morluto/rea/issues/13957)) ([1486488](https://github.com/morluto/rea/commit/1486488782cc72be8c714663508440c93b3b501a))
* **nuget:** stream .nupkg ZIP over FileHandle instead of buffering full archive ([#13835](https://github.com/morluto/rea/issues/13835)) ([bddb023](https://github.com/morluto/rea/commit/bddb0233250ee29de3c3832aa785eb07383c8ead))
* **objc:** streamline exact class identity projection ([#13897](https://github.com/morluto/rea/issues/13897)) ([cdca45c](https://github.com/morluto/rea/commit/cdca45c2709b61c303864667b02cd4fd9ef8cb5c))
* **parsers:** eliminate Flutter snapshot re-read/concat, PTX per-char regexes, HEX reduce loops, MFT magic copies, and per-entry TextDecoder allocs ([#13615](https://github.com/morluto/rea/issues/13615)) ([a9ebb65](https://github.com/morluto/rea/commit/a9ebb65d887654693ee951b7e5ffc7cc210b089e))
* **parsers:** eliminate hot-loop allocs in UEFI, NTFS USN, PE, Go, Rust, and Maven ([841d41d](https://github.com/morluto/rea/commit/841d41df31549e1d8fc424bfb1f47c61818de048))
* **parsers:** eliminate JNI exception-driven scans, IB JSON round-trips, Node SEA chunk copies, and O(N*F) Apple root scans ([#13608](https://github.com/morluto/rea/issues/13608)) ([5391e40](https://github.com/morluto/rea/commit/5391e40ddef966bf107265526925bc72b8f6caa7))
* **parsers:** index PE RVA lookups and remove per-item parser allocations ([#13602](https://github.com/morluto/rea/issues/13602)) ([3699755](https://github.com/morluto/rea/commit/36997555d26a874ce6cd4c90b67ca06e7cf7f881))
* **parsers:** optimize Safetensors JSON, ElectronFuse scan, and SourceMap hashing ([7a2be3c](https://github.com/morluto/rea/commit/7a2be3c7d4225cce4e4b39933bbfee698da782ed))
* **parsers:** optimize Safetensors, ElectronFuse, and SourceMap ([#13645](https://github.com/morluto/rea/issues/13645)) ([7a2be3c](https://github.com/morluto/rea/commit/7a2be3c7d4225cce4e4b39933bbfee698da782ed))
* **parsers:** optimize UEFI uniformity, FIT reader, and HAR validation ([#13657](https://github.com/morluto/rea/issues/13657)) ([d5f35cd](https://github.com/morluto/rea/commit/d5f35cd16230ebf6973c0f451baee1b2b4646ddc))
* **parsers:** remove hot-loop allocs in UEFI, USN, PE, Go, Rust, Maven ([#13647](https://github.com/morluto/rea/issues/13647)) ([841d41d](https://github.com/morluto/rea/commit/841d41df31549e1d8fc424bfb1f47c61818de048))
* **parsers:** replace quadratic trailing-quantifier regexes with linear edge scans ([#13757](https://github.com/morluto/rea/issues/13757)) ([c1cef72](https://github.com/morluto/rea/commit/c1cef729c9b66e362a7498273d9bc2ff44a17166))
* **parsers:** SIMD Buffer.indexOf & byte carry in FlutterPayloadScan, single-pass Beam/NuGet parsers ([#13764](https://github.com/morluto/rea/issues/13764)) ([760e68b](https://github.com/morluto/rea/commit/760e68bf0fd7190d7671705af84ec95404ec0918))
* **parsers:** single-pass XML plist Base64 table, cached TextDecoders, and fused KeyedArchive/Protobuf/JNI/P-Invoke hot paths ([#13594](https://github.com/morluto/rea/issues/13594)) ([e8d8803](https://github.com/morluto/rea/commit/e8d8803898d5f76f11a98805deb7549568d8becc))
* **pcap/desktop:** optimize DNS, tshark, glossary, and desktop caches ([#13679](https://github.com/morluto/rea/issues/13679)) ([06349ac](https://github.com/morluto/rea/commit/06349acef7cf679c4833b70e42af622f3241d31b))
* **pcap/desktop:** optimize DNS/tshark/glossary scans and cache desktop RegExps/TextDecoders ([06349ac](https://github.com/morluto/rea/commit/06349acef7cf679c4833b70e42af622f3241d31b))
* **pcap/pwntools:** eliminate redundant parsing, linear scans, and quadratic allocations ([#13359](https://github.com/morluto/rea/issues/13359)) ([18f5b7b](https://github.com/morluto/rea/commit/18f5b7b4db6b24789084ebb1c81ad552893bc48a))
* **pcap:** skip second tshark DNS pass when base dissection observes no DNS traffic ([#13455](https://github.com/morluto/rea/issues/13455)) ([6d254f0](https://github.com/morluto/rea/commit/6d254f0795a3639412d60333dfc9530c46cd0570))
* **pcap:** stat-verify unchanged Wireshark executables and parallelize tool admission ([#13500](https://github.com/morluto/rea/issues/13500)) ([fe1c0d6](https://github.com/morluto/rea/commit/fe1c0d6b94b9f8614fd556b9527f5904aa5e5fcf))
* **pe:** compute ILT pefile cap in O(1) and eliminate BigInt allocation in IAT walk ([#13484](https://github.com/morluto/rea/issues/13484)) ([230105c](https://github.com/morluto/rea/commit/230105c681e9950cd457dbd13529a9f11c137565))
* **pe:** index PE export address-to-file mappings with createFileMappingIndex ([#13487](https://github.com/morluto/rea/issues/13487)) ([38cb06c](https://github.com/morluto/rea/commit/38cb06c4c6f0745c426655d0b397dac2cd47b919))
* **pe:** index PE export address-to-file mappings with createFileMappingIndex ([#13489](https://github.com/morluto/rea/issues/13489)) ([38cb06c](https://github.com/morluto/rea/commit/38cb06c4c6f0745c426655d0b397dac2cd47b919))
* **pe:** stream PE certificates over FileHandle ([#13884](https://github.com/morluto/rea/issues/13884)) ([eae4b4c](https://github.com/morluto/rea/commit/eae4b4cd2e1a2e77e62a3551b7960317681c8a10))
* **pe:** stream PE import inspection over FileHandle ([#13924](https://github.com/morluto/rea/issues/13924)) ([257f194](https://github.com/morluto/rea/commit/257f194100c096ec5355cec3f4abc599978cd806))
* **pe:** stream PE load-config inspection over FileHandle ([#13901](https://github.com/morluto/rea/issues/13901)) ([5841267](https://github.com/morluto/rea/commit/58412674db7875dd8d3f5271fefcc1db3c0cb914))
* **pe:** stream PE resource inspection over FileHandle ([#13899](https://github.com/morluto/rea/issues/13899)) ([3668a99](https://github.com/morluto/rea/commit/3668a994220e0a206cd1ad89badfc879b563c161))
* **process/ghidra/hopper:** eliminate per-char array allocs, O(P*U) filesystem scans, unbounded wire sizing, and full-binary chunk copies ([#13529](https://github.com/morluto/rea/issues/13529)) ([3a0d9d6](https://github.com/morluto/rea/commit/3a0d9d6874b25fc0e49cfb8fc1d5e56760ae770e))
* **process/server/ida:** O(1) tail capture, pre-filtered CapabilityInventory, Map process-table joins, and owned IDA JSON validation ([#13612](https://github.com/morluto/rea/issues/13612)) ([fbe14d6](https://github.com/morluto/rea/commit/fbe14d6bd6e8c93c048cbba039d5b69985031d46))
* **process:** avoid full-chunk Buffer.concat in ProcessOutputTokenScanner ([#13727](https://github.com/morluto/rea/issues/13727)) ([fcc357b](https://github.com/morluto/rea/commit/fcc357b936f347811267df46402407a1909a939a))
* **process:** bound Linux /proc FD concurrency and reuse relation identities in token sweep ([#13780](https://github.com/morluto/rea/issues/13780)) ([fe3cb34](https://github.com/morluto/rea/commit/fe3cb343844616b4dae3e46173aae4e7ab4e9cab))
* **process:** fix expectedSize EOF probing in readBoundedFileBytes and eliminate 2x buffer copies ([#13494](https://github.com/morluto/rea/issues/13494)) ([9a85100](https://github.com/morluto/rea/commit/9a85100b59e06f29f3f9e2a6d301b845e0794545))
* **process:** pool regex workers across match calls ([#14114](https://github.com/morluto/rea/issues/14114)) ([dcf7e25](https://github.com/morluto/rea/commit/dcf7e25d096b7af855fcdcc425dfc7bf181a24aa))
* **process:** replace nested-loop joins with Set hash joins in process ownership observation ([#13490](https://github.com/morluto/rea/issues/13490)) ([1482cc8](https://github.com/morluto/rea/commit/1482cc87eaab1a0e5ce60c4c67c98c599bf3f85c))
* **process:** transfer chunked string buffers into RegexMatcher worker ([#13428](https://github.com/morluto/rea/issues/13428)) ([48d4b61](https://github.com/morluto/rea/commit/48d4b6145a79fa56e7b1bdff687f55f652825dc5))
* **process:** wake OwnedCommand on output close, lazily materialize diagnostic snapshots, and bound tail copies ([#13261](https://github.com/morluto/rea/issues/13261)) ([b795aee](https://github.com/morluto/rea/commit/b795aee553fbfa992e5f5cf115cb2481625ca632))
* **providers:** stat-verify cached xcrun tool resolution and digests in XcrunCommandRunner ([#13579](https://github.com/morluto/rea/issues/13579)) ([a63c373](https://github.com/morluto/rea/commit/a63c373a745d7c5ce1c9bf3d1e0a50403f2c5484))
* **pwntools:** validate only envelope and invariants in PwntoolsLayoutProvider ([#13546](https://github.com/morluto/rea/issues/13546)) ([20446e3](https://github.com/morluto/rea/commit/20446e3746e8888443ed5b98daa6a1a7d2077c9f))
* **release-exposure:** reuse verified packaged PE bytes ([#13385](https://github.com/morluto/rea/issues/13385)) ([55a320b](https://github.com/morluto/rea/commit/55a320be8706152baf844c22916cd81393eff23b))
* **release-exposure:** stream PE CodeView/PDB inspection over FileHandle ([#13896](https://github.com/morluto/rea/issues/13896)) ([ca3b02f](https://github.com/morluto/rea/commit/ca3b02fb0289d7c5cc0a5d77b84050d826b075bd))
* **resources:** refuse non-ASAR Pickle prefixes without building errors ([669147e](https://github.com/morluto/rea/commit/669147e9ebf2a2fa6d46a7c132739fde03b79c4d))
* **rust:** reuse the Wasm section probe for custom name lengths ([#14035](https://github.com/morluto/rea/issues/14035)) ([e219c97](https://github.com/morluto/rea/commit/e219c9748e1bf15600993a6b6c4df3b8204ecfba))
* **rust:** single-pass package validation in RustAuditableReader ([#13671](https://github.com/morluto/rea/issues/13671)) ([6024860](https://github.com/morluto/rea/commit/602486090348a765f1ac82a5219cb90a81d5b50f))
* **rust:** stream Rust binary inspection over FileHandle for ELF, PE, Mach-O, and WebAssembly ([#13979](https://github.com/morluto/rea/issues/13979)) ([189785a](https://github.com/morluto/rea/commit/189785a2409121d32755d83a698d804a0efa7750))
* **rust:** validate cargo-auditable packages in one pass without Zod re-clone ([6024860](https://github.com/morluto/rea/commit/602486090348a765f1ac82a5219cb90a81d5b50f))
* **schemas:** eliminate generator/clone overhead in schema compaction and compact union projections ([#13313](https://github.com/morluto/rea/issues/13313)) ([87243c0](https://github.com/morluto/rea/commit/87243c0c0e1d5ff9e99daf85d93c046c49e2ef11))
* **schemas:** use discriminatedUnion and ownedJsonValueSchema for O(1) dispatch and zero-clone parsing ([#13311](https://github.com/morluto/rea/issues/13311)) ([e807ccd](https://github.com/morluto/rea/commit/e807ccdc4810386f4dc6568442d3f970f7f5812d)), refs [#13302](https://github.com/morluto/rea/issues/13302)
* **search,kuna:** optimize RegexMatcher worker dispatch and Kuna inventory validators ([2f171fa](https://github.com/morluto/rea/commit/2f171faa9f2a1ad8fa934ea7b769843e6f205fd0))
* **search/kuna:** optimize regex worker dispatch and Kuna inventory validation ([#13320](https://github.com/morluto/rea/issues/13320)) ([2f171fa](https://github.com/morluto/rea/commit/2f171faa9f2a1ad8fa934ea7b769843e6f205fd0))
* **search/paging:** O(limit) unfiltered & indexed views, O(N) offset scan, cached unknown sort, bounded scope ([#13750](https://github.com/morluto/rea/issues/13750)) ([1cc19d5](https://github.com/morluto/rea/commit/1cc19d5ce48cae0fb8b6d2af146300f7788c37f3))
* **search:** derive literal candidates from regex alternations ([#14106](https://github.com/morluto/rea/issues/14106)) ([90c374e](https://github.com/morluto/rea/commit/90c374ea9cfabed58feca6925e3d829d1c89b267))
* **search:** precompute guidance word sets, skip regex worker on empty candidates, and index Go view lookups ([#13610](https://github.com/morluto/rea/issues/13610)) ([2c57cf1](https://github.com/morluto/rea/commit/2c57cf195eb9dca6e7d6083575a4ba8bc749af9a))
* **server:** carry overflowing error encoding in WeakMap for ErrorEvidenceTransport ([#13812](https://github.com/morluto/rea/issues/13812)) ([d1a9a67](https://github.com/morluto/rea/commit/d1a9a67664f01ac499b285f2ebdde36dba7ccc0f))
* **server:** measure MCP tool result parts in a single zero-allocation scan ([#13598](https://github.com/morluto/rea/issues/13598)) ([09a5ea1](https://github.com/morluto/rea/commit/09a5ea1abcfb3b623d4d43e440ea44f1fc15182c))
* **server:** memoize tools/list schemas and index trace views ([#13618](https://github.com/morluto/rea/issues/13618)) ([cd7db43](https://github.com/morluto/rea/commit/cd7db43895be6afd33944348e498cc952a622b8f))
* **server:** zero-alloc errorTextWireBytes, lazy overflow recovery, skip duplicate SDK validation ([#13766](https://github.com/morluto/rea/issues/13766)) ([f51aa44](https://github.com/morluto/rea/commit/f51aa44e74bc26f30edb2cff5e32933c33a22d77))
* **setup:** index YAML alias bindings in document order ([#13295](https://github.com/morluto/rea/issues/13295)) ([560e2ef](https://github.com/morluto/rea/commit/560e2ef267229e2a133879a1d3d663c1e88d5bbb))
* **snapshots:** borrow immutable payloads and avoid double profile clone in AnalysisSnapshotCache.lookup ([#13620](https://github.com/morluto/rea/issues/13620)) ([5468605](https://github.com/morluto/rea/commit/54686057aeefeddbad36f220da37a93742d6c1fd))
* **sourcemaps/browser/uefi:** event-driven wait, pre-sorted redaction, O(1) queue ([#13707](https://github.com/morluto/rea/issues/13707)) ([c5efbff](https://github.com/morluto/rea/commit/c5efbffc95646b4f17802b0ebbbddc168e8cbb2d))
* **sqlite:** reuse stateless TextDecoder codecs and skip redundant truncation scan on short pages ([#13274](https://github.com/morluto/rea/issues/13274)) ([264c398](https://github.com/morluto/rea/commit/264c398c0d3299bb4de5a58e23e7f92637a08cdf))
* **swift:** streamline symbol inventory classification ([#13902](https://github.com/morluto/rea/issues/13902)) ([78756a5](https://github.com/morluto/rea/commit/78756a52b4949125fd181dc9e0d68e7550a0714b))
* **tar:** update global PAX map in place after budget accounting ([#14580](https://github.com/morluto/rea/issues/14580)) ([43cdd26](https://github.com/morluto/rea/commit/43cdd264b2dd1106de7b4d7230240136fe2f52cd))
* **test:** classify tracked tests once for project policy checks ([#14331](https://github.com/morluto/rea/issues/14331)) ([eb256b3](https://github.com/morluto/rea/commit/eb256b3ac6ead12c11fe9b52ae1891b57ee8f4da))
* **tests:** supervise direct vitest scripts through run-exclusive on POSIX ([#14104](https://github.com/morluto/rea/issues/14104)) ([e60777b](https://github.com/morluto/rea/commit/e60777b76fba2a91b67e30e9a6175bd9e77d4ddf))
* **uefi:** pool framed LZMA worker and fuse single-pass publication ([#13338](https://github.com/morluto/rea/issues/13338)) ([6a20a88](https://github.com/morluto/rea/commit/6a20a88e8149ffe2cd03cd5c1da195defbae652f))
* **uefi:** skip verified erased padding in NVRAM scans ([#14069](https://github.com/morluto/rea/issues/14069)) ([07b6a3d](https://github.com/morluto/rea/commit/07b6a3dc5f496081c60f4d122d08bad292a21509))
* **uefi:** summarize firmware extraction by default over MCP ([e617a55](https://github.com/morluto/rea/commit/e617a55385daf3dea0243e340a8bf3c33232b42a))
* **uefi:** summarize firmware inspection by default over MCP ([11ac37a](https://github.com/morluto/rea/commit/11ac37a42ffd9f4036d422f66a369302c7154a60))
* **uefi:** write LZMA frame headers and bodies separately ([#13768](https://github.com/morluto/rea/issues/13768)) ([6a7767b](https://github.com/morluto/rea/commit/6a7767b609bba770ef43d0b0c574b6d083724888))
* **v8:** stream V8 code cache inspection over FileHandle ([#13907](https://github.com/morluto/rea/issues/13907)) ([836cb8a](https://github.com/morluto/rea/commit/836cb8a01e1610844a710373e5a495864b476b2e))
* **views/env:** WeakMap lookup indexes, lazy entityIds, and avoid hot-loop JSON.stringify ([#13747](https://github.com/morluto/rea/issues/13747)) ([fd96dca](https://github.com/morluto/rea/commit/fd96dca95a3b9862f0fe3077e1fadc6d6e6a5948))
* **views/js:** route indexed views through selectIndexedViewRows and avoid iterableReferences copy ([#13775](https://github.com/morluto/rea/issues/13775)) ([819d046](https://github.com/morluto/rea/commit/819d046e604bc48d78cd6f6aa02cf52aabcf7b85))
* **views:** O(limit) unfiltered paging and pickFields in api, endpoint, source, and trace views ([#13794](https://github.com/morluto/rea/issues/13794)) ([ef21d8f](https://github.com/morluto/rea/commit/ef21d8f4065308e6eb60985e1147ef5bbda4485c))
* **views:** O(limit) unfiltered paging and pickFields in desktop, graphql, and model views ([#13784](https://github.com/morluto/rea/issues/13784)) ([ad5cc56](https://github.com/morluto/rea/commit/ad5cc564afadf00b2966f480d153a15edc8a8f36))
* **views:** page exact Playwright trace index hits directly ([#14031](https://github.com/morluto/rea/issues/14031)) ([5aed462](https://github.com/morluto/rea/commit/5aed462db44d5044e17dc5d1e550f915e796909c))
* **wasm:** parallelize WABT tool admission, stat-verify unchanged binaries, and halve snapshot re-hashing ([#13470](https://github.com/morluto/rea/issues/13470)) ([99c42dd](https://github.com/morluto/rea/commit/99c42ddc46bb725626bee9e579f936df00d0344d))
* **wasm:** stream digest-only inspection reads ([#13440](https://github.com/morluto/rea/issues/13440)) ([093af33](https://github.com/morluto/rea/commit/093af33e5c1d7e3812d7ee80d4fa629445be3c47))
* **web:** normalize each browser redaction marker once ([#13172](https://github.com/morluto/rea/issues/13172)) ([6818b01](https://github.com/morluto/rea/commit/6818b01d5aacfdcc119054fec8d985d7b9ccfb5f))
* **web:** stop repeated accessibility reads after method refusal ([#13191](https://github.com/morluto/rea/issues/13191)) ([3130adb](https://github.com/morluto/rea/commit/3130adbb1bcc69d08eca38337d0baf1391a66961))
* **windows/artifacts:** add lightweight NTFS MFT attribute accounting and pass cached digest in ReleaseExposureReader ([#13623](https://github.com/morluto/rea/issues/13623)) ([7c13e1c](https://github.com/morluto/rea/commit/7c13e1cb34fc1be3413d94217d4737e0848d63cf))
* **workers/browser/cli:** buffer JSON writes, wake on signal, optimize queues ([#13698](https://github.com/morluto/rea/issues/13698)) ([cf97961](https://github.com/morluto/rea/commit/cf979613a3ff4586be7fe819545cba02e1b24311))


### Code Refactoring

* **adb:** extract AdbFileStaging module from AdbProvider ([#13705](https://github.com/morluto/rea/issues/13705)) ([5a163e8](https://github.com/morluto/rea/commit/5a163e8e7511a65ce5f804d64d30761d4fe78075))
* **adb:** extract package and app lifecycle operations from AdbProvider ([#13988](https://github.com/morluto/rea/issues/13988)) ([ada3ea6](https://github.com/morluto/rea/commit/ada3ea6305d35bcdb04c506bbc2af611203094f0))
* **adb:** extract read-only shell inspection operations from AdbProvider ([#13975](https://github.com/morluto/rea/issues/13975)) ([25e7a85](https://github.com/morluto/rea/commit/25e7a85687b8f875fcfc88d57762f58132043602))
* **analysis-view:** reuse field selection for retained rows ([#14816](https://github.com/morluto/rea/issues/14816)) ([55e518c](https://github.com/morluto/rea/commit/55e518c394b1f8aa4ca651fd0f15c6cd786a4ed6))
* **analysis-view:** unify 4 retained-summary wrappers into executeRetainedSummaryOperation ([#13810](https://github.com/morluto/rea/issues/13810)) ([55c4f56](https://github.com/morluto/rea/commit/55c4f5633c47411a0b2a2ed85c550d3d1af1adda))
* **android:** share boot image parser layout types ([#14695](https://github.com/morluto/rea/issues/14695)) ([dde8a9d](https://github.com/morluto/rea/commit/dde8a9db05747c1cb88cd5a8a0ea9d4045111175))
* **apk:** remove the unused buffered v1 entry reader ([#14506](https://github.com/morluto/rea/issues/14506)) ([3983d2f](https://github.com/morluto/rea/commit/3983d2f517a6da56f0070db135086c273417c4ae))
* **apple:** read dispatch relative displacements through the shared readers ([0ae58b4](https://github.com/morluto/rea/commit/0ae58b4a1fe1778f49def9920a214498a2ce084d)), refs [#11865](https://github.com/morluto/rea/issues/11865)
* **apple:** share chained import decoding and proofs ([#13788](https://github.com/morluto/rea/issues/13788)) ([e012b68](https://github.com/morluto/rea/commit/e012b68371e52210785adec3c8f50e613cb4c685))
* **apple:** share NIB archive marker readers ([#14474](https://github.com/morluto/rea/issues/14474)) ([c76180a](https://github.com/morluto/rea/commit/c76180a442cbd664da0e63d0477622495c97d4c3))
* **apple:** share readFatSliceHeaders between resolver and inventory ([#13692](https://github.com/morluto/rea/issues/13692)) ([12658e2](https://github.com/morluto/rea/commit/12658e23e7803f605d9b3166bd7d719cecb0ad52))
* **application:** add executeArtifactInspection runner and migrate 6 services ([#13819](https://github.com/morluto/rea/issues/13819)) ([8df9860](https://github.com/morluto/rea/commit/8df98603d11e01f3c1541076690b5a0186eaf408))
* **application:** consolidate configuration and observation helpers ([#14322](https://github.com/morluto/rea/issues/14322)) ([2f5f02f](https://github.com/morluto/rea/commit/2f5f02f444ca0449427914538811c13ec0be291b))
* **application:** extract BinaryTargetExecutableProbes from BinaryTargetResolver ([#13826](https://github.com/morluto/rea/issues/13826)) ([686bb09](https://github.com/morluto/rea/commit/686bb097f8045860f5e03b8c89d26ec2d0b976d1))
* **application:** migrate 10 binary diagnostics services onto executeArtifactInspection ([#13849](https://github.com/morluto/rea/issues/13849)) ([d8f34c5](https://github.com/morluto/rea/commit/d8f34c530d65b086baaf18910c8f66f4dd5bd52c)), refs [#13848](https://github.com/morluto/rea/issues/13848)
* **application:** migrate 3 remaining artifact services onto executeArtifactInspection ([#13867](https://github.com/morluto/rea/issues/13867)) ([a023edf](https://github.com/morluto/rea/commit/a023edf890d32524a312435f0e74b6301b10659a))
* **application:** migrate 7 standalone format services onto executeArtifactInspection ([#13861](https://github.com/morluto/rea/issues/13861)) ([97a9510](https://github.com/morluto/rea/commit/97a95103d4c771b696a5fdc88c641e79a4c8695c)), refs [#13860](https://github.com/morluto/rea/issues/13860)
* **application:** move AnalysisViewRetention to a light module and defer view loading in services ([#14102](https://github.com/morluto/rea/issues/14102)) ([26d0bc7](https://github.com/morluto/rea/commit/26d0bc7737d6fa768c50a4de351ca4a8bd4ac97a))
* **application:** unify 5 pass-through analysis services into ProviderOperationService ([#13856](https://github.com/morluto/rea/issues/13856)) ([2cf600f](https://github.com/morluto/rea/commit/2cf600fc7f36abbca858493c6eac7da4fda27368)), refs [#13855](https://github.com/morluto/rea/issues/13855)
* **artifacts:** consolidate magic checks and range reads ([#13643](https://github.com/morluto/rea/issues/13643)) ([94e0386](https://github.com/morluto/rea/commit/94e038678e66b8ed6d0e593404bde8c3b5eac5d7))
* **artifacts:** consolidate magic checks, probe windows, and range reads ([94e0386](https://github.com/morluto/rea/commit/94e038678e66b8ed6d0e593404bde8c3b5eac5d7))
* **artifacts:** extract bounded member I/O helpers from ReleaseExposureReader ([#13990](https://github.com/morluto/rea/issues/13990)) ([2915278](https://github.com/morluto/rea/commit/2915278d503f99f156898811126c346f6e58ca99))
* **artifacts:** extract memberClassification from ReleaseExposureReader ([#13673](https://github.com/morluto/rea/issues/13673)) ([dc1380d](https://github.com/morluto/rea/commit/dc1380d9d223bd2e766d6e3f391f4c4541af7f76))
* **artifacts:** extract nodeShebang and memberTextDecoding from ReleaseExposureReader ([eb13f0c](https://github.com/morluto/rea/commit/eb13f0cb0c85adb594b390976ac1c1fbf70748dc))
* **artifacts:** extract releaseExposureFailures from ReleaseExposureReader ([#13739](https://github.com/morluto/rea/issues/13739)) ([c4be5b7](https://github.com/morluto/rea/commit/c4be5b70657b6feff3043c8c688ea469b4c3a01e))
* **artifacts:** extract shebang and text decoding from ReleaseExposureReader ([#13665](https://github.com/morluto/rea/issues/13665)) ([eb13f0c](https://github.com/morluto/rea/commit/eb13f0cb0c85adb594b390976ac1c1fbf70748dc))
* **artifacts:** extract source-map detection and occurrence path helpers from ReleaseExposureReader ([#13961](https://github.com/morluto/rea/issues/13961)) ([26c281e](https://github.com/morluto/rea/commit/26c281e8fc6fbe5a0a37f5d2df855a5ba21ce105))
* **artifacts:** migrate Bun and Deno readers to PositionalArtifactReader ([#13702](https://github.com/morluto/rea/issues/13702)) ([ee3d062](https://github.com/morluto/rea/commit/ee3d0620f0f0fbcff54c09ca47aa9e39b01a049a))
* **artifacts:** migrate NtfsMft, Fit, and UImage onto PositionalArtifactReader ([af2dba0](https://github.com/morluto/rea/commit/af2dba0859f8b3f1c88b6b150c9d66139092c87c))
* **artifacts:** migrate NtfsMft, Fit, UImage onto PositionalArtifactReader ([#13650](https://github.com/morluto/rea/issues/13650)) ([af2dba0](https://github.com/morluto/rea/commit/af2dba0859f8b3f1c88b6b150c9d66139092c87c))
* **artifacts:** preserve bounded partial inspection for trailing boot/OTA metadata and deduplicate UEFI/iNES probes ([#14358](https://github.com/morluto/rea/issues/14358)) ([2b9db68](https://github.com/morluto/rea/commit/2b9db683aa53d5a754b7b5146dcbca5a269a92f9))
* **artifacts:** reuse carrier ranges and Mach-O field decoding ([#14574](https://github.com/morluto/rea/issues/14574)) ([0f81637](https://github.com/morluto/rea/commit/0f81637e08db57dfaf8ad551ee782b0e2994bc13))
* **artifacts:** reuse the positional reader for iNES prefixes ([#13481](https://github.com/morluto/rea/issues/13481)) ([b6ffec4](https://github.com/morluto/rea/commit/b6ffec43adeec2d7b57ef49b894425e8b0d36d0a))
* **artifacts:** share cached prefix reader and ELF/MZ magic ([#13663](https://github.com/morluto/rea/issues/13663)) ([baed75f](https://github.com/morluto/rea/commit/baed75fc2b3a723144d46fdfb206b50bd03c6698))
* **artifacts:** share member stream capacity and shutdown ([#14442](https://github.com/morluto/rea/issues/14442)) ([6eeae97](https://github.com/morluto/rea/commit/6eeae97eb3ebe16ea48c4537542d972620218c65))
* **artifacts:** share positional region entries ([#14947](https://github.com/morluto/rea/issues/14947)) ([f0c31de](https://github.com/morluto/rea/commit/f0c31de19d3b0c6582ff318ed8c6778a1dd2c78d))
* **asar:** remove obsolete empty-member handle cleanup ([#14446](https://github.com/morluto/rea/issues/14446)) ([087b623](https://github.com/morluto/rea/commit/087b6237be540bf925795fd2222b5d217f1e6f7f))
* **binary:** remove the unused mapped string scan ([#14448](https://github.com/morluto/rea/issues/14448)) ([05058c2](https://github.com/morluto/rea/commit/05058c2d8f7ffb9f6ef460d1dd78f5258267fba1))
* **binary:** share byte-view reader caches ([#14440](https://github.com/morluto/rea/issues/14440)) ([654320a](https://github.com/morluto/rea/commit/654320a8af3bae76901e7dc824ff4c26fdcecc7a))
* **binary:** share prefix-aware byte slice reads ([#14377](https://github.com/morluto/rea/issues/14377)) ([6582830](https://github.com/morluto/rea/commit/658283000a0e5973650261ed45e9c3f0a32d8e22))
* **build:** share skill file enumeration across generators ([#14339](https://github.com/morluto/rea/issues/14339)) ([73f72c9](https://github.com/morluto/rea/commit/73f72c9cd69ad5a669dd4fc705d4b45af4297f11))
* centralize owned finalization and configuration failures ([#14071](https://github.com/morluto/rea/issues/14071)) ([4bbaf17](https://github.com/morluto/rea/commit/4bbaf175121f101b319cd8aa0b4d47d3f40d5862))
* **ci:** share completeness guard grouping transitions ([#14637](https://github.com/morluto/rea/issues/14637)) ([0f358c2](https://github.com/morluto/rea/commit/0f358c2c97cfa80db35d563fdb53c1f270982771))
* **ci:** share repository identifier validation ([#14678](https://github.com/morluto/rea/issues/14678)) ([9ca9654](https://github.com/morluto/rea/commit/9ca96545000614067c158ad32e39be5cf9fa0509))
* **cli/server:** break remaining module-layer cycles ([#14013](https://github.com/morluto/rea/issues/14013)) ([b565f78](https://github.com/morluto/rea/commit/b565f787cb4642a277f85d1a299acb8c49d7b409))
* **cli:** derive command names from their declaring contracts ([#14325](https://github.com/morluto/rea/issues/14325)) ([a27751b](https://github.com/morluto/rea/commit/a27751b41d9cfa0e1a2fa52c0eef9646447fa1ad))
* **cli:** extract contractCliDescriptionTypes from contractCliDescription ([#13729](https://github.com/morluto/rea/issues/13729)) ([f3ff526](https://github.com/morluto/rea/commit/f3ff526f28f3da36b5236e89d4350f5f2e7a7d9b))
* **cli:** extract contractCliSchemaProjection and contractCliDocumentDescription ([#13871](https://github.com/morluto/rea/issues/13871)) ([35d72ad](https://github.com/morluto/rea/commit/35d72ad77f287313bcc5c89fe2ec278d48e8928a))
* **cli:** extract contractCommandRunners from contractCommand ([#13869](https://github.com/morluto/rea/issues/13869)) ([39ddf00](https://github.com/morluto/rea/commit/39ddf00236d0eecb452647a654db623a4f057c83))
* **cli:** extract contractDocumentCommand from contractCommand ([#13782](https://github.com/morluto/rea/issues/13782)) ([3c5c652](https://github.com/morluto/rea/commit/3c5c6522b5d24aefd5fa3ba67c64adc2c18c2e63))
* **cli:** extract routedContractCommand from contractCommand ([#13837](https://github.com/morluto/rea/issues/13837)) ([4707f45](https://github.com/morluto/rea/commit/4707f45ac240313e928c0ac304edcb33885c0ff2)), refs [#13836](https://github.com/morluto/rea/issues/13836)
* **cli:** share cleanup for retained resource scopes ([#14811](https://github.com/morluto/rea/issues/14811)) ([5fc98e7](https://github.com/morluto/rea/commit/5fc98e7e1853ec121d8db37cef306f6f3ec8ffd3))
* **cli:** share CLI-only option projection ([#14528](https://github.com/morluto/rea/issues/14528)) ([7b0e633](https://github.com/morluto/rea/commit/7b0e633bc430860f52444b5f41404639ab30daed))
* **cli:** share common command registrar calls ([#14493](https://github.com/morluto/rea/issues/14493)) ([9b86dc2](https://github.com/morluto/rea/commit/9b86dc2fa8e0b53244a51df867b896f19e06c86f))
* **cli:** share compiled runtime checks with the session worker ([#14557](https://github.com/morluto/rea/issues/14557)) ([0bbdbea](https://github.com/morluto/rea/commit/0bbdbeaedf3d73bd9dba2d2e4801c68725e3aa1e))
* **cli:** share token window presentation and output capture ([#14382](https://github.com/morluto/rea/issues/14382)) ([b016a09](https://github.com/morluto/rea/commit/b016a09bfd80f7a7b74c9ce0ebf3029313a3acb9))
* **composition:** prune binaryDiagnostics re-export barrel and migrate callers ([#13839](https://github.com/morluto/rea/issues/13839)) ([3843fb2](https://github.com/morluto/rea/commit/3843fb2dd0377a200f984ce8ea444eb1fa69ec51)), refs [#13838](https://github.com/morluto/rea/issues/13838)
* **config:** extract ClientConfigurationToml from ClientConfigurationDocument ([#13724](https://github.com/morluto/rea/issues/13724)) ([b42f7c2](https://github.com/morluto/rea/commit/b42f7c24afd5b19c19312c8e893ac3ef62f3cc93))
* **config:** return Result for ConfigurationError in IdaConfiguration and KiloClientLocation ([#14053](https://github.com/morluto/rea/issues/14053)) ([15790f7](https://github.com/morluto/rea/commit/15790f786fe73d2e720c9fa9776af9cbf75a3d5e))
* **config:** return Result from resolveKiloRegistrationWorktree ([#14055](https://github.com/morluto/rea/issues/14055)) ([b2ae356](https://github.com/morluto/rea/commit/b2ae356f646350d2a1e469a806d4ebffe7df160c))
* **config:** share defaulted numeric setting parsers ([#14437](https://github.com/morluto/rea/issues/14437)) ([69a5601](https://github.com/morluto/rea/commit/69a56016f3aa58820e7a0f7f825b8f493859300a))
* **config:** share optional launch setting validation ([#14310](https://github.com/morluto/rea/issues/14310)) ([ba9b10f](https://github.com/morluto/rea/commit/ba9b10f04864549a88f11d13cc43bbaaaca4f721))
* **config:** unify decimal-integer env schemas onto positiveDecimalIntegerSchema ([#14587](https://github.com/morluto/rea/issues/14587)) ([289c5b1](https://github.com/morluto/rea/commit/289c5b13d937f4048d546fe98306e76cf48550a2))
* **desktop:** project captured drafts through the guest schema ([#14338](https://github.com/morluto/rea/issues/14338)) ([57ae5dc](https://github.com/morluto/rea/commit/57ae5dcbc4f9ed131e536e6fd5655bcd90165be6))
* **desktop:** read OpenPGP packet lengths through BinaryReader ([006581b](https://github.com/morluto/rea/commit/006581b838fe64cd2a1b5b22d508c525e92bdf2d)), refs [#11865](https://github.com/morluto/rea/issues/11865)
* **desktop:** share XML parent pointers in task drafts ([#14905](https://github.com/morluto/rea/issues/14905)) ([670e705](https://github.com/morluto/rea/commit/670e70587a51ffd74f2d1f142f8774cbdfed4073))
* **desktop:** validate task pointer syntax at its shared owner ([7b856fa](https://github.com/morluto/rea/commit/7b856fa5a14d4a361d445c1efd4b1f9037994259))
* **discovery:** share regular-file and execute-permission checks ([#14749](https://github.com/morluto/rea/issues/14749)) ([a21beb4](https://github.com/morluto/rea/commit/a21beb4a0b6dc53f1887ae1b63f8f31acb45646a))
* **doctor:** share client registration checks ([#14529](https://github.com/morluto/rea/issues/14529)) ([ff2f1c2](https://github.com/morluto/rea/commit/ff2f1c2f72a5cbe696086d64a28d450dcd7dc4b5))
* **domain/pe:** unify Asn1BerFailure and PeBinaryFailure ([#13652](https://github.com/morluto/rea/issues/13652)) ([867dacc](https://github.com/morluto/rea/commit/867dacc94688e20a7ab9957c63cd529b5b9729d0))
* **domain/pe:** unify Asn1BerFailure and PeBinaryFailure onto shared owners ([867dacc](https://github.com/morluto/rea/commit/867dacc94688e20a7ab9957c63cd529b5b9729d0))
* **domain:** add CoverageAccumulator and ratchet ad-hoc completeness ternaries ([#14589](https://github.com/morluto/rea/issues/14589)) ([fdbfd85](https://github.com/morluto/rea/commit/fdbfd85c23613fbb3450932c389bf7380036e87c))
* **domain:** compose cleanup dependencies through analysisErrorCleanup helpers ([#14064](https://github.com/morluto/rea/issues/14064)) ([65ee0e8](https://github.com/morluto/rea/commit/65ee0e80abc12b582a8d3158878bf444e2397e8a))
* **domain:** one ByteSource representation for streaming parsers ([#14044](https://github.com/morluto/rea/issues/14044)) ([a324181](https://github.com/morluto/rea/commit/a324181cccd428618f1bb839121789720fb1395d))
* **domain:** replace production prose/regex limitation matching with typed discriminators ([#14359](https://github.com/morluto/rea/issues/14359)) ([72bdcad](https://github.com/morluto/rea/commit/72bdcad49d1e6d89d935d1a493e0434b3f5d5fd7))
* **domain:** reuse ordered map appends in index builders ([#14548](https://github.com/morluto/rea/issues/14548)) ([5cd8658](https://github.com/morluto/rea/commit/5cd86586431698d80facc62259ff04a91310f16a))
* **domain:** share BOM-preserving UTF-8 field decoding ([#14814](https://github.com/morluto/rea/issues/14814)) ([d887bba](https://github.com/morluto/rea/commit/d887bbaf350a0a4fe5ba0424c9b5a3f1dbbeaf0c))
* **domain:** share first duplicate index lookup ([#14560](https://github.com/morluto/rea/issues/14560)) ([59b75ec](https://github.com/morluto/rea/commit/59b75ecc3e2bd1c787985e7bebf128f453d5ec82))
* **domain:** share occurrence counting across collection comparisons ([#14684](https://github.com/morluto/rea/issues/14684)) ([be65e86](https://github.com/morluto/rea/commit/be65e86681add26496134f2b5ebf8d8224e6f300))
* **domain:** share ordered map list appends ([#14538](https://github.com/morluto/rea/issues/14538)) ([092daf7](https://github.com/morluto/rea/commit/092daf7d443e6e6ebc1a38aa3998ceaaa9a35797))
* **domain:** share ordered reconstruction obligation categories ([#14524](https://github.com/morluto/rea/issues/14524)) ([e953b21](https://github.com/morluto/rea/commit/e953b215292567a1f74feeffb63a2f0c3c59ad4f))
* **domain:** share record and graph parsing across input paths ([#14321](https://github.com/morluto/rea/issues/14321)) ([2add88a](https://github.com/morluto/rea/commit/2add88a014e1bb16b53584615ea142067f55f916))
* **domain:** share required canonical JSON serialization ([#14687](https://github.com/morluto/rea/issues/14687)) ([6991413](https://github.com/morluto/rea/commit/6991413d41bf0a273303225a86323201ba303d87))
* **domain:** split artifactFormatMetadata into domain modules ([#13655](https://github.com/morluto/rea/issues/13655)) ([8497f8c](https://github.com/morluto/rea/commit/8497f8c05a0a8184089f958419735329287bb9a0))
* **domain:** split artifactFormatMetadata.ts into domain-grouped schema modules ([8497f8c](https://github.com/morluto/rea/commit/8497f8c05a0a8184089f958419735329287bb9a0))
* **domain:** use known coverage in web bundle reports ([#14643](https://github.com/morluto/rea/issues/14643)) ([5f68d8d](https://github.com/morluto/rea/commit/5f68d8daf63fd00ceeaad6fbee8c22a8aef095a0))
* drop the unused and duplicate exports Knip reports on main ([73a5c59](https://github.com/morluto/rea/commit/73a5c591d1641b8fa4e9bdad788a89b5a66fce7e))
* **dwarf:** prune superseded whole-buffer locateDwarfSections wrapper ([#13993](https://github.com/morluto/rea/issues/13993)) ([27eef47](https://github.com/morluto/rea/commit/27eef4712206affa51850b1254d05d59eefbdd19))
* **elf:** consolidate fixed record decoding proofs ([#13753](https://github.com/morluto/rea/issues/13753)) ([d0b562c](https://github.com/morluto/rea/commit/d0b562c682ace93cc22068b374c4a3bf427a248a))
* **elf:** consolidate kernel module checks on positional reads ([be32625](https://github.com/morluto/rea/commit/be32625b29101fc6b482a38798a6ef22e68f9e94))
* **elf:** decouple structural admission from lane policies and type MIPS limitations ([#14356](https://github.com/morluto/rea/issues/14356)) ([782c274](https://github.com/morluto/rea/commit/782c2742003dec56eed33faefb4f2a10f8cc871d)), refs [#14343](https://github.com/morluto/rea/issues/14343)
* **elf:** prune superseded whole-buffer parseKernelBuildConfig wrapper ([#13996](https://github.com/morluto/rea/issues/13996)) ([0c303ef](https://github.com/morluto/rea/commit/0c303efb0e611f98f34a3ea2d1a176c74cef9dd3))
* **elf:** read GNU property words through BinaryReader ([add4faf](https://github.com/morluto/rea/commit/add4faf2ad7aeb38d6d8c0e8619e238f01e6a5c1)), refs [#11865](https://github.com/morluto/rea/issues/11865)
* **elf:** remove obsolete debug-link buffer parsers ([#13971](https://github.com/morluto/rea/issues/13971)) ([2352fab](https://github.com/morluto/rea/commit/2352fab0f6011bd91d46f8426939cf7619168ca4))
* **elf:** retire obsolete note buffer parsers ([#13995](https://github.com/morluto/rea/issues/13995)) ([a8fa445](https://github.com/morluto/rea/commit/a8fa445c416c4bb3fc67faec1ef289dcda177649))
* **elf:** retire the obsolete unwind buffer parser ([#14007](https://github.com/morluto/rea/issues/14007)) ([5acdeb7](https://github.com/morluto/rea/commit/5acdeb79fb4d5bedbf83d9a63f324cf7599bd0aa))
* **elf:** retire the test-only dependency buffer driver ([0f4c4a7](https://github.com/morluto/rea/commit/0f4c4a7fb4c8d0f9da0ae896f43488d470b69bff))
* **elf:** share magic and declared section range checks ([#14429](https://github.com/morluto/rea/issues/14429)) ([e71f097](https://github.com/morluto/rea/commit/e71f09742c0e1a83f7b912f084709fa17c4b43b8))
* **elf:** share note reader limit error projection ([#14644](https://github.com/morluto/rea/issues/14644)) ([9edc95c](https://github.com/morluto/rea/commit/9edc95c512579dba488dcf98e71a38cd7fa05d7d))
* **elf:** share the asynchronous build-id note reader ([#14509](https://github.com/morluto/rea/issues/14509)) ([5330585](https://github.com/morluto/rea/commit/53305850d7d5d205c40b46e8950aedc57c69f854))
* **environment:** derive recorded paging names from their roles ([#14522](https://github.com/morluto/rea/issues/14522)) ([c080945](https://github.com/morluto/rea/commit/c080945a9976cf4b81081c382d0d27308fd03b52))
* **environment:** derive the package source in the bundle plan ([#14485](https://github.com/morluto/rea/issues/14485)) ([f9ee091](https://github.com/morluto/rea/commit/f9ee091df2b05486714899067b7b620f0df32785))
* **environment:** retain the latest replay interference event ([#13408](https://github.com/morluto/rea/issues/13408)) ([b96e2e1](https://github.com/morluto/rea/commit/b96e2e10e751f1026a6a828503b3709e6795897f))
* **environment:** scan replay observations without copying the timeline ([#13409](https://github.com/morluto/rea/issues/13409)) ([54121e2](https://github.com/morluto/rea/commit/54121e2f2a3d461fdf30ba1b5ee31fd3a35656b0))
* **environment:** share response status checks and write plan fixtures ([#14336](https://github.com/morluto/rea/issues/14336)) ([e170334](https://github.com/morluto/rea/commit/e17033450eac90ffc8e791ae4e52beea66d84357))
* **errors:** list distinct resources in providerCleanupErrorFromFailures ([13725d2](https://github.com/morluto/rea/commit/13725d2986dda6bb8b9a3ae449408da67da5c360)), refs [#11859](https://github.com/morluto/rea/issues/11859)
* **errors:** share structural system code extraction ([#14489](https://github.com/morluto/rea/issues/14489)) ([ed89f5b](https://github.com/morluto/rea/commit/ed89f5b4b553c9bd6896530d89a1559d9332c8c5))
* **evidence:** share observed file report construction ([#14320](https://github.com/morluto/rea/issues/14320)) ([52b73c0](https://github.com/morluto/rea/commit/52b73c0cc6f21e14ec54db92837b268b209042d1))
* **evidence:** share PE inspection provenance ([#14428](https://github.com/morluto/rea/issues/14428)) ([08cfbf8](https://github.com/morluto/rea/commit/08cfbf88cb596ecdf38ec029758bbfd50ccaf89c))
* **filesystem/artifacts:** share createCachedPrefixReader and ELF/MZ magic helpers ([baed75f](https://github.com/morluto/rea/commit/baed75fc2b3a723144d46fdfb206b50bd03c6698))
* **filesystem:** share nanosecond file stat comparisons ([#14614](https://github.com/morluto/rea/issues/14614)) ([5533f50](https://github.com/morluto/rea/commit/5533f50bade776096f0830700d7478f038182e45))
* **firmware:** use one cooperative OTA reconstruction path ([#13375](https://github.com/morluto/rea/issues/13375)) ([1f2805e](https://github.com/morluto/rea/commit/1f2805e6c859760205f8cab9309f7ee31944d9b3))
* **frida:** extract FridaMessageCapture from FridaInstrumentationManager ([#13787](https://github.com/morluto/rea/issues/13787)) ([76d04df](https://github.com/morluto/rea/commit/76d04df49a7bce160e7a9f802254f5f74073610e))
* **frida:** make inspectStatus async and load the view service lazily ([#14108](https://github.com/morluto/rea/issues/14108)) ([fae1cc2](https://github.com/morluto/rea/commit/fae1cc260d61733c88de9c6da7dc91c2ad825583))
* **gdb:** extract inferior verification and command classification ([#13801](https://github.com/morluto/rea/issues/13801)) ([d6eb439](https://github.com/morluto/rea/commit/d6eb439de864f9a876f6022bf8003c9db2d3d030))
* **gdb:** name the MI stream record rule in the command observation owner ([4c8d57f](https://github.com/morluto/rea/commit/4c8d57f6b8adcee5c89dc0b2bf369c1fa638b2ed))
* **ghidra:** extract GhidraSessionErrorProjection from GhidraProviderClient ([#13722](https://github.com/morluto/rea/issues/13722)) ([7af2896](https://github.com/morluto/rea/commit/7af28969ed36d1875a08b9800ff304dac6484d6a))
* **ghidra:** require an owned committed project copy ([#13363](https://github.com/morluto/rea/issues/13363)) ([fb6e0dc](https://github.com/morluto/rea/commit/fb6e0dc6e8558fea2931cdfb7280854c0cfbca6c))
* **ghidra:** reuse the verifier file digest for fixture checks ([#14554](https://github.com/morluto/rea/issues/14554)) ([5bf09b6](https://github.com/morluto/rea/commit/5bf09b6dff068e67c4b1d7818f4e538005b07935))
* **ghidra:** reuse the verifier MCP call binding ([#14590](https://github.com/morluto/rea/issues/14590)) ([4158949](https://github.com/morluto/rea/commit/41589492e0bc8f5cce77223471e5e3ebe2aeae52))
* **ghidra:** share the executable file probe ([#14573](https://github.com/morluto/rea/issues/14573)) ([e22bc84](https://github.com/morluto/rea/commit/e22bc848947cd2139eaef235ac14e76004d0297d))
* **go:** consolidate native parser checks on positional reads ([#14027](https://github.com/morluto/rea/issues/14027)) ([68cc2b9](https://github.com/morluto/rea/commit/68cc2b9bb07cf118cad6cb59ec75d31406ab8dc1))
* **hopper:** compose bridge image cleanup through the shared owner ([3ba20f0](https://github.com/morluto/rea/commit/3ba20f0eb8387c2eede14249a32c86ba15fef294)), refs [#11859](https://github.com/morluto/rea/issues/11859)
* **indexes:** share ordered map bucket appends ([8da1e56](https://github.com/morluto/rea/commit/8da1e562775eced153123b32cdace52c8030ef19))
* **inspector:** compose provider close failures through the shared owner ([a5f3689](https://github.com/morluto/rea/commit/a5f36891793f2a901326f7443d177ff9e277065d)), refs [#11859](https://github.com/morluto/rea/issues/11859)
* **inspector:** own the Node discovery path rule in one module ([#10680](https://github.com/morluto/rea/issues/10680)) ([559956c](https://github.com/morluto/rea/commit/559956cf6b5db2677aa4f8b4f34ee67b8038f4d8))
* **investigation:** build comparison unknowns in their owning function ([#14335](https://github.com/morluto/rea/issues/14335)) ([c2c4298](https://github.com/morluto/rea/commit/c2c4298f3ca4a2a02028cc1d11cfc9316491e14f))
* **javascript:** share exact string literal reads ([#14612](https://github.com/morluto/rea/issues/14612)) ([b33c57d](https://github.com/morluto/rea/commit/b33c57de0e31bf8f829e0d47f4a790db6c8c2a74))
* **javascript:** share one-sided version comparison results ([#14539](https://github.com/morluto/rea/issues/14539)) ([2ace7a8](https://github.com/morluto/rea/commit/2ace7a8d38a8de60d2854d2f841771bef0c2fdff))
* **javascript:** share statement position caching ([#14561](https://github.com/morluto/rea/issues/14561)) ([ca70be0](https://github.com/morluto/rea/commit/ca70be0feb227c2f311f26c1e6c80d0b87f5e06c))
* **javascript:** share the artifact reconstruction cancellation check ([#14732](https://github.com/morluto/rea/issues/14732)) ([e42341d](https://github.com/morluto/rea/commit/e42341d84b2c6ac75e72642b7193779a7961ad18))
* **javascript:** share unresolved bundler node construction ([#14441](https://github.com/morluto/rea/issues/14441)) ([17a1d03](https://github.com/morluto/rea/commit/17a1d033fe458c0e8884c773d7a784bea3186cc5))
* **kuna:** extract KunaCacheManifest from KunaProjectCache ([#13770](https://github.com/morluto/rea/issues/13770)) ([66d819f](https://github.com/morluto/rea/commit/66d819f36958850f8e443e0b4c8465252d81732f))
* **kuna:** extract KunaInventoryIndex from KunaSessionClient ([#13821](https://github.com/morluto/rea/issues/13821)) ([a022067](https://github.com/morluto/rea/commit/a02206755e8733f0bda5918707c60100bd0beeaa))
* **kuna:** extract KunaSessionEvidence from KunaSessionClient ([#13879](https://github.com/morluto/rea/issues/13879)) ([12c50f1](https://github.com/morluto/rea/commit/12c50f1309b7ab75a5c70075a7c5078ac888e5af))
* **kuna:** extract KunaSingleFunctionCache from KunaSessionClient ([#13863](https://github.com/morluto/rea/issues/13863)) ([135c136](https://github.com/morluto/rea/commit/135c136701c54a830264ac1a24aa2e37185faa3d)), refs [#13862](https://github.com/morluto/rea/issues/13862)
* **limits:** derive help from resolved per-call defaults ([#14642](https://github.com/morluto/rea/issues/14642)) ([0e7db4c](https://github.com/morluto/rea/commit/0e7db4c0527ad5fc4a8b75fc03389129df52ef1c))
* **limits:** share typed budget projections ([#14673](https://github.com/morluto/rea/issues/14673)) ([d112acc](https://github.com/morluto/rea/commit/d112acc2c65c45440cd6e7803f832d0151a01dc0))
* **lint:** share counted findings reporting ([#14558](https://github.com/morluto/rea/issues/14558)) ([2f5dc7b](https://github.com/morluto/rea/commit/2f5dc7b27c08a06843a65a4ce7c4c525e8442c51))
* **macho:** read LC_BUILD_VERSION fields through BinaryReader ([a0d2357](https://github.com/morluto/rea/commit/a0d2357230bdce24510436ee405d263fceb47870)), refs [#11865](https://github.com/morluto/rea/issues/11865)
* **macho:** use binary facts for native diagnostic admission ([#13929](https://github.com/morluto/rea/issues/13929)) ([7ce3e5d](https://github.com/morluto/rea/commit/7ce3e5d208fe213882de9427835b993a9a36945c))
* **managed:** read custom-attribute prologs and resource lengths through BinaryReader ([2bd8963](https://github.com/morluto/rea/commit/2bd8963062fa664e7c6fab0410547480778a5ea5)), refs [#11865](https://github.com/morluto/rea/issues/11865)
* **managed:** share method and field graph registration ([#14471](https://github.com/morluto/rea/issues/14471)) ([9ea3af4](https://github.com/morluto/rea/commit/9ea3af4bb8554c8141ae7af2f4fc454a64001d2c))
* **managed:** share unmatched member comparison facts ([#14484](https://github.com/morluto/rea/issues/14484)) ([cca35e9](https://github.com/morluto/rea/commit/cca35e94f74cf3f2210c11b8228fc55312d72ee8))
* **manifest:** share ordered sibling group traversal ([#14571](https://github.com/morluto/rea/issues/14571)) ([0dd8789](https://github.com/morluto/rea/commit/0dd878946a29c7fb0dff0964235e53522600304b))
* **mcp:** share retained evidence link eligibility ([#14639](https://github.com/morluto/rea/issues/14639)) ([d436d42](https://github.com/morluto/rea/commit/d436d42781220c3e86fbfb944e153ef490c6fd81))
* **metadata:** share Maven and NuGet boolean text parsing ([#14694](https://github.com/morluto/rea/issues/14694)) ([74134bf](https://github.com/morluto/rea/commit/74134bf6fd9b050913338a77c5c901f7639b7a4f))
* **mobile:** share application inventory coverage and bridge projection ([#14527](https://github.com/morluto/rea/issues/14527)) ([8337fdf](https://github.com/morluto/rea/commit/8337fdf26ccf7059a7d2fa690ec532c0bd480ece))
* **native:** compose LLDB resolver cleanup through the shared owner ([3af56cc](https://github.com/morluto/rea/commit/3af56cc7d50a5f41ea4753d2d0570082611ee0a4)), refs [#11859](https://github.com/morluto/rea/issues/11859)
* **native:** extract NativeAotPeImage from nativeAotPe ([#13998](https://github.com/morluto/rea/issues/13998)) ([4d5b059](https://github.com/morluto/rea/commit/4d5b059c640aa5b690116bdffefba4085a1c3ebd))
* **native:** extract NativeMacosErrorProjection from NativeMacOSProvider ([#13741](https://github.com/morluto/rea/issues/13741)) ([3306133](https://github.com/morluto/rea/commit/33061332ef3e386a9412841925128160e31bd1a0))
* **native:** isolate FAT Mach-O slice framing and consolidate Mach-O/PE/MZ gates ([#14366](https://github.com/morluto/rea/issues/14366)) ([b6e0616](https://github.com/morluto/rea/commit/b6e06169cd55d34dc33faa677e5e2943c295f00e))
* **native:** share sorted address boundary search ([#14472](https://github.com/morluto/rea/issues/14472)) ([97ed871](https://github.com/morluto/rea/commit/97ed8719d6272741ed894121361b01bcca446487))
* **native:** stop scanning after a second dyld diagnostic ([#14598](https://github.com/morluto/rea/issues/14598)) ([3890d9d](https://github.com/morluto/rea/commit/3890d9d2535259c019aa46e9f48a4797c185a98a))
* **nuget,apk:** adopt ByteSource and drop the NuGet in-memory parse branch ([5b79ae5](https://github.com/morluto/rea/commit/5b79ae5d62be355c5f955fe43c42a8e15b891a64))
* **nuget,apk:** adopt ByteSource and drop the NuGet in-memory parse branch ([299c592](https://github.com/morluto/rea/commit/299c592b636de2080f6ce123e5fbc58effce45f2))
* **nuget,apk:** adopt ByteSource and drop the NuGet in-memory parse branch ([05b683b](https://github.com/morluto/rea/commit/05b683b72e8579ab4cf1cbb7181179d27b110965))
* **nuget,apk:** adopt ByteSource and drop the NuGet in-memory parse branch ([a324181](https://github.com/morluto/rea/commit/a324181cccd428618f1bb839121789720fb1395d))
* **nuget:** select declared manifest occurrences in one pass ([#13402](https://github.com/morluto/rea/issues/13402)) ([4bb5c87](https://github.com/morluto/rea/commit/4bb5c87d2b1a06abcdf26ccf68dfd2551aebd9bd))
* **packages:** share bounded ZIP member reads ([#14849](https://github.com/morluto/rea/issues/14849)) ([52c0009](https://github.com/morluto/rea/commit/52c0009f93c949268a4170eff7129c172f733c82))
* **packages:** share ZIP failure translation ([#14943](https://github.com/morluto/rea/issues/14943)) ([c4bc2f7](https://github.com/morluto/rea/commit/c4bc2f7fcb73882f638b9d9a31fd49156bd902f6))
* **parsers:** share typed failure handling for Android and ISO images ([#14719](https://github.com/morluto/rea/issues/14719)) ([1f262f5](https://github.com/morluto/rea/commit/1f262f5d1356c3ce94fb0e9c99302fdb60d3349c))
* **pcap:** remove the unused one-pass TShark parser ([#14444](https://github.com/morluto/rea/issues/14444)) ([a337d66](https://github.com/morluto/rea/commit/a337d6684193739bb9ffee00ff6f21f56844915d))
* **pe:** decode certificate BMP and UTF-32 strings through BinaryReader ([6543a3c](https://github.com/morluto/rea/commit/6543a3c1a182aeeb797c3e9e27a3ec887e71d00f)), refs [#11865](https://github.com/morluto/rea/issues/11865)
* **pe:** remove the unused buffered certificate reader ([#14507](https://github.com/morluto/rea/issues/14507)) ([cb44dbb](https://github.com/morluto/rea/commit/cb44dbb8217ad24e567230f023aff6c4d91c0059))
* **pe:** remove the unused buffered resource report reader ([#14491](https://github.com/morluto/rea/issues/14491)) ([077c02f](https://github.com/morluto/rea/commit/077c02fac50ba7baaa38ef17c13aa018c82a226e))
* **pe:** remove the unused whole-buffer import reader ([#14445](https://github.com/morluto/rea/issues/14445)) ([f440adb](https://github.com/morluto/rea/commit/f440adba10b256f558437df6f98b695feb010375))
* **pe:** remove unused buffered load config parsing ([#14467](https://github.com/morluto/rea/issues/14467)) ([28d3d7c](https://github.com/morluto/rea/commit/28d3d7c5bc8ffd24b7a56796a9e42dcebe254711))
* **pe:** share retained-prefix range reads ([#14583](https://github.com/morluto/rea/issues/14583)) ([de75a6f](https://github.com/morluto/rea/commit/de75a6f564cc60d580a9150cd497a15baacb1534))
* **ports:** unify 4 misplaced request ports into RequestAnalysisPort and deduplicate PcapAnalysisService ([#13816](https://github.com/morluto/rea/issues/13816)) ([6848409](https://github.com/morluto/rea/commit/68484098795e06c82d538a268f07e4c7e8478857))
* **process:** compose analysis runtime cleanup through the shared owner ([2d36025](https://github.com/morluto/rea/commit/2d360253ddf8c2ab2c0c4a6a3186a8e981a8e090)), refs [#11859](https://github.com/morluto/rea/issues/11859)
* **process:** name the vanished procfs entry check ([7f45dec](https://github.com/morluto/rea/commit/7f45deca388928ffa6cd73c9491333f6c2f27f2b))
* **process:** share the abortable command-turn wait between GDB and Rizin ([#14042](https://github.com/morluto/rea/issues/14042)) ([ac774bc](https://github.com/morluto/rea/commit/ac774bcd70d117b00f40cfb2e36cf93ef8c4ab6a))
* **providers:** adopt offlineArtifactFailureDialect in BEAM, V8, NuGet, and LNK providers ([#13936](https://github.com/morluto/rea/issues/13936)) ([3bced62](https://github.com/morluto/rea/commit/3bced62366b02160e3651b8f5773be1dfb7f2b07))
* **providers:** adopt offlineArtifactFailureDialect in BinaryHardeningProvider and PeBinaryFailure ([#13970](https://github.com/morluto/rea/issues/13970)) ([aaf5acd](https://github.com/morluto/rea/commit/aaf5acd015a58e3a58f774c79e2dfa91d6937f02))
* **providers:** adopt offlineArtifactFailureDialect in DwarfUnitsProvider ([#13977](https://github.com/morluto/rea/issues/13977)) ([1d6ab40](https://github.com/morluto/rea/commit/1d6ab40c5c7e9d14bcc1ff3606d89619f13ae2ba))
* **providers:** adopt offlineArtifactFailureDialect in KernelBuildConfigProvider ([#13973](https://github.com/morluto/rea/issues/13973)) ([15f3855](https://github.com/morluto/rea/commit/15f3855a4092ae5ccae0e2ad7fdd9ad6367c95ef))
* **providers:** adopt offlineArtifactFailureDialect in NativeExportsProvider ([#13982](https://github.com/morluto/rea/issues/13982)) ([352c9ce](https://github.com/morluto/rea/commit/352c9cea1ae947ee4feeddab90ed1c5fa9e4feb5))
* **providers:** adopt offlineArtifactFailureDialect in NativeInitializers, Go, Rust, and ElfUnwind providers ([#13966](https://github.com/morluto/rea/issues/13966)) ([8e5b041](https://github.com/morluto/rea/commit/8e5b041cb4e13d8641073494c0461ad7ee603a60))
* **providers:** adopt offlineArtifactFailureDialect in PE, ELF, and Apple IPS providers ([#13954](https://github.com/morluto/rea/issues/13954)) ([fc23eb6](https://github.com/morluto/rea/commit/fc23eb65aaf65532e3a4f6377a92b7e1765f4f6e))
* **providers:** pass stable file handles directly to parsers ([#14508](https://github.com/morluto/rea/issues/14508)) ([3124e6b](https://github.com/morluto/rea/commit/3124e6b7e2cb99f45dd88035eb2da84df5092940))
* **providers:** share offlineArtifactFailureDialect across offline providers ([#13921](https://github.com/morluto/rea/issues/13921)) ([68803f0](https://github.com/morluto/rea/commit/68803f0082055a51a283351d77cff4001a2813f1))
* **providers:** share queued close attempts ([#14563](https://github.com/morluto/rea/issues/14563)) ([dcce28e](https://github.com/morluto/rea/commit/dcce28e284858286ad4f7eb8719d717362dd1960))
* **providers:** share the offline adapter error fallback ([#14466](https://github.com/morluto/rea/issues/14466)) ([2c847e7](https://github.com/morluto/rea/commit/2c847e767cf9014d1d87a0c2df7876fb3d696136))
* prune 5 redundant single-call wrapper modules ([#13807](https://github.com/morluto/rea/issues/13807)) ([cc5df28](https://github.com/morluto/rea/commit/cc5df28644ad4f0885d12695294afc9a612cf18f))
* **python:** extract PycReportProjection from PythonPycParser ([#13773](https://github.com/morluto/rea/issues/13773)) ([70045e6](https://github.com/morluto/rea/commit/70045e6ffddcdda03564ac8c783cba97a6809d1f))
* **readers:** reuse byte sources for buffered native inspection ([#14504](https://github.com/morluto/rea/issues/14504)) ([290c273](https://github.com/morluto/rea/commit/290c273c7abdb6d28415b6f492b9a840773b20cc))
* **readers:** share exact admitted range checks ([#14544](https://github.com/morluto/rea/issues/14544)) ([e5a883e](https://github.com/morluto/rea/commit/e5a883e0d93ec49f9bd5fdc57182995d118a3933))
* **recordings:** share inspection and catalog Evidence validation ([#14439](https://github.com/morluto/rea/issues/14439)) ([c6a6430](https://github.com/morluto/rea/commit/c6a64307e180863a48a0d2d42c941026e67f0bf6))
* **recordings:** share producer failure classification ([#14470](https://github.com/morluto/rea/issues/14470)) ([8e49a4f](https://github.com/morluto/rea/commit/8e49a4f8b9176b2190aa35117c5642288a439cbd))
* **regex:** consolidate worker input and deadline proofs ([#13732](https://github.com/morluto/rea/issues/13732)) ([588b257](https://github.com/morluto/rea/commit/588b257e486a3cdb3a02c98681da20375434f02d))
* remove internal re-export shims and guard against new ones ([#14009](https://github.com/morluto/rea/issues/14009)) ([88dfad5](https://github.com/morluto/rea/commit/88dfad5bb7eb1dd673143acc0405ed802537592c))
* remove unreferenced type-only imports ([#14604](https://github.com/morluto/rea/issues/14604)) ([3ab3dac](https://github.com/morluto/rea/commit/3ab3dac3c74f8bfcad7d892e9f73b727152e476b))
* remove unused bindings from shared module imports ([#14608](https://github.com/morluto/rea/issues/14608)) ([bfa5077](https://github.com/morluto/rea/commit/bfa50774f5c63ee71475912f2266fea521338280))
* **resources:** share artifact cancellation error projection ([#14572](https://github.com/morluto/rea/issues/14572)) ([c27a046](https://github.com/morluto/rea/commit/c27a0468e3d4e85e914af05a26f89a325f628edd))
* **resources:** share artifact cleanup error composition ([#14457](https://github.com/morluto/rea/issues/14457)) ([79f0f2f](https://github.com/morluto/rea/commit/79f0f2f3fdc866dd3657704b917f27819fdb9421))
* **resources:** share artifact cleanup errors with their leases ([#14606](https://github.com/morluto/rea/issues/14606)) ([b16df9d](https://github.com/morluto/rea/commit/b16df9d6c7d557c6a37335e12bcb4cdcd718eb7c))
* **resources:** share cleanup observation composition ([#14473](https://github.com/morluto/rea/issues/14473)) ([615d742](https://github.com/morluto/rea/commit/615d7423ebc972ad3eabc36c20fc78bfc5a588f0))
* **resources:** share provider descriptor cleanup ([#14425](https://github.com/morluto/rea/issues/14425)) ([adb4679](https://github.com/morluto/rea/commit/adb46794491e2ef3f139ec656ccfaf28955d7edf))
* **resources:** share the retained close-owner adapter ([#14562](https://github.com/morluto/rea/issues/14562)) ([3d9ceea](https://github.com/morluto/rea/commit/3d9ceeae6b671d8bc94d6a4f173e3455f6b419ed))
* **rizin:** extract NUL-frame reader and wait helpers from RizinDebugSessionManager ([#14001](https://github.com/morluto/rea/issues/14001)) ([a1747df](https://github.com/morluto/rea/commit/a1747df7a70b9a51c434d917cad52b5b06183dec))
* **rizin:** extract RizinDebugEvidence from RizinDebugSessionManager ([#13823](https://github.com/morluto/rea/issues/13823)) ([e69c42d](https://github.com/morluto/rea/commit/e69c42deeb2ba74cbfa2287d9c27b1464451cb9d))
* **rust:** consolidate binary parser checks on positional reads ([#14033](https://github.com/morluto/rea/issues/14033)) ([d0a9e6b](https://github.com/morluto/rea/commit/d0a9e6b912395c8ecb6f1f08cc40b76910392006))
* **schemas:** remove the superseded annotation walker ([#14315](https://github.com/morluto/rea/issues/14315)) ([cdacad8](https://github.com/morluto/rea/commit/cdacad84b08989a2ee31f86a9fb087d244b9b322))
* **schemas:** retire the test-only SDK output schema mirror ([#14316](https://github.com/morluto/rea/issues/14316)) ([d845773](https://github.com/morluto/rea/commit/d845773ea5953b4a919754acabe848ae05fb7319))
* **server:** extract browser, Electron, and JavaScript runtime tool bindings ([#13939](https://github.com/morluto/rea/issues/13939)) ([209bee0](https://github.com/morluto/rea/commit/209bee0bf35b69599093837c8e6c0ab2321b925f))
* **server:** extract debugger and instrumentation tool bindings ([#13909](https://github.com/morluto/rea/issues/13909)) ([7f939d7](https://github.com/morluto/rea/commit/7f939d750855de9db3e54b2dea44d3874c5ac61f))
* **server:** extract desktop build tool bindings ([#13891](https://github.com/morluto/rea/issues/13891)) ([841e5f8](https://github.com/morluto/rea/commit/841e5f84876485683643e91bd7bfab275f02cf90))
* **server:** extract ErrorEvidenceTransport from EvidenceMcpServerCore ([#13761](https://github.com/morluto/rea/issues/13761)) ([6738853](https://github.com/morluto/rea/commit/67388539e0bfdf3d495363b82cb49f613dc146ca))
* **server:** extract ForwardingTransport base class for MCP Transport wrappers ([#14050](https://github.com/morluto/rea/issues/14050)) ([87e2e29](https://github.com/morluto/rea/commit/87e2e29d054b9b435a26e90e92e483394698e7d7))
* **server:** extract offline inspection tool bindings from serviceToolBindings ([#13984](https://github.com/morluto/rea/issues/13984)) ([880a2d5](https://github.com/morluto/rea/commit/880a2d5d51fbabef9d921da4af17982e106efee1))
* **server:** extract session, investigation, and workflow tool bindings ([#13968](https://github.com/morluto/rea/issues/13968)) ([7c34d27](https://github.com/morluto/rea/commit/7c34d27991c98c4867e03d56a38f5bba33fa9a04))
* **server:** replace server.close and onclose monkey-patching with lifecycle hooks ([#13882](https://github.com/morluto/rea/issues/13882)) ([a569ec5](https://github.com/morluto/rea/commit/a569ec5584ceef3ef2efa6cd1a7673839e9de443))
* **server:** share the service registration context ([#14496](https://github.com/morluto/rea/issues/14496)) ([c230c22](https://github.com/morluto/rea/commit/c230c22ea203b10e0943506d576947e706809d84))
* **server:** simplify contractToolBindings types and handler dispatch ([#13912](https://github.com/morluto/rea/issues/13912)) ([fdad60a](https://github.com/morluto/rea/commit/fdad60aea7ba8c090c367ad7315a0101b644ecc4))
* **setup:** extract SupportedClientLocations from SupportedClients ([#13731](https://github.com/morluto/rea/issues/13731)) ([8e619be](https://github.com/morluto/rea/commit/8e619be40c3074a36fe21d319d1c9dde11ae533d))
* **setup:** share client configuration path error checks ([#14822](https://github.com/morluto/rea/issues/14822)) ([54a6f08](https://github.com/morluto/rea/commit/54a6f08ecb22e1fb6751702f3195735249d07f89))
* **setup:** share publication destination checks ([#14904](https://github.com/morluto/rea/issues/14904)) ([68f817c](https://github.com/morluto/rea/commit/68f817cdee7bc46071c6cb4693a0a9de4aa374a1))
* **setup:** share recovery backup inspection ([#14939](https://github.com/morluto/rea/issues/14939)) ([a600e6a](https://github.com/morluto/rea/commit/a600e6aa38ab374ba4f4f47571680621b91a6606))
* **tests:** consolidate repeated CLI capture and fixture construction ([#14311](https://github.com/morluto/rea/issues/14311)) ([78149ee](https://github.com/morluto/rea/commit/78149eeec979a124ffca8f36c815405491901709))
* **tooling:** share verifier fixture and lint helpers ([#14318](https://github.com/morluto/rea/issues/14318)) ([4f0d160](https://github.com/morluto/rea/commit/4f0d1602546adc9b9da23bb148a844ab139310ae))
* **uefi/native:** cache UEFI BinaryReader and reuse hasDosMzMagic ([#13659](https://github.com/morluto/rea/issues/13659)) ([0fc591d](https://github.com/morluto/rea/commit/0fc591da7c2309f59a46933658de8591a4c90c41))
* **uefi/native:** cache UEFI BinaryReader per buffer and reuse hasDosMzMagic ([0fc591d](https://github.com/morluto/rea/commit/0fc591da7c2309f59a46933658de8591a4c90c41))
* **uefi:** exercise only the framed LZMA worker ([#14072](https://github.com/morluto/rea/issues/14072)) ([1f4c8fe](https://github.com/morluto/rea/commit/1f4c8fe5d5c810a7aa7d7702c6fc8142b5afd37c))
* **uefi:** extract UefiScanContext from UefiImageScan ([#13797](https://github.com/morluto/rea/issues/13797)) ([913b44d](https://github.com/morluto/rea/commit/913b44d1dac95aa09b27dd0fdd91ef7a7524ff75))
* **uefi:** share view filters, page limits and source indices ([#14680](https://github.com/morluto/rea/issues/14680)) ([37083fd](https://github.com/morluto/rea/commit/37083fd9e6e12bde1c4bca4c81c9b8f24f82c360))
* **uefi:** unify LZMA frame readers into LzmaFrameReader with backpressure ([#13814](https://github.com/morluto/rea/issues/13814)) ([fc29153](https://github.com/morluto/rea/commit/fc29153d5c0aaed05b011ad5461632d485001799))
* **uninstall:** extract registration-removal and item-collapse helpers from Uninstall ([#14006](https://github.com/morluto/rea/issues/14006)) ([bc8a0b3](https://github.com/morluto/rea/commit/bc8a0b32f37ef707e71fde55d394087d2b489c71))
* **uninstall:** extract UninstallDataAndSkills from Uninstall ([#13736](https://github.com/morluto/rea/issues/13736)) ([054bbbc](https://github.com/morluto/rea/commit/054bbbc55e63ff8d4b617a04cb681145f2ca134f))
* **verification:** share client version probes ([#14541](https://github.com/morluto/rea/issues/14541)) ([b3f4da9](https://github.com/morluto/rea/commit/b3f4da940425e9231b43de4c847a4748107193d7))
* **verifiers:** reuse streamed digests for artifacts on disk ([#14555](https://github.com/morluto/rea/issues/14555)) ([825fd0a](https://github.com/morluto/rea/commit/825fd0a19a6d9a098410fbae9d945a10cf6dc78c))
* **verifiers:** share installed skill checks across three clients ([#14521](https://github.com/morluto/rea/issues/14521)) ([8d881ce](https://github.com/morluto/rea/commit/8d881cef7b9aad769fa723297bd673db4ea88d43))
* **verifiers:** share legacy Ghidra snapshot construction ([#14566](https://github.com/morluto/rea/issues/14566)) ([150d6f0](https://github.com/morluto/rea/commit/150d6f0e1986ebdf646a5d1c063d19ca3eb26f12))
* **verifiers:** share package fixture home settings ([#14523](https://github.com/morluto/rea/issues/14523)) ([4f839e6](https://github.com/morluto/rea/commit/4f839e6a8f025f7dea154bbd9fbabda635430d2f))
* **verifiers:** share the model fixture request reader ([#14520](https://github.com/morluto/rea/issues/14520)) ([f5f6bb1](https://github.com/morluto/rea/commit/f5f6bb18613bb55e62de4f547114195f1f3d6cac))
* **verifiers:** share whole-file SHA-256 hashing ([#14475](https://github.com/morluto/rea/issues/14475)) ([60af9ef](https://github.com/morluto/rea/commit/60af9ef6b35e332dd5645fbb99ededfe5b40c64c))
* **verify:** exclude negated .ok checks from the abort-reclassification guard ([a80dc68](https://github.com/morluto/rea/commit/a80dc68318d2b9e2abca08ae5d4eaf1206b83bde)), refs [#11920](https://github.com/morluto/rea/issues/11920)
* **verify:** share canonical output schema assertions ([#14640](https://github.com/morluto/rea/issues/14640)) ([d9b449d](https://github.com/morluto/rea/commit/d9b449d39c64789b5c91de4915aba8567817a93b))
* **verify:** share client receipt publication ([#14317](https://github.com/morluto/rea/issues/14317)) ([74996b5](https://github.com/morluto/rea/commit/74996b5ba6c58e6d43b991c5167c6a68051e0332))
* **verify:** share client setup and idempotence checks ([#14326](https://github.com/morluto/rea/issues/14326)) ([d7846f2](https://github.com/morluto/rea/commit/d7846f283499b450bbbb7bc4301c2e5ef2f58833))
* **verify:** share Ghidra installation prerequisites ([#14569](https://github.com/morluto/rea/issues/14569)) ([a156d20](https://github.com/morluto/rea/commit/a156d2051646aaf5d61fe445a96321a45983e769))
* **verify:** share native client receipt context ([#14568](https://github.com/morluto/rea/issues/14568)) ([6cdab22](https://github.com/morluto/rea/commit/6cdab224f99a081e113de39cd5d4ad5760247e0b))
* **views:** centralize indexed row paging ([#14878](https://github.com/morluto/rea/issues/14878)) ([544ec63](https://github.com/morluto/rea/commit/544ec63f661e7f143643a531516bcb38ec57d839))
* **views:** reuse invalid-view results and row selectors ([#14314](https://github.com/morluto/rea/issues/14314)) ([5dafc31](https://github.com/morluto/rea/commit/5dafc31d23f8f6f13a57b9b374411f412917d199))
* **views:** reuse JSON record and request-line projections ([#14582](https://github.com/morluto/rea/issues/14582)) ([3d46331](https://github.com/morluto/rea/commit/3d4633176f15f3bd8072751af788bf31c7f2e0d8))
* **views:** reuse optional filters in report projections ([#14877](https://github.com/morluto/rea/issues/14877)) ([09a5b9c](https://github.com/morluto/rea/commit/09a5b9cef9393a8bd34ce096ed402fb72baf12e0))
* **views:** share bounded parent and report limitations ([#14902](https://github.com/morluto/rea/issues/14902)) ([2874a6e](https://github.com/morluto/rea/commit/2874a6e21f7eb17dedc34bf6e614a5be96bcd591))
* **views:** share count projections across analysis summaries ([#14600](https://github.com/morluto/rea/issues/14600)) ([c8f42a8](https://github.com/morluto/rea/commit/c8f42a872d39046a1dd3ae3e431642671b3b9357))
* **views:** share default page request fields ([#14633](https://github.com/morluto/rea/issues/14633)) ([d639828](https://github.com/morluto/rea/commit/d63982890e70c55b09704249cde0327537e610f0))
* **views:** share field-specific input errors ([#14942](https://github.com/morluto/rea/issues/14942)) ([0f7a029](https://github.com/morluto/rea/commit/0f7a0293c2e6f8f33cb5bbe1bb51b3ecb9f84da0))
* **views:** share fixed page budget errors ([#14479](https://github.com/morluto/rea/issues/14479)) ([a2fd2d7](https://github.com/morluto/rea/commit/a2fd2d7d3045951ee684b6612294495d9c4f7435))
* **views:** share invalid parent subject errors ([#14505](https://github.com/morluto/rea/issues/14505)) ([59a0ed3](https://github.com/morluto/rea/commit/59a0ed33fb5dad9b6bcce3e7f318350d88fbc78c))
* **views:** share optional filter set construction ([#14850](https://github.com/morluto/rea/issues/14850)) ([3fc508d](https://github.com/morluto/rea/commit/3fc508ddcc42d39aa837d10709f0383176ee3d8f))
* **views:** share selected page items and coverage ([#14946](https://github.com/morluto/rea/issues/14946)) ([5a9d032](https://github.com/morluto/rea/commit/5a9d032c95a631813f09f1da6d5a5c43836a51ab))
* **vsix:** share manifest extension list parsing ([#14876](https://github.com/morluto/rea/issues/14876)) ([16af28c](https://github.com/morluto/rea/commit/16af28c09e7d242a52ef1509c12f96cbabb032ea))
* **web:** remove the superseded single-query module matcher ([#14319](https://github.com/morluto/rea/issues/14319)) ([ab96130](https://github.com/morluto/rea/commit/ab96130f2277fa8a8571fb4bb4f210b6902acd5b))
* **web:** reuse the shared map list appender ([#14531](https://github.com/morluto/rea/issues/14531)) ([8da1e56](https://github.com/morluto/rea/commit/8da1e562775eced153123b32cdace52c8030ef19))
* **windows:** reuse the verified package argument encoder ([#14591](https://github.com/morluto/rea/issues/14591)) ([aad3c9c](https://github.com/morluto/rea/commit/aad3c9c45aa855e3c33fde4561a6e27f272cd695))
* **workers:** share bounded JSON line writes ([#14585](https://github.com/morluto/rea/issues/14585)) ([1dfd0e5](https://github.com/morluto/rea/commit/1dfd0e5fb4774c9f064808533aeb2579fa163e55))
* **xml:** share direct child element traversal ([#14669](https://github.com/morluto/rea/issues/14669)) ([e7cb42a](https://github.com/morluto/rea/commit/e7cb42a1d70123a015717f33ca0a0d4d9df24646))
* **xml:** share DOM element traversal helpers in xmlDocument ([#13799](https://github.com/morluto/rea/issues/13799)) ([4b648f2](https://github.com/morluto/rea/commit/4b648f23fd061417a7b0b57e560683e907f83020))
* **xml:** share NuGet and VSIX manifest field reads ([#14820](https://github.com/morluto/rea/issues/14820)) ([9353043](https://github.com/morluto/rea/commit/93530438a0275030690ba2945953e729a6471e5a))


### Documentation

* **analysis-view:** qualify javascript-fact-groups readback to scalar values ([1dc1c20](https://github.com/morluto/rea/commit/1dc1c20cd614d38a8bfe8ef23d0cea4e391fc561))
* **android:** describe budgeted delivery and the class and reference views ([4027711](https://github.com/morluto/rea/commit/402771122c09cc6f412fe2bc0617446703b439fc))
* **android:** describe the 16-row JNI summary preview ([b5d0b49](https://github.com/morluto/rea/commit/b5d0b49a903204a92ec0b92df28835c570673920))
* **android:** describe the default class-search page and next_offset ([100dc96](https://github.com/morluto/rea/commit/100dc966c7456f900db5cec3e535867060882f3b))
* **apktool:** describe decode delivery and resource views ([3ffbf5d](https://github.com/morluto/rea/commit/3ffbf5dea08eaebf3ab8faee7a9a88e1e214cbb8))
* **artifacts:** describe budgeted extraction delivery and its view ([4099d8f](https://github.com/morluto/rea/commit/4099d8feb1d43f410deb442eb579139e32dbf885))
* **artifacts:** explain the per-file verification cost of extraction ([#12745](https://github.com/morluto/rea/issues/12745)) ([6878c17](https://github.com/morluto/rea/commit/6878c17a833e6a595d4f80e47e98c256d60ca9c0))
* **browser:** describe comparing retained captures ([b33b8e8](https://github.com/morluto/rea/commit/b33b8e8ce6189d5db36f0e1ca90f2ab0a3ea87a6))
* **browser:** describe paging retained execution observations ([440edb5](https://github.com/morluto/rea/commit/440edb5ac050b6b746a8c24cd91bed2ec079fbdd))
* **ci:** correct default main push coverage ([#14535](https://github.com/morluto/rea/issues/14535)) ([1ff864b](https://github.com/morluto/rea/commit/1ff864bd21d9df6c6f48c0adde570acac905ca62))
* **cli:** explain Ghidra annotation lifetime in command help ([f8192bd](https://github.com/morluto/rea/commit/f8192bd39d233ccf6e3dd8fd06b1e21082316ddf)), refs [#8242](https://github.com/morluto/rea/issues/8242)
* **cli:** list the desktop_build doctor scope in provider selection ([4bd9327](https://github.com/morluto/rea/commit/4bd9327325b75a4632a3a50f0500ae2bfbd00718)), refs [#10251](https://github.com/morluto/rea/issues/10251)
* **cli:** name the code for every argument parse failure ([a23a30c](https://github.com/morluto/rea/commit/a23a30c41d6fa4d663f6f201fba12a68c5ba0b3a))
* codify pagination, schema-flatness, DDIA, and flat-ownership guidance in tool-design docs and skills ([#13865](https://github.com/morluto/rea/issues/13865)) ([69e96c3](https://github.com/morluto/rea/commit/69e96c3564e58be6c7062a7f7fd506a0218916d8))
* correct, re-verify and prune getting-started, provider and reference pages ([#14202](https://github.com/morluto/rea/issues/14202)) ([be47922](https://github.com/morluto/rea/commit/be47922331c4df05f4217f0ff9178bc49415db48))
* **dev:** clarify how to review duplicate ownership ([fb691dc](https://github.com/morluto/rea/commit/fb691dc98b7384fa9e6dd93f4a459b50c700400c))
* **development:** document streaming, reader/queue reuse, and O(limit) view hot-path patterns ([#13778](https://github.com/morluto/rea/issues/13778)) ([0f2437c](https://github.com/morluto/rea/commit/0f2437cca384d174a4791d1c0b69bfeee027049e))
* **development:** route first contact by parsed facts and split admission limits from delivery budgets ([#14193](https://github.com/morluto/rea/issues/14193)) ([a1d53d3](https://github.com/morluto/rea/commit/a1d53d39565fe0976e0c86aeca9130901f4db7c6))
* document per-call pagination, call-graph bounds, and streaming NuGet inspection ([#13851](https://github.com/morluto/rea/issues/13851)) ([46d41e4](https://github.com/morluto/rea/commit/46d41e4b79302539222dc6eeac9e8c36466491a4)), refs [#13850](https://github.com/morluto/rea/issues/13850)
* **elf:** give the 64-range default unwind page ([54a186d](https://github.com/morluto/rea/commit/54a186da88d9759a582d1498383277fd1ed1c9c7))
* **elf:** state when the dynamic table establishes the unwind GOT base ([e15d64e](https://github.com/morluto/rea/commit/e15d64ec0faa3b59c41a9d53972e274eacf4c6ae))
* **firmware:** describe UEFI extraction summaries and owners ([4db1058](https://github.com/morluto/rea/commit/4db10585f0b52921bf3caa2540aebc149aeb4689))
* **firmware:** describe UEFI summaries and views ([89fc51b](https://github.com/morluto/rea/commit/89fc51ba975e630743f2718d7cac3d4d817cc22c))
* **ghidra:** link the native build steps for Linux arm64 ([dc10161](https://github.com/morluto/rea/commit/dc10161a9e0663c005fffb038e697306ca224482)), refs [#7018](https://github.com/morluto/rea/issues/7018)
* **ghidra:** name the failure codes for unmapped decompile selectors ([76e319b](https://github.com/morluto/rea/commit/76e319b80fe207f05b6558053a8f66264680820d))
* **github:** require reported verification and factual docs in PR template ([#14130](https://github.com/morluto/rea/issues/14130)) ([a92d502](https://github.com/morluto/rea/commit/a92d5024724333f7169450a321101bb3e9dbd848))
* **guides:** correct host and runtime claims and prune change notes ([05b683b](https://github.com/morluto/rea/commit/05b683b72e8579ab4cf1cbb7181179d27b110965))
* **guides:** correct host and runtime claims and prune change notes ([4b5fcc9](https://github.com/morluto/rea/commit/4b5fcc9eab6c70d4e873c4fba6fe10e578623e4d))
* **guides:** correct host requirements and prune change notes in runtime, web, data guides ([#14197](https://github.com/morluto/rea/issues/14197)) ([4b5fcc9](https://github.com/morluto/rea/commit/4b5fcc9eab6c70d4e873c4fba6fe10e578623e4d))
* **guides:** correct native and platform guide flags, host limits and stale notes ([#14198](https://github.com/morluto/rea/issues/14198)) ([77b5b76](https://github.com/morluto/rea/commit/77b5b76e99f3f843e9691bee5a0dd616b8a909d8))
* **i18n:** standardize Vietnamese translations for guides and common terms ([#14141](https://github.com/morluto/rea/issues/14141)) ([bf913bc](https://github.com/morluto/rea/commit/bf913bc3dc3b710c9f46594fe4b8dfca6f59d5fb))
* **ida:** name the database supervisor's deadlines for long analyses ([6b7b09f](https://github.com/morluto/rea/commit/6b7b09f00808431ac948e2c4eae8222e3b107afd)), refs [#13286](https://github.com/morluto/rea/issues/13286)
* **install:** describe setup's direct-launch MCP registrations ([c0af3e2](https://github.com/morluto/rea/commit/c0af3e293cd85bfdece21a4e2ce2f7d25ab8e684)), refs [#10252](https://github.com/morluto/rea/issues/10252)
* **install:** link Windows native build steps from a source checkout ([4a6fa19](https://github.com/morluto/rea/commit/4a6fa1937940f35c0873aff7b63bb6ffd98a583f)), refs [#10317](https://github.com/morluto/rea/issues/10317)
* **mcp:** clarify DeepSeek catalog refresh compatibility ([#13041](https://github.com/morluto/rea/issues/13041)) ([baad68f](https://github.com/morluto/rea/commit/baad68f437edc5c41116092cbc5bf272b40fd5f7))
* **mcp:** clarify when discovery requires a catalog refresh ([#14837](https://github.com/morluto/rea/issues/14837)) ([a6b1b3e](https://github.com/morluto/rea/commit/a6b1b3e92c72dfce2656027ccc30c1e423d6762b))
* **native:** describe export RVAs and name-prefix views ([d3773c9](https://github.com/morluto/rea/commit/d3773c910e85770573e2e6c47d8a49205cdb6fe1))
* **native:** explain resource-only bundle admission ([#5764](https://github.com/morluto/rea/issues/5764)) ([e773afd](https://github.com/morluto/rea/commit/e773afd9c31570a463d988109b1da9b19ad71d2e))
* **objdump:** describe the command summary output counts ([9676960](https://github.com/morluto/rea/commit/9676960a46119b4fdfa7537a250734ccf6ed9156))
* **process:** record the capture PTY hangup of same-group children ([#10282](https://github.com/morluto/rea/issues/10282)) ([360bcb4](https://github.com/morluto/rea/commit/360bcb4c6cffc2e4d7f855b200927f508df17163))
* **process:** state the finalization delivery grace is fixed ([2d71c5c](https://github.com/morluto/rea/commit/2d71c5c3357a2c1d8736f92d1d9b8bf9105a7042))
* **readme:** link contributor avatars to the contributor directory ([08880c3](https://github.com/morluto/rea/commit/08880c3542894c7c0b721a6fe79cd61b9936ff90))
* **readme:** refresh project badges ([c7bc743](https://github.com/morluto/rea/commit/c7bc7436b4c354aabd34723b22dae7e544ee9a5e))
* **readme:** simplify setup and move target details to the reference ([a914bba](https://github.com/morluto/rea/commit/a914bba78df46985618598a8e4ef79145acd3784))
* **reference:** say that pwntools memory failures carry no producer limit ([#14221](https://github.com/morluto/rea/issues/14221)) ([ff2f9d9](https://github.com/morluto/rea/commit/ff2f9d98803e3faf988a747c3792b95741562953))
* remove tracked planning and architecture records ([#12856](https://github.com/morluto/rea/issues/12856)) ([a1dec2d](https://github.com/morluto/rea/commit/a1dec2d2d502ebb56da8902ccde9bf3dd9dfaf23))
* **setup:** document Kilo Code registration and its config layers ([#13413](https://github.com/morluto/rea/issues/13413)) ([c445f56](https://github.com/morluto/rea/commit/c445f56ae39ad13016ef4511e4e95dd9e7adb86e))
* **skill:** move WASM interface comparison under Offline WASM ([c5c0063](https://github.com/morluto/rea/commit/c5c0063d4ca8d27b57bb29588cfffaea04c23fe0)), refs [#8334](https://github.com/morluto/rea/issues/8334)
* **sqlite:** distinguish exhausted windows from unordered samples ([#13124](https://github.com/morluto/rea/issues/13124)) ([49b9245](https://github.com/morluto/rea/commit/49b92452627b4d6a7bbd455163532f170277093a))
* streamline the README and expand the RL environment guide ([f3ce9a1](https://github.com/morluto/rea/commit/f3ce9a14c7b7ea482352bc6c8c66bdcd22ba7705))
* **third-party:** warn against identically named jar source on npm ([402273d](https://github.com/morluto/rea/commit/402273dd571ec8cf72e1e9beac7470b1490cd7d2))
* tighten contributor guidance and prune duplicated skill text ([#14203](https://github.com/morluto/rea/issues/14203)) ([d506a6f](https://github.com/morluto/rea/commit/d506a6f6dfe62d85ad2a9b000041caeb233f9e6f))
* tighten format pages and correct stated limits ([#14199](https://github.com/morluto/rea/issues/14199)) ([f3ce4ca](https://github.com/morluto/rea/commit/f3ce4cabf642bb182eca99b3e666cd715599bf55))
* **tool-design:** document single-pass derivation, hash joins, and owned-payload validation for hot paths ([#13556](https://github.com/morluto/rea/issues/13556)) ([001eac0](https://github.com/morluto/rea/commit/001eac03aad199c4468bf9f544def6eeda65e4a0))
* **v8:** describe the six-word code cache header ([56838a0](https://github.com/morluto/rea/commit/56838a036c2c43afee56b0336a35abbf959770f2))
* **verification:** remove dated records that nothing cites ([#14196](https://github.com/morluto/rea/issues/14196)) ([bdefa90](https://github.com/morluto/rea/commit/bdefa90dfbcc16cb75c3cd4869a76715eccad018))


### Tests

* **adb:** consolidate logcat byte and Unicode coverage ([#12820](https://github.com/morluto/rea/issues/12820)) ([0f9ec0e](https://github.com/morluto/rea/commit/0f9ec0e44b7f77a4a4351b32c64de09b89af18e0))
* **adb:** consolidate logcat byte capture coverage ([0f9ec0e](https://github.com/morluto/rea/commit/0f9ec0e44b7f77a4a4351b32c64de09b89af18e0))
* **agentenv:** consolidate computer bridge teardown checks ([#12811](https://github.com/morluto/rea/issues/12811)) ([e482414](https://github.com/morluto/rea/commit/e48241439d149fa6a69f056b787ddaaf0687c564))
* **agentenv:** consolidate computer teardown cases ([e482414](https://github.com/morluto/rea/commit/e48241439d149fa6a69f056b787ddaaf0687c564))
* **agentenv:** consolidate verification, capture and cleanup checks ([#12855](https://github.com/morluto/rea/issues/12855)) ([d137ffa](https://github.com/morluto/rea/commit/d137ffa76232c45c740b5fdf5e47f6341b1f13ca))
* **agentenv:** stabilize timeout and stderr signal fixtures ([#12864](https://github.com/morluto/rea/issues/12864)) ([c18a8f9](https://github.com/morluto/rea/commit/c18a8f9e7f66e30903e75b219a24194a98d0e372))
* **agentenv:** witness leader exit before stderr cancellation ([166166e](https://github.com/morluto/rea/commit/166166e197743a6bb6510a63b63b8b4e9a684b23))
* **agentenv:** witness supervised exit before drain cancellation ([#12858](https://github.com/morluto/rea/issues/12858)) ([166166e](https://github.com/morluto/rea/commit/166166e197743a6bb6510a63b63b8b4e9a684b23))
* **analysis-view:** cover compressed-size inventory ordering ([3cfbe81](https://github.com/morluto/rea/commit/3cfbe81509e4f33780a7d3ef843510e94e042495))
* **android:** assert bridge property types and surface Java stderr ([ab3ae65](https://github.com/morluto/rea/commit/ab3ae658da22c9362b7836ab1a403ad37f7163d4))
* **android:** check component names through manifest inventory ([29925b3](https://github.com/morluto/rea/commit/29925b3c2f7bf9ba11623e0d099a4a5558abec37))
* **android:** consolidate ADB and Apktool boundary checks ([#12837](https://github.com/morluto/rea/issues/12837)) ([79525a7](https://github.com/morluto/rea/commit/79525a7c3eb0fe333463a2c76265a5f9fcdd7e2c))
* **android:** consolidate mapping parser and cache checks ([#12865](https://github.com/morluto/rea/issues/12865)) ([3a90d7f](https://github.com/morluto/rea/commit/3a90d7f37cc61ef5a1d3a9d45060048758ad5eef))
* **android:** consolidate OTA partition metadata order coverage ([#12826](https://github.com/morluto/rea/issues/12826)) ([68ed9b0](https://github.com/morluto/rea/commit/68ed9b0e67573c1dd0f4bca83977f1240fef682e))
* **android:** stop hand-copying the engine version in tests ([3d1f11a](https://github.com/morluto/rea/commit/3d1f11a61238bc108c6dfa590d3e9c128bbb8c52))
* **android:** verify component name resolution through the manifest reader ([#12806](https://github.com/morluto/rea/issues/12806)) ([29925b3](https://github.com/morluto/rea/commit/29925b3c2f7bf9ba11623e0d099a4a5558abec37))
* **apk:** consolidate signature capacity checks at their boundaries ([#12789](https://github.com/morluto/rea/issues/12789)) ([d766ab5](https://github.com/morluto/rea/commit/d766ab56dc43ab18130ca50f038c24891cc0fd75))
* **apk:** consolidate signature refusal coverage ([d766ab5](https://github.com/morluto/rea/commit/d766ab56dc43ab18130ca50f038c24891cc0fd75))
* **apple:** consolidate bundle resource CLI coverage ([#12936](https://github.com/morluto/rea/issues/12936)) ([12ac054](https://github.com/morluto/rea/commit/12ac0541f68268e6562807e1168ca62d0efd9d7f))
* **apple:** consolidate dylib resolution contract checks ([#13424](https://github.com/morluto/rea/issues/13424)) ([8925ec4](https://github.com/morluto/rea/commit/8925ec461e0f36d8109c8226650d5714c6da4bf5))
* **apple:** expect path-selected inspect_artifact in resource-only sessions ([a4d9a24](https://github.com/morluto/rea/commit/a4d9a2412fb2958950e7b0941a3f8777e5bb950d))
* **apple:** reuse the empty Interface Builder fixture ([#14674](https://github.com/morluto/rea/issues/14674)) ([94b1ce3](https://github.com/morluto/rea/commit/94b1ce3fe777ff9ac33da19b95ef7e053b669f78))
* **apple:** share binary plist object layout fixtures ([#14488](https://github.com/morluto/rea/issues/14488)) ([6c51be5](https://github.com/morluto/rea/commit/6c51be53172fa9cc49a0f337b2e0e1906638b465))
* **apple:** share the binary plist decoder invariant suite ([#14492](https://github.com/morluto/rea/issues/14492)) ([b06d82a](https://github.com/morluto/rea/commit/b06d82aa28e3aa7629e4a8f71f177f3a12b3622b))
* **application:** share late cancellation evidence checks ([#14381](https://github.com/morluto/rea/issues/14381)) ([7fe9fc5](https://github.com/morluto/rea/commit/7fe9fc5ee9b950c060c536050bd77d51cf80cf25))
* **applications:** share one MCP session in Playwright trace tests ([32ed734](https://github.com/morluto/rea/commit/32ed73425051d8ea261940b2d0fddcff8b664448))
* **applications:** share sessions in keyed archive scalar tests ([e5f6643](https://github.com/morluto/rea/commit/e5f6643d2fa9db6f39ace0df1491ecea61a5375c))
* **applications:** share sessions in mobile directory component tests ([05aef29](https://github.com/morluto/rea/commit/05aef294256ec7a8f10604119f1d6b66a3d1c2bd))
* **apt:** consolidate source position and quoted config proof ([#13667](https://github.com/morluto/rea/issues/13667)) ([b146939](https://github.com/morluto/rea/commit/b14693914cd49ae1bd2080a21721bd05b1c68244))
* **artifacts:** consolidate carrier cleanup and exercise active ASAR reads ([#13454](https://github.com/morluto/rea/issues/13454)) ([3cfcabd](https://github.com/morluto/rea/commit/3cfcabdf1b1ebf3e4959d7a6f8042c6ebfe8dce9))
* **artifacts:** consolidate extraction publication coverage ([#12825](https://github.com/morluto/rea/issues/12825)) ([a71ae07](https://github.com/morluto/rea/commit/a71ae07ffb5390ecf8373ee72775c51d2fdc99fc))
* **artifacts:** consolidate failure projection and marking coverage ([#13473](https://github.com/morluto/rea/issues/13473)) ([2b4847b](https://github.com/morluto/rea/commit/2b4847b9514723dd814151d129dcc9059ea47b7b))
* **artifacts:** consolidate inventory view coverage ([#12871](https://github.com/morluto/rea/issues/12871)) ([5486394](https://github.com/morluto/rea/commit/5486394715d13e0224bed43d74bad0669d0fa8f3))
* **artifacts:** consolidate keyed archive scalar delivery coverage ([7f41107](https://github.com/morluto/rea/commit/7f411078a3ddd85d570bc1ed5050ecb372be7a38))
* **artifacts:** consolidate Node SEA carrier and wire contracts ([#13415](https://github.com/morluto/rea/issues/13415)) ([6895a9e](https://github.com/morluto/rea/commit/6895a9e86061ec1c0aca5bd0281a37f6ee75f9b9))
* **artifacts:** consolidate Node SEA comparison coverage ([#13417](https://github.com/morluto/rea/issues/13417)) ([a394686](https://github.com/morluto/rea/commit/a394686328f1ff12206292dbf7aeb3333d2bebb2))
* **artifacts:** consolidate PyInstaller CLI archive coverage ([#13563](https://github.com/morluto/rea/issues/13563)) ([fd28d85](https://github.com/morluto/rea/commit/fd28d85c9b228a51bbb9c956d70aa048e741e750))
* **artifacts:** consolidate reader ordering and coverage checks ([#12774](https://github.com/morluto/rea/issues/12774)) ([d1275f7](https://github.com/morluto/rea/commit/d1275f72d6fc4299f341be3d7c301f9d3d4fd155))
* **artifacts:** consolidate selected name and admitted content coverage ([#12880](https://github.com/morluto/rea/issues/12880)) ([fdbe6d5](https://github.com/morluto/rea/commit/fdbe6d5f2b401521dcc4c0f76677ec2c80771895))
* **artifacts:** consolidate summary replay coverage ([#12942](https://github.com/morluto/rea/issues/12942)) ([e4d3861](https://github.com/morluto/rea/commit/e4d3861756e32dc850606ac35bac0f53e24ae001))
* **artifacts:** exercise retained comparison evidence authentication ([236f5ae](https://github.com/morluto/rea/commit/236f5ae3fae0d4c86a37dd6a75e1704dd5237b13))
* **artifacts:** make stable stream finalization deterministic ([#13462](https://github.com/morluto/rea/issues/13462)) ([fd3b80e](https://github.com/morluto/rea/commit/fd3b80e641a1acb1c929a8e806903334f8565c10))
* **artifacts:** pin the inspection's sealed inventory Evidence by identity ([0fa803e](https://github.com/morluto/rea/commit/0fa803e7e8d69d3e2756be1e9f32084734f2f6c5))
* **artifacts:** prove output filename identity at the filesystem boundary ([#13463](https://github.com/morluto/rea/issues/13463)) ([35db86b](https://github.com/morluto/rea/commit/35db86b87eb046e4b96c22e9df90f120b3f400b8))
* **artifacts:** read ASAR occurrence limitations from extracted file rows ([52ae41a](https://github.com/morluto/rea/commit/52ae41a4a494fd6e4daa7e2387569737c842675f))
* **artifacts:** remove descriptor registry mirror checks ([#12796](https://github.com/morluto/rea/issues/12796)) ([c7353f4](https://github.com/morluto/rea/commit/c7353f42577038d0814719e62c6ffedb3bb2fcff))
* **artifacts:** repair comparison evidence authenticity checks ([#12779](https://github.com/morluto/rea/issues/12779)) ([236f5ae](https://github.com/morluto/rea/commit/236f5ae3fae0d4c86a37dd6a75e1704dd5237b13))
* **artifacts:** reuse temp files in four reader suites ([#14559](https://github.com/morluto/rea/issues/14559)) ([83e7fe7](https://github.com/morluto/rea/commit/83e7fe789f41581d2d60f726442ec864cf425c75))
* **artifacts:** reuse temporary files in Android reader fixtures ([#14750](https://github.com/morluto/rea/issues/14750)) ([da129c0](https://github.com/morluto/rea/commit/da129c00a31ce5ba49102bbb10f30bf5324809a5))
* **artifacts:** share archive member stream lifecycle cases ([#14452](https://github.com/morluto/rea/issues/14452)) ([299399d](https://github.com/morluto/rea/commit/299399dda35f70f51f4de34f9c8df5cfe292eb79))
* **artifacts:** share carrier writes across four readers ([#14565](https://github.com/morluto/rea/issues/14565)) ([b89c7ec](https://github.com/morluto/rea/commit/b89c7ecc05e49bf3ab3550f56899eac281b9c755))
* **artifacts:** share entry collection in ZIP reader tests ([#14821](https://github.com/morluto/rea/issues/14821)) ([0cc5907](https://github.com/morluto/rea/commit/0cc5907e702340a653af5b31498bc84fc1f022e8))
* **artifacts:** share inventory occurrence lookup across comparisons ([#14602](https://github.com/morluto/rea/issues/14602)) ([5e33cf3](https://github.com/morluto/rea/commit/5e33cf33e39870a56e8d8b03e7901e7112a8b478))
* **artifacts:** share inventory view and reader fixtures ([#14380](https://github.com/morluto/rea/issues/14380)) ([4255a96](https://github.com/morluto/rea/commit/4255a96e0fb227ff41314d860421e2f590135dcc))
* **artifacts:** share macOS package reader fixtures ([#14853](https://github.com/morluto/rea/issues/14853)) ([52e5b41](https://github.com/morluto/rea/commit/52e5b416b1ce59c9899636e53162b898af387549))
* **artifacts:** share temporary fixture file writes ([#14540](https://github.com/morluto/rea/issues/14540)) ([7e12b4f](https://github.com/morluto/rea/commit/7e12b4f32d172ef6ff993461d54506a278743de4))
* **artifacts:** share thin Mach-O section fixtures ([#14480](https://github.com/morluto/rea/issues/14480)) ([2e1cc32](https://github.com/morluto/rea/commit/2e1cc32586c60ae59c0bea66ddd091be7f49df9b))
* **artifacts:** share UBI reader fixture helpers ([#14809](https://github.com/morluto/rea/issues/14809)) ([26b4154](https://github.com/morluto/rea/commit/26b415462fbe9b3740d5e250771efd2fc89a47d1))
* **artifacts:** use the native byte stream consumer ([#14533](https://github.com/morluto/rea/issues/14533)) ([82c3b29](https://github.com/morluto/rea/commit/82c3b2972ffb8d15ad9b0d595b7f109bda2395f8))
* **artifacts:** verify cleanup at the physical ownership boundary ([#13486](https://github.com/morluto/rea/issues/13486)) ([809c550](https://github.com/morluto/rea/commit/809c550f502a47d3127bce2b4524b736bbb6efd1))
* **asar:** consolidate CLI hash-uncertainty coverage ([#12951](https://github.com/morluto/rea/issues/12951)) ([2ff9917](https://github.com/morluto/rea/commit/2ff9917d20ef5e788c6d61c4a45db90c1bfde63e))
* **asar:** consolidate companion identity coverage ([#12946](https://github.com/morluto/rea/issues/12946)) ([339b6b5](https://github.com/morluto/rea/commit/339b6b5750999def7fe2a9a8d55ed12f88a71a29))
* **asar:** consolidate header admission coverage ([#12944](https://github.com/morluto/rea/issues/12944)) ([4f472e0](https://github.com/morluto/rea/commit/4f472e001c05054005e414b12ffc8eff4658257e))
* **asar:** consolidate inventory boundary coverage ([#12948](https://github.com/morluto/rea/issues/12948)) ([916a033](https://github.com/morluto/rea/commit/916a033eb7f6ede0365b0e1dcfae223547ffa168))
* **asar:** consolidate MCP admission and extraction coverage ([#12950](https://github.com/morluto/rea/issues/12950)) ([93aaf18](https://github.com/morluto/rea/commit/93aaf18e181b926fb3dad71d426744ec7443698c))
* **asar:** consolidate packed listing coverage ([#12945](https://github.com/morluto/rea/issues/12945)) ([c355fcb](https://github.com/morluto/rea/commit/c355fcb8f7ba8e45adc25a27a8af2eeb28af1452))
* **asar:** streamline allocation and descriptor fixtures ([#12949](https://github.com/morluto/rea/issues/12949)) ([0b0b847](https://github.com/morluto/rea/commit/0b0b847afd3362c34b093f3bfbde7d6abc39cead))
* **asar:** verify packed member close on cancellation ([#12947](https://github.com/morluto/rea/issues/12947)) ([2f87f93](https://github.com/morluto/rea/commit/2f87f938e0b986146599cc12327a8da39e4c2654))
* assert structured facts instead of incidental wording ([#14222](https://github.com/morluto/rea/issues/14222)) ([c68ddbe](https://github.com/morluto/rea/commit/c68ddbec7cea929826e9d04fa7649bab6cf465af))
* **audit:** consolidate release exposure document routing ([#13347](https://github.com/morluto/rea/issues/13347)) ([cdba576](https://github.com/morluto/rea/commit/cdba576469ea64b708cdc0d34612050b16b492bb))
* **audit:** consolidate release exposure evidence checks ([#13341](https://github.com/morluto/rea/issues/13341)) ([23af000](https://github.com/morluto/rea/commit/23af000299a049350ac63cd41f94892e1c1c9089))
* **binary:** throw the cause when restoration setup fails ([89fe8dc](https://github.com/morluto/rea/commit/89fe8dcf4e704e56187653b8c23fbd3eb5d00a92))
* **browser:** catch permissive decoding of malformed wire payloads ([#12792](https://github.com/morluto/rea/issues/12792)) ([fc5ba54](https://github.com/morluto/rea/commit/fc5ba5473be501fd9fce2d094a2d8aa6c41c69f5))
* **browser:** catch permissive response body decoding ([fc5ba54](https://github.com/morluto/rea/commit/fc5ba5473be501fd9fce2d094a2d8aa6c41c69f5))
* **browser:** consolidate bundle admission and retained facts ([#13227](https://github.com/morluto/rea/issues/13227)) ([6e30062](https://github.com/morluto/rea/commit/6e300622e9d6a2fe68092a050b600f8a1e62719d))
* **browser:** consolidate local artifact provenance checks ([#13221](https://github.com/morluto/rea/issues/13221)) ([e94eb2c](https://github.com/morluto/rea/commit/e94eb2cb6447897fbffb8024415c54bb55449f2e))
* **browser:** consolidate native module lifecycle checks ([#13224](https://github.com/morluto/rea/issues/13224)) ([de0418c](https://github.com/morluto/rea/commit/de0418c1f456496749d495eefbf1ef8d417c5f6b))
* **browser:** consolidate runtime window and request contracts ([#13230](https://github.com/morluto/rea/issues/13230)) ([cfa0498](https://github.com/morluto/rea/commit/cfa04985c210cccc71483df1bf370824c6995bc5))
* **browser:** consolidate source-map and deadline contracts ([#13220](https://github.com/morluto/rea/issues/13220)) ([7b3fb89](https://github.com/morluto/rea/commit/7b3fb897c0868c198b7c92b1a413c0535240ea8d))
* **browser:** consolidate source-map coordinates and wire deadlines ([#13235](https://github.com/morluto/rea/issues/13235)) ([1f3703f](https://github.com/morluto/rea/commit/1f3703f6f1ffe7626bb33c0ffaf5a7b6f6c216f4))
* **browser:** consolidate worker framing and cleanup checks ([#12885](https://github.com/morluto/rea/issues/12885)) ([87940b1](https://github.com/morluto/rea/commit/87940b192c486551c194fb06b5bf468854d5404e))
* **browser:** cover Android late-handshake cleanup retry ([4acc720](https://github.com/morluto/rea/commit/4acc720ac3687d800b981071f3e41c5545fe1d8c))
* **browser:** reuse page and Evidence inspection fixtures ([#14581](https://github.com/morluto/rea/issues/14581)) ([18aec2e](https://github.com/morluto/rea/commit/18aec2e7630763676332fa0d323ea56fd96610ee))
* **browser:** share sessions in historical HAR capture tests ([dfd32bf](https://github.com/morluto/rea/commit/dfd32bf3807c13f25be68a0d782ebdd98b151a0f))
* **browser:** share validated inspection comparisons ([#14567](https://github.com/morluto/rea/issues/14567)) ([41bdf03](https://github.com/morluto/rea/commit/41bdf03a98b477be669a43731bb94984a5a420aa))
* **browser:** sharpen HAR malformed input and producer guard checks ([#12805](https://github.com/morluto/rea/issues/12805)) ([9ab18ba](https://github.com/morluto/rea/commit/9ab18ba1dae99f690add39190ef964ba8be3232e))
* **browser:** verify loopback lease order without a timing race ([#12786](https://github.com/morluto/rea/issues/12786)) ([6bb47ed](https://github.com/morluto/rea/commit/6bb47ed777d6ccddea8e458e78273cf9c1b13a0b))
* **browser:** verify result budgets and memory attribution structurally ([#12886](https://github.com/morluto/rea/issues/12886)) ([70eb0b6](https://github.com/morluto/rea/commit/70eb0b67226eefe5088a70cdbc51facd71a1be8a))
* **browser:** witness CDP observation before cancelling ([#12866](https://github.com/morluto/rea/issues/12866)) ([4d81b0d](https://github.com/morluto/rea/commit/4d81b0d07bb81bff034e671114d40e1f118183e4))
* **bun:** share standalone reader fixture writes ([#14944](https://github.com/morluto/rea/issues/14944)) ([b005b0b](https://github.com/morluto/rea/commit/b005b0bab67b4ae196e68df95acba78883d7db32))
* **bun:** share the file-handle read observer ([#14577](https://github.com/morluto/rea/issues/14577)) ([1db0721](https://github.com/morluto/rea/commit/1db07212341131c3374369d168329855b9c6cd1b))
* **capture:** consolidate historical runtime retry coverage ([#13217](https://github.com/morluto/rea/issues/13217)) ([9528005](https://github.com/morluto/rea/commit/95280057075d56eae961c6d9f102a4147747e867))
* **capture:** consolidate historical worker lifecycle checks ([#13216](https://github.com/morluto/rea/issues/13216)) ([e5850af](https://github.com/morluto/rea/commit/e5850aff15178098fa8ae26a3b70b946654af454))
* **capture:** consolidate Playwright trace contracts ([#13207](https://github.com/morluto/rea/issues/13207)) ([339f0ac](https://github.com/morluto/rea/commit/339f0ace57b2c365972c261b228ff23bcbe6586b))
* **capture:** consolidate Protobuf descriptor identity checks ([#13214](https://github.com/morluto/rea/issues/13214)) ([1e89bcc](https://github.com/morluto/rea/commit/1e89bcc2163ff2f081b6d0f011572c0389dfaeb6))
* **capture:** consolidate redirect and URL admission checks ([#13218](https://github.com/morluto/rea/issues/13218)) ([0ee5f84](https://github.com/morluto/rea/commit/0ee5f8461e44fbf1b0cea9ec590ef41b6d4971c7))
* **capture:** prove retained summaries survive source deletion ([#13206](https://github.com/morluto/rea/issues/13206)) ([a2faf4c](https://github.com/morluto/rea/commit/a2faf4cc343608862c4c7d496c3b1c6520e299fb))
* **capture:** retain independent Playwright trace coverage checks ([#13208](https://github.com/morluto/rea/issues/13208)) ([62d836a](https://github.com/morluto/rea/commit/62d836a630bfd97e10b21088470ac3a80e3ea809))
* **captures:** consolidate packet provider coverage ([4b79eaa](https://github.com/morluto/rea/commit/4b79eaa9edae781b4c094caea9158d0f39498492))
* **ci:** consolidate analysis efficiency comparator scenarios ([#12804](https://github.com/morluto/rea/issues/12804)) ([b20f857](https://github.com/morluto/rea/commit/b20f8576f27f5dc8ee3fc06ac56ee0f2c57159ee))
* **ci:** consolidate NativeAOT verifier restore and publish checks ([#12815](https://github.com/morluto/rea/issues/12815)) ([b9bcfa4](https://github.com/morluto/rea/commit/b9bcfa4041d01746534974dbb4c8658920906a7a))
* **ci:** consolidate project deadline policy checks ([#12777](https://github.com/morluto/rea/issues/12777)) ([ec533c6](https://github.com/morluto/rea/commit/ec533c6e648aa63fd0f0d10e985abbaa497a8df7))
* **ci:** consolidate project discovery and isolation checks ([#12842](https://github.com/morluto/rea/issues/12842)) ([21795b1](https://github.com/morluto/rea/commit/21795b199d1bc94f3ee17688e45403e689cbc966))
* **ci:** consolidate required lane gate coverage ([#13515](https://github.com/morluto/rea/issues/13515)) ([77c5e6b](https://github.com/morluto/rea/commit/77c5e6bf82bf4bceb4a4cffcd2e4b517d3ffb51a))
* **ci:** keep the separator regression in the Windows-only lane guard ([21cfc80](https://github.com/morluto/rea/commit/21cfc809bc9465b4c39d0f14874bdbbd58159f44))
* **ci:** make test selection and provider report refusals observable ([#12782](https://github.com/morluto/rea/issues/12782)) ([21051b9](https://github.com/morluto/rea/commit/21051b9d06f82d9da0a932d328cae8db87644f77))
* **ci:** require a positive binary-layout download deadline ([#14755](https://github.com/morluto/rea/issues/14755)) ([72b77b2](https://github.com/morluto/rea/commit/72b77b2f8e429aa24c2b475a0d54f4de222b1337))
* **ci:** require planner directories in classifier checkouts ([#14553](https://github.com/morluto/rea/issues/14553)) ([0acafde](https://github.com/morluto/rea/commit/0acafdeafa5880c8e8a385ef0e5b737887a4cecf))
* **ci:** reuse workflow inventory and verify cache authority ([#13525](https://github.com/morluto/rea/issues/13525)) ([eb1d540](https://github.com/morluto/rea/commit/eb1d54007576e0443c7200f8da4143ed38025699))
* **ci:** verify selected shard and provider report refusals ([21051b9](https://github.com/morluto/rea/commit/21051b9d06f82d9da0a932d328cae8db87644f77))
* **cli:** accept any account configuration behind an empty test HOME ([660b135](https://github.com/morluto/rea/commit/660b135f41091b6074571ff93838bd188a1ca782))
* **cli:** check the Go input budget recovery flag ([#14672](https://github.com/morluto/rea/issues/14672)) ([bcaf605](https://github.com/morluto/rea/commit/bcaf6056a86b231b774fdada5a8766dcbabbbb2e))
* **cli:** consolidate Amp launcher registration coverage ([#12940](https://github.com/morluto/rea/issues/12940)) ([a31b80a](https://github.com/morluto/rea/commit/a31b80a4128502bcffda98d88e764db0a3544dc3))
* **cli:** consolidate automatic client setup journeys ([#12807](https://github.com/morluto/rea/issues/12807)) ([f718e17](https://github.com/morluto/rea/commit/f718e17caaa8fa73d6a8705833e811a3be85b994))
* **cli:** consolidate completed source evidence finalization checks ([688d129](https://github.com/morluto/rea/commit/688d129aef5eaf8155d2d1401d86c900effb6f33))
* **cli:** consolidate cross-alias registration readiness checks ([53a23c0](https://github.com/morluto/rea/commit/53a23c0f0ddb3edca0a34ae29632407ab2974de0))
* **cli:** consolidate JSON document admission and path checks ([#13052](https://github.com/morluto/rea/issues/13052)) ([cf87e47](https://github.com/morluto/rea/commit/cf87e474eb888a2c5235c83e13a4da5b7981b439))
* **cli:** consolidate JSON settings source retention checks ([#13273](https://github.com/morluto/rea/issues/13273)) ([3fcf340](https://github.com/morluto/rea/commit/3fcf34033419ae44b319d63f30026302e10d6fa1))
* **cli:** consolidate launcher alias readiness checks ([#12827](https://github.com/morluto/rea/issues/12827)) ([53a23c0](https://github.com/morluto/rea/commit/53a23c0f0ddb3edca0a34ae29632407ab2974de0))
* **cli:** consolidate malformed setup dry-run coverage ([#12790](https://github.com/morluto/rea/issues/12790)) ([6bc96f3](https://github.com/morluto/rea/commit/6bc96f3f9900dcebd9c502592d325cd495d554ae))
* **cli:** consolidate MCP registration admission and policy checks ([#13264](https://github.com/morluto/rea/issues/13264)) ([2dfe475](https://github.com/morluto/rea/commit/2dfe4754ac7e04631f8f7d483e01d7736f8d7e9c))
* **cli:** consolidate numeric and flag admission checks ([#12933](https://github.com/morluto/rea/issues/12933)) ([48e1af5](https://github.com/morluto/rea/commit/48e1af599036463ecee3cb35f0b6f05e339d5ca0))
* **cli:** consolidate one-shot cleanup coverage ([#12781](https://github.com/morluto/rea/issues/12781)) ([49f78bd](https://github.com/morluto/rea/commit/49f78bd03b0466adc2fb1e50cb0c1cc866ce8ed5))
* **cli:** consolidate source Evidence finalization checks ([#12861](https://github.com/morluto/rea/issues/12861)) ([688d129](https://github.com/morluto/rea/commit/688d129aef5eaf8155d2d1401d86c900effb6f33))
* **cli:** consolidate xrefs admission and prove fallback identity ([#12873](https://github.com/morluto/rea/issues/12873)) ([35595de](https://github.com/morluto/rea/commit/35595de07a06bf655613fa7dfcc642c0c79d7ae1))
* **clients:** reuse setup verification for three more clients ([#14460](https://github.com/morluto/rea/issues/14460)) ([b5219e7](https://github.com/morluto/rea/commit/b5219e7d93e8fb146679afff67dfecccb8493c71))
* **clients:** share verifier message text search ([#14443](https://github.com/morluto/rea/issues/14443)) ([fda73b9](https://github.com/morluto/rea/commit/fda73b9f24ba71ad0d0f1fba3db9aa277b594a02))
* **cli:** pin which home CLI test children read ([df5caa7](https://github.com/morluto/rea/commit/df5caa7778da9b318b0dfe8faea9f25f84831af6))
* **cli:** reuse the in-process runner for schema and help checks ([#14308](https://github.com/morluto/rea/issues/14308)) ([d27eb3a](https://github.com/morluto/rea/commit/d27eb3ab240d58e0e1c0bf156113a3660e41afa5))
* **cli:** share cancellation command argument construction ([#14635](https://github.com/morluto/rea/issues/14635)) ([75f6414](https://github.com/morluto/rea/commit/75f6414cf90756905271be3e312306f43c336b6c))
* **cli:** share command results across fresh and shared processes ([#14718](https://github.com/morluto/rea/issues/14718)) ([7ffa72e](https://github.com/morluto/rea/commit/7ffa72ee599287840c7db59f9776ae0a21b9a550))
* **cli:** share rendered HTML text extraction ([#14534](https://github.com/morluto/rea/issues/14534)) ([e043558](https://github.com/morluto/rea/commit/e043558082911f22254a39aa8ff13b79fa0bc570))
* **cli:** use the registered argument schemas directly ([#14586](https://github.com/morluto/rea/issues/14586)) ([5dae66d](https://github.com/morluto/rea/commit/5dae66d5638a44ce5151b8d1abbbe1af1f7bca1d))
* **composition:** consolidate capture redaction fixtures ([#12973](https://github.com/morluto/rea/issues/12973)) ([5ca9f48](https://github.com/morluto/rea/commit/5ca9f4874b3d9adc9ca753fd97e9a72f7687a350))
* **composition:** consolidate external writer cleanup checks ([#12980](https://github.com/morluto/rea/issues/12980)) ([d7cebb7](https://github.com/morluto/rea/commit/d7cebb77a65496c8d9e7cd41bc0c6d369f22d707))
* **composition:** consolidate one-shot finalization checks ([#12977](https://github.com/morluto/rea/issues/12977)) ([fc1602e](https://github.com/morluto/rea/commit/fc1602eff4af526be7ec0e606a514ab5b62047c2))
* **composition:** consolidate queued cancellation checks ([#12981](https://github.com/morluto/rea/issues/12981)) ([7c5474d](https://github.com/morluto/rea/commit/7c5474d7cf98deda0357a48aa57b52f014ea57f5))
* **composition:** consolidate retained session liveness checks ([#12987](https://github.com/morluto/rea/issues/12987)) ([b60d6e3](https://github.com/morluto/rea/commit/b60d6e3e8d871599fe874411f55ec535fde9404a))
* **composition:** consolidate session ownership and factory checks ([#12976](https://github.com/morluto/rea/issues/12976)) ([225deea](https://github.com/morluto/rea/commit/225deea31d82492f3f66d3a460e68067e282cb55))
* **compression:** consolidate frame boundary checks ([#12818](https://github.com/morluto/rea/issues/12818)) ([6a2b575](https://github.com/morluto/rea/commit/6a2b575fa1951d3a2c2e6b64b9858ce444451041))
* **compression:** trim decoder fixture work ([14bc872](https://github.com/morluto/rea/commit/14bc8720c9a49dc35ff2aae8713f27a56218c259))
* **compression:** use a small authored framing fixture ([#12829](https://github.com/morluto/rea/issues/12829)) ([14bc872](https://github.com/morluto/rea/commit/14bc8720c9a49dc35ff2aae8713f27a56218c259))
* **config:** consolidate MCP startup budget coverage ([#12775](https://github.com/morluto/rea/issues/12775)) ([7735a4b](https://github.com/morluto/rea/commit/7735a4bca710595136d612c1e89d850cc9bb8569))
* **config:** consolidate Pwntools input limit coverage ([9b17c4a](https://github.com/morluto/rea/commit/9b17c4a4a78de06eb6fa8fa2ca6ff39a6880093d))
* **config:** consolidate regex runtime budget checks ([#12853](https://github.com/morluto/rea/issues/12853)) ([42b36e2](https://github.com/morluto/rea/commit/42b36e200b96fb02a9ab22ffd3bbc1b713af6be9))
* **config:** consolidate Rizin session capacity coverage ([#12780](https://github.com/morluto/rea/issues/12780)) ([29049fc](https://github.com/morluto/rea/commit/29049fcfd9f34f9c053c8e8cc6ef4e4bb907af79))
* **config:** remove duplicate Pwntools remediation checks ([#12797](https://github.com/morluto/rea/issues/12797)) ([9b17c4a](https://github.com/morluto/rea/commit/9b17c4a4a78de06eb6fa8fa2ca6ff39a6880093d))
* **contracts:** treat declared reference alternatives as Evidence source owners ([e9a79f6](https://github.com/morluto/rea/commit/e9a79f67a86259f10c143f5b66072b4b38bccf24))
* cover Unicode code point ordering ([6d92ca4](https://github.com/morluto/rea/commit/6d92ca438fafd72794e5aad31e2a49fbfc70eb7a))
* **cutter:** consolidate authenticated response frame coverage ([#12931](https://github.com/morluto/rea/issues/12931)) ([1bc85bc](https://github.com/morluto/rea/commit/1bc85bc215231460d389076ad6cf51e1e6c199a6))
* **cutter:** isolate verifier platform checks ([#12939](https://github.com/morluto/rea/issues/12939)) ([50d6f37](https://github.com/morluto/rea/commit/50d6f37393ee74ede18aa6d68b884a914653a2a4))
* **cutter:** keep session discovery proof at the public boundary ([#12824](https://github.com/morluto/rea/issues/12824)) ([43f884b](https://github.com/morluto/rea/commit/43f884bbfb0b2e374eb9658c9305bf2589bec17d))
* **cutter:** remove injected discovery replay ([43f884b](https://github.com/morluto/rea/commit/43f884bbfb0b2e374eb9658c9305bf2589bec17d))
* **cutter:** share empty discovery fixtures ([#14400](https://github.com/morluto/rea/issues/14400)) ([fab4e1a](https://github.com/morluto/rea/commit/fab4e1ae001d5d67f5eead43b81997a0d1768cf6))
* **cutter:** share loopback listener and descriptor fixtures ([#14578](https://github.com/morluto/rea/issues/14578)) ([4265398](https://github.com/morluto/rea/commit/42653985e14841bb2866c8e26db50dcb0c7931ce))
* **cutter:** use account home for default bridge assertions ([#12728](https://github.com/morluto/rea/issues/12728)) ([44e8e72](https://github.com/morluto/rea/commit/44e8e72db12a3787b02b8216bb3a1dd69dd668e2))
* **cutter:** use shared verifier deadlines ([#12943](https://github.com/morluto/rea/issues/12943)) ([bb48a7b](https://github.com/morluto/rea/commit/bb48a7b3f8af177d6849c1dfd496b76220a2a561))
* **debugger:** consolidate runtime setting recovery coverage ([#13042](https://github.com/morluto/rea/issues/13042)) ([67f8094](https://github.com/morluto/rea/commit/67f8094efaa220b354f032d607b56f3126950bf2))
* **debugger:** consolidate startup descriptor ownership checks ([#13028](https://github.com/morluto/rea/issues/13028)) ([fb873fe](https://github.com/morluto/rea/commit/fb873feaeb928c692ee074784846a9f41c1d3b79))
* **deno:** consolidate physical ELF note ownership checks ([#13414](https://github.com/morluto/rea/issues/13414)) ([59ac8e5](https://github.com/morluto/rea/commit/59ac8e5a836e11adb6879f10519ff0da9aa5b8e8))
* **deno:** consolidate remote paths and region limits ([#13410](https://github.com/morluto/rea/issues/13410)) ([466c552](https://github.com/morluto/rea/commit/466c552d16a3a83bd4216b4531e3f7f189cb766e))
* **desktop:** consolidate archive task and reader coverage ([#13419](https://github.com/morluto/rea/issues/13419)) ([ec56d1b](https://github.com/morluto/rea/commit/ec56d1b020702dce16fda4b3da512da694fb1c33))
* **desktop:** consolidate library resolution and closure coverage ([#13443](https://github.com/morluto/rea/issues/13443)) ([e193596](https://github.com/morluto/rea/commit/e193596a608d5711ff534a3d87fddf0ea5b8762b))
* **desktop:** consolidate passive loader identity and ownership checks ([#13544](https://github.com/morluto/rea/issues/13544)) ([84958d6](https://github.com/morluto/rea/commit/84958d6473bc42b9d2aec0344f490775ce537751))
* **desktop:** keep TryExec regression independent of ID masking group ([b3dfd53](https://github.com/morluto/rea/commit/b3dfd5305dc254e177d16ce1675a672857b0b391))
* **desktop:** verify cancellation before releasing the guest ([#12812](https://github.com/morluto/rea/issues/12812)) ([c94f275](https://github.com/morluto/rea/commit/c94f275667e8d9402d34bcddb61abe0393302685))
* **diagnostics:** share invalid inspection input assertions ([#14501](https://github.com/morluto/rea/issues/14501)) ([4bcd0af](https://github.com/morluto/rea/commit/4bcd0af58ca4bbea1fdb2b47698fb619bb274653))
* **docs:** check doc facts structurally instead of pinning prose ([#14207](https://github.com/morluto/rea/issues/14207)) ([6adcf85](https://github.com/morluto/rea/commit/6adcf85fc8cf68635fd3416029e89d424c648220))
* **docs:** isolate README drift cases and remove duplicate checks ([ce52580](https://github.com/morluto/rea/commit/ce5258043c47483d2c8db9a3c0b8f369542bed73))
* **doctor:** reuse scope checks and Ubuntu host fixtures ([#14401](https://github.com/morluto/rea/issues/14401)) ([ac732d5](https://github.com/morluto/rea/commit/ac732d5b24418ebdb33daddd4592597f809baa1a))
* **domain:** share absolute path schema cases ([#14549](https://github.com/morluto/rea/issues/14549)) ([54a02d6](https://github.com/morluto/rea/commit/54a02d68c6957114fc2ad0fa2525eebab17c6c5c))
* **dotnet:** consolidate malformed metadata and table stream proofs ([#13374](https://github.com/morluto/rea/issues/13374)) ([0c0130c](https://github.com/morluto/rea/commit/0c0130ce509e59869a115477ab38d203bbc780bd))
* **dotnet:** consolidate managed ExtraData coverage ([#12788](https://github.com/morluto/rea/issues/12788)) ([e8105d6](https://github.com/morluto/rea/commit/e8105d6be9c5b96a0635f09e0eeef9672f112e8f))
* **dotnet:** consolidate managed PE and field constant contracts ([#13365](https://github.com/morluto/rea/issues/13365)) ([da6f898](https://github.com/morluto/rea/commit/da6f89808dcc9c6f528660426a54cff721cfbf03))
* **dotnet:** prove scoped member ownership within the caller budget ([#13369](https://github.com/morluto/rea/issues/13369)) ([2e8bdfd](https://github.com/morluto/rea/commit/2e8bdfd808b3de68cbd283b3f4f5510ee728a288))
* **dotnet:** share metadata layout reads for managed PE fixtures ([#14807](https://github.com/morluto/rea/issues/14807)) ([68e66e3](https://github.com/morluto/rea/commit/68e66e3c1f34762387398028d5414e5e592140e7))
* **dotnet:** stop expecting required_value for the lower-bound path-depth refusal ([d21ba43](https://github.com/morluto/rea/commit/d21ba43581cd64531cd43a56b691141b02918e63))
* **dotnet:** use smaller fixtures for managed byte budgets ([#12793](https://github.com/morluto/rea/issues/12793)) ([337fd43](https://github.com/morluto/rea/commit/337fd43a0f91aa63c9697fd5dc912f7807454ba3))
* drop detail requests the budget seed made redundant ([#14615](https://github.com/morluto/rea/issues/14615)) ([88fd8a9](https://github.com/morluto/rea/commit/88fd8a9df083568a7cb4a65012f1b9813c5b82b1))
* **electron:** consolidate action and projection coverage ([#12959](https://github.com/morluto/rea/issues/12959)) ([32e5f5b](https://github.com/morluto/rea/commit/32e5f5bc1c26281656d6d2a17e14308c8eba05ce))
* **electron:** consolidate capture cleanup coverage ([#12958](https://github.com/morluto/rea/issues/12958)) ([6d74dbe](https://github.com/morluto/rea/commit/6d74dbe5ccacfd423a295b696cdb1b298d64c2dc))
* **electron:** consolidate direct IPC listener removal coverage ([#12962](https://github.com/morluto/rea/issues/12962)) ([a125d37](https://github.com/morluto/rea/commit/a125d37bfad92fc3b5e472c6c18ee71654037221))
* **electron:** consolidate file admission and cleanup coverage ([#12953](https://github.com/morluto/rea/issues/12953)) ([2bac1b5](https://github.com/morluto/rea/commit/2bac1b5addad654dc5f8f33c48d909d75d3c1aa6))
* **electron:** consolidate fuse preflight coverage ([#12957](https://github.com/morluto/rea/issues/12957)) ([8d2eb16](https://github.com/morluto/rea/commit/8d2eb16710ee7e32215c11d6fc3ea2dff5b26b1e))
* **electron:** consolidate hook dispatch and effect checks ([#12961](https://github.com/morluto/rea/issues/12961)) ([16f7cd0](https://github.com/morluto/rea/commit/16f7cd067802556df00f0bcd6c20976edad906a6))
* **electron:** consolidate IPC bulk removal coverage ([#12968](https://github.com/morluto/rea/issues/12968)) ([553ea84](https://github.com/morluto/rea/commit/553ea84eb67303fc210041af5047fc94540c8bd9))
* **electron:** consolidate IPC dispatch fixtures ([#12963](https://github.com/morluto/rea/issues/12963)) ([4d65eb9](https://github.com/morluto/rea/commit/4d65eb95f114e652a5ceeb78e6538a81b6caaae9))
* **electron:** consolidate IPC registration metadata coverage ([#12964](https://github.com/morluto/rea/issues/12964)) ([87b773c](https://github.com/morluto/rea/commit/87b773c3d65ee32189ec843335b598f23f2a7dce))
* **electron:** consolidate linked listener removal coverage ([#12974](https://github.com/morluto/rea/issues/12974)) ([03f4bb4](https://github.com/morluto/rea/commit/03f4bb4c0d3e33b10952a28d80d20861f73da154))
* **electron:** consolidate malformed CDP reply coverage ([#12955](https://github.com/morluto/rea/issues/12955)) ([fd4d607](https://github.com/morluto/rea/commit/fd4d6076d525af493f3d8b7755ffa8a0e65d5158))
* **electron:** consolidate reentrant listener removal coverage ([#12971](https://github.com/morluto/rea/issues/12971)) ([555bcdd](https://github.com/morluto/rea/commit/555bcdd40f15c751a206fc88e90afac639353394))
* **electron:** consolidate session and shell policy coverage ([#12969](https://github.com/morluto/rea/issues/12969)) ([0fda383](https://github.com/morluto/rea/commit/0fda3835e1c050e0f455b6f828e820c81d510108))
* **electron:** isolate hook argument ownership checks ([#12960](https://github.com/morluto/rea/issues/12960)) ([e3891b9](https://github.com/morluto/rea/commit/e3891b9f1ab549fe2cb7169e6f075b6033fe2769))
* **electron:** isolate live verifier profiles and reuse evidence ([#12970](https://github.com/morluto/rea/issues/12970)) ([29bf76b](https://github.com/morluto/rea/commit/29bf76bfc37de03c0839170a255784578e96818b))
* **electron:** use shared transport shutdown waits ([#12954](https://github.com/morluto/rea/issues/12954)) ([3d95d34](https://github.com/morluto/rea/commit/3d95d342a4479f92d9242995d2482e75be908128))
* **elf:** assert retained reports during descriptor finalization ([3cb9042](https://github.com/morluto/rea/commit/3cb904282f16cb6fdf509ba84203f89eefa015cc))
* **elf:** consolidate debug-link candidate coverage ([#12851](https://github.com/morluto/rea/issues/12851)) ([3dacda3](https://github.com/morluto/rea/commit/3dacda36f200cb0dbdfde85f3f5589566e718552))
* **elf:** join the paused dependency parser on failure ([40200ae](https://github.com/morluto/rea/commit/40200aea6f2cab98f142a2c0144e25d806e5153f))
* **elf:** write caller-chosen dynamic rows in unwind fixtures ([a9180c0](https://github.com/morluto/rea/commit/a9180c0dfe3090ec1bdc55991e8697b8bcd72e99))
* **environment:** check replay accounting with real retention budgets ([#13405](https://github.com/morluto/rea/issues/13405)) ([1461e52](https://github.com/morluto/rea/commit/1461e52f2bd12627d9809599d10b7be8006fac70))
* **environment:** consolidate learned route matching checks ([#12809](https://github.com/morluto/rea/issues/12809)) ([9bca53f](https://github.com/morluto/rea/commit/9bca53f96ec9701c3afe49c9eb8a88f01d1150c3))
* **environment:** consolidate manifest template proof ([#13859](https://github.com/morluto/rea/issues/13859)) ([b707c40](https://github.com/morluto/rea/commit/b707c405d8b8449bf770303f14194290f82f4098))
* **environment:** consolidate replay overwrite and adoption checks ([#13406](https://github.com/morluto/rea/issues/13406)) ([29efae3](https://github.com/morluto/rea/commit/29efae350eb9fc0d63648c832993f7bff689ec48))
* **environment:** consolidate replay timing and write evidence checks ([#13403](https://github.com/morluto/rea/issues/13403)) ([94088c9](https://github.com/morluto/rea/commit/94088c9677b75b998431cff3d889222707c5e66c))
* **environment:** remove duplicate collection path checks ([9bca53f](https://github.com/morluto/rea/commit/9bca53f96ec9701c3afe49c9eb8a88f01d1150c3))
* **erlang:** consolidate BEAM atom layout coverage ([98c3fad](https://github.com/morluto/rea/commit/98c3fad24d95fd8cb1f87f0c8336a2776af09bb4))
* **erlang:** consolidate Beam atom layout coverage ([#12795](https://github.com/morluto/rea/issues/12795)) ([98c3fad](https://github.com/morluto/rea/commit/98c3fad24d95fd8cb1f87f0c8336a2776af09bb4))
* **erlang:** consolidate BEAM budget and truncation coverage ([#12830](https://github.com/morluto/rea/issues/12830)) ([01895d3](https://github.com/morluto/rea/commit/01895d33efd70d3291e91e89907db058e90b135e))
* **erlang:** consolidate BEAM limit and truncation checks ([01895d3](https://github.com/morluto/rea/commit/01895d33efd70d3291e91e89907db058e90b135e))
* **errors:** consolidate projection and cleanup contracts ([#13304](https://github.com/morluto/rea/issues/13304)) ([2c6c9d7](https://github.com/morluto/rea/commit/2c6c9d76caac395ba9903e5c53736e8ebaf4913a))
* **evaluation:** consolidate NativeAOT retry verification ([b9bcfa4](https://github.com/morluto/rea/commit/b9bcfa4041d01746534974dbb4c8658920906a7a))
* **evaluation:** consolidate recording comparison fixtures ([b20f857](https://github.com/morluto/rea/commit/b20f8576f27f5dc8ee3fc06ac56ee0f2c57159ee))
* **evaluation:** consolidate report verdict and output checks ([#12882](https://github.com/morluto/rea/issues/12882)) ([4449d13](https://github.com/morluto/rea/commit/4449d13047f6ef04153b3465baf03afa617859ed))
* **evaluation:** consolidate transcript and claim grounding checks ([#12883](https://github.com/morluto/rea/issues/12883)) ([c2c8ad3](https://github.com/morluto/rea/commit/c2c8ad3d701e4ca7384cb6bb541e3b36c0d34a76))
* **evidence:** avoid recursive matching at the recorded array depth limit ([#12819](https://github.com/morluto/rea/issues/12819)) ([edf33a4](https://github.com/morluto/rea/commit/edf33a448b4f0a1fc3e757d37ff5365ff63a8942))
* **evidence:** consolidate analysis view source failure coverage ([#13461](https://github.com/morluto/rea/issues/13461)) ([72a227d](https://github.com/morluto/rea/commit/72a227d56f8bd1beec1ab97344f2a02cc034a4c0))
* **evidence:** consolidate bundle authentication and cleanup coverage ([#13521](https://github.com/morluto/rea/issues/13521)) ([d979c18](https://github.com/morluto/rea/commit/d979c1849c897a1da7b42095266e9b76b484fc1a))
* **evidence:** consolidate bundle comparison proof at the MCP boundary ([#12813](https://github.com/morluto/rea/issues/12813)) ([adb8e2e](https://github.com/morluto/rea/commit/adb8e2ea35877ccccfa68678289a7a4997c04c14))
* **evidence:** consolidate composed workflow provenance checks ([#12975](https://github.com/morluto/rea/issues/12975)) ([0e70522](https://github.com/morluto/rea/commit/0e70522b6d796cabe3d10da4a110e99107e72fb9))
* **evidence:** consolidate input admission and schema examples ([#13322](https://github.com/morluto/rea/issues/13322)) ([2718131](https://github.com/morluto/rea/commit/27181314cbd37809a2090f7c8a9de3251152c70f))
* **evidence:** consolidate investigation record coverage ([#12978](https://github.com/morluto/rea/issues/12978)) ([d184c20](https://github.com/morluto/rea/commit/d184c208f312826dd85acea804c01af3e58a10f6))
* **evidence:** consolidate native routing and identity refusal checks ([bf77776](https://github.com/morluto/rea/commit/bf77776873b6fa5b8a72d39f8a701fed4de6de46))
* **evidence:** consolidate native routing and identity refusals ([#13054](https://github.com/morluto/rea/issues/13054)) ([bf77776](https://github.com/morluto/rea/commit/bf77776873b6fa5b8a72d39f8a701fed4de6de46))
* **evidence:** consolidate public bundle delivery and import checks ([#13543](https://github.com/morluto/rea/issues/13543)) ([933cd83](https://github.com/morluto/rea/commit/933cd8382c15bdb433dc2ad1fc7fdae2aca4b7fd))
* **evidence:** distinguish legacy format from schema refusal ([#13045](https://github.com/morluto/rea/issues/13045)) ([184e9c0](https://github.com/morluto/rea/commit/184e9c083cd58a13ef03c89f45f3fff2acad0654))
* **evidence:** verify request admission and retained display ownership ([#13053](https://github.com/morluto/rea/issues/13053)) ([0c3e1d6](https://github.com/morluto/rea/commit/0c3e1d69aa862e66f032959dcbf80cae2e8ceed6))
* **filesystem:** consolidate stable hash and descriptor ownership checks ([#12879](https://github.com/morluto/rea/issues/12879)) ([79bd830](https://github.com/morluto/rea/commit/79bd830f4e4514e3cabf4af7fa9b2b26076d080a))
* **filesystem:** release the lease after simulated device changes ([#14731](https://github.com/morluto/rea/issues/14731)) ([b343218](https://github.com/morluto/rea/commit/b3432183571dd9e7b4cdd82b7b9142edd8c0af51))
* **filesystem:** restore directory modes after permission-denial checks ([#14751](https://github.com/morluto/rea/issues/14751)) ([657c69a](https://github.com/morluto/rea/commit/657c69abd6c52109de8589436f6bf52659988ddf))
* **filesystem:** share invalid file selection assertions ([#14313](https://github.com/morluto/rea/issues/14313)) ([8730a1d](https://github.com/morluto/rea/commit/8730a1d49a4d61e915cf57a3363784de97b6fdac))
* **filesystem:** verify commit cancellation closes its parent descriptor ([#12814](https://github.com/morluto/rea/issues/12814)) ([84ee3c1](https://github.com/morluto/rea/commit/84ee3c1edc7930360d6004d33baab0a4ebe7c5f7))
* **firmware:** consolidate extraction report ownership checks ([#13351](https://github.com/morluto/rea/issues/13351)) ([734ef0f](https://github.com/morluto/rea/commit/734ef0f9b2a450514a56ed9f2b2945878d37f98c))
* **firmware:** consolidate HEX wire limits and public inspection ([#13376](https://github.com/morluto/rea/issues/13376)) ([7aa15c4](https://github.com/morluto/rea/commit/7aa15c4ac76ea7472404236462f07ac1a433b945))
* **firmware:** consolidate OTA integrity and transport proof ([#13381](https://github.com/morluto/rea/issues/13381)) ([c001100](https://github.com/morluto/rea/commit/c001100e57dda8eefb8d488be62d506046c69059))
* **firmware:** consolidate parsing and process-limit checks ([#12844](https://github.com/morluto/rea/issues/12844)) ([67a55ea](https://github.com/morluto/rea/commit/67a55ea8e15e8a774cba46d69fe8c6f151cba489))
* **firmware:** consolidate split OTA partition order coverage ([68ed9b0](https://github.com/morluto/rea/commit/68ed9b0e67573c1dd0f4bca83977f1240fef682e))
* **firmware:** consolidate staging and resource recovery checks ([#13358](https://github.com/morluto/rea/issues/13358)) ([2209acc](https://github.com/morluto/rea/commit/2209acc82424bee01512419bee02e9613aa3392c))
* **firmware:** consolidate UF2 numbering and shared reader identity ([#13372](https://github.com/morluto/rea/issues/13372)) ([e9dead7](https://github.com/morluto/rea/commit/e9dead75ea7efd3567e80cf84a79b40fe3883c51))
* **firmware:** observe decoded region descriptor settlement ([#13378](https://github.com/morluto/rea/issues/13378)) ([ac7ae19](https://github.com/morluto/rea/commit/ac7ae19cb23c9dc2380b08381ca96e073620ad1e))
* **fixtures:** let each test clean up its own temporary directories ([#14805](https://github.com/morluto/rea/issues/14805)) ([a3a4771](https://github.com/morluto/rea/commit/a3a4771918d7518ecbd145ed50d99fa503f434ca))
* **fixtures:** reuse binary fixture encoders ([#14575](https://github.com/morluto/rea/issues/14575)) ([aed2bf8](https://github.com/morluto/rea/commit/aed2bf8826f8822d6c414b587da2c88ad58be305))
* **fixtures:** share byte digest calculations ([#14564](https://github.com/morluto/rea/issues/14564)) ([edca378](https://github.com/morluto/rea/commit/edca3783ca62065aa50b4faf2622bd02b8442e48))
* **fixtures:** share literal-only LZ4 blocks across fixture builders ([#14696](https://github.com/morluto/rea/issues/14696)) ([0771d11](https://github.com/morluto/rea/commit/0771d11c7f9dddd5983a85e4335d2e0f4f7785c4))
* **fixtures:** share little-endian integer buffers ([#14432](https://github.com/morluto/rea/issues/14432)) ([1e5cdbc](https://github.com/morluto/rea/commit/1e5cdbc7ee10118dde862e904b2b537e886bf35a))
* **fixtures:** use per-test cleanup in catalog suites ([#14815](https://github.com/morluto/rea/issues/14815)) ([5c49ebc](https://github.com/morluto/rea/commit/5c49ebcf1097ecc12d79ee8a67ee22ac6786de46))
* **flutter:** consolidate ELF and snapshot header checks ([#13595](https://github.com/morluto/rea/issues/13595)) ([2d65688](https://github.com/morluto/rea/commit/2d65688ac79ebe9b625d2620e4bb2bfc6ffd1b5e))
* **formats:** consolidate BEAM and DOL boundary checks ([#12832](https://github.com/morluto/rea/issues/12832)) ([c9caa0a](https://github.com/morluto/rea/commit/c9caa0aa5b60e049ac5284b7f9efaad4d793c3ff))
* **gdb:** consolidate inferior terminal admission checks ([#13011](https://github.com/morluto/rea/issues/13011)) ([c235b61](https://github.com/morluto/rea/commit/c235b6160ee25704926fac30f137dcb503a58f2a))
* **gdb:** consolidate MI inventory and field projection checks ([#13009](https://github.com/morluto/rea/issues/13009)) ([d93a199](https://github.com/morluto/rea/commit/d93a199629c2a2837e9d6d19bb92b36bcdc6f514))
* **gdb:** consolidate queue capacity and cancellation checks ([#13017](https://github.com/morluto/rea/issues/13017)) ([7966097](https://github.com/morluto/rea/commit/7966097e873263ec459a7eb1acfa658e32370f06))
* **gdb:** consolidate session lifecycle and fixture checks ([#13015](https://github.com/morluto/rea/issues/13015)) ([e3b8188](https://github.com/morluto/rea/commit/e3b8188363e504996d9c91b57bb2a5d1ca20ff9c))
* **gdb:** consolidate startup preflight and deadline checks ([#13013](https://github.com/morluto/rea/issues/13013)) ([d7981cc](https://github.com/morluto/rea/commit/d7981cce4ce081c51c36540ee1b221ac9a4e4628))
* **ghidra:** compare native value graphs by cited procedure across adapters ([72d6d27](https://github.com/morluto/rea/commit/72d6d275d4456f21f256c2e88bf5daa01bf6986e))
* **ghidra:** consolidate ABI profile and handshake coverage ([#12924](https://github.com/morluto/rea/issues/12924)) ([41e9997](https://github.com/morluto/rea/commit/41e99972894ddb509a4335b4bca82881816866da))
* **ghidra:** consolidate bounded failure projection coverage ([#12912](https://github.com/morluto/rea/issues/12912)) ([9d37cba](https://github.com/morluto/rea/commit/9d37cba9c7d6a27244ab185e2265808666516cb0))
* **ghidra:** consolidate checkpoint publication and restore coverage ([#12930](https://github.com/morluto/rea/issues/12930)) ([a516a85](https://github.com/morluto/rea/commit/a516a8533e68deea8a2ac3c245aca10ab763fd11))
* **ghidra:** consolidate disabled analyzer admission coverage ([#12917](https://github.com/morluto/rea/issues/12917)) ([a9f8c70](https://github.com/morluto/rea/commit/a9f8c70dbf0cefa606dc2c76497ea3c9c0b68d87))
* **ghidra:** consolidate endpoint finalization and launch rollback coverage ([#12908](https://github.com/morluto/rea/issues/12908)) ([0bca5db](https://github.com/morluto/rea/commit/0bca5dbbe8b1bda63cf532304d99dd4e51cfe27f))
* **ghidra:** consolidate function observation evidence coverage ([#12932](https://github.com/morluto/rea/issues/12932)) ([82cb3d0](https://github.com/morluto/rea/commit/82cb3d040b734569d9a607b3c44c1f088a7ab566))
* **ghidra:** consolidate inventory Evidence and byte coverage ([#12922](https://github.com/morluto/rea/issues/12922)) ([9c3ab4a](https://github.com/morluto/rea/commit/9c3ab4a0dfff1ca80484fc366d619b4a4860fcae))
* **ghidra:** consolidate launcher and JDK discovery coverage ([#12909](https://github.com/morluto/rea/issues/12909)) ([6c5f0ae](https://github.com/morluto/rea/commit/6c5f0ae6f6444abe2b8f8de44c21c76f71fb69fe))
* **ghidra:** consolidate launcher diagnostic coverage ([#12794](https://github.com/morluto/rea/issues/12794)) ([c348fe7](https://github.com/morluto/rea/commit/c348fe7fe0acd3b51614014d2766817e0872fe58))
* **ghidra:** consolidate literal search boundary coverage ([#12925](https://github.com/morluto/rea/issues/12925)) ([5f9e931](https://github.com/morluto/rea/commit/5f9e9313651feeacd228ca1a1cbf6a714754cdac))
* **ghidra:** consolidate load-image snapshot attestation ([#12926](https://github.com/morluto/rea/issues/12926)) ([7d31b97](https://github.com/morluto/rea/commit/7d31b974567a8d89c435b77fa22036bc2728ff61))
* **ghidra:** consolidate PE PDB provenance coverage ([#12919](https://github.com/morluto/rea/issues/12919)) ([76585bc](https://github.com/morluto/rea/commit/76585bc08506ba154e267b09590e7f2210380e64))
* **ghidra:** consolidate raw profile and packaged producer proof ([#13379](https://github.com/morluto/rea/issues/13379)) ([64d42d2](https://github.com/morluto/rea/commit/64d42d297132ebd52f00a99dea7b0b2dc8c4f916))
* **ghidra:** consolidate request recovery assertions ([#12916](https://github.com/morluto/rea/issues/12916)) ([c8b9382](https://github.com/morluto/rea/commit/c8b938252d914d550cb45e646a0820632e9da492))
* **ghidra:** consolidate saved project selection and history ([#12920](https://github.com/morluto/rea/issues/12920)) ([d1242fa](https://github.com/morluto/rea/commit/d1242fa30b2c9d18631fc2f37b2a1d615f92a9af))
* **ghidra:** consolidate seed commitment and report coverage ([#12918](https://github.com/morluto/rea/issues/12918)) ([73e1b67](https://github.com/morluto/rea/commit/73e1b675163841a9da34c1284f00f45f1f443a9f))
* **ghidra:** consolidate session authority checks ([#13367](https://github.com/morluto/rea/issues/13367)) ([6050e08](https://github.com/morluto/rea/commit/6050e0882aae14adc0dee4f6d3ddf9d24aeb4d00))
* **ghidra:** consolidate session temporary resource coverage ([#12913](https://github.com/morluto/rea/issues/12913)) ([048a376](https://github.com/morluto/rea/commit/048a3765a4f208fcc1b82ee23dd3ccef1467fde6))
* **ghidra:** consolidate wire admission and shutdown checks ([#13044](https://github.com/morluto/rea/issues/13044)) ([8ffbebd](https://github.com/morluto/rea/commit/8ffbebd3c8bf7774d4c430345d7c751838b1a843))
* **ghidra:** forward the caller locale to native value verifier children ([8acf5e3](https://github.com/morluto/rea/commit/8acf5e33a1f1f9e2431ddc8bda26321571fbf3a0))
* **ghidra:** prove metadata descriptor and probe admission ([fd3f10a](https://github.com/morluto/rea/commit/fd3f10a0eb4ae0acbd6f4ca7a6975bb430775cbc))
* **ghidra:** read complete Evidence in boundary CLI comparisons ([afd860e](https://github.com/morluto/rea/commit/afd860ec1b2fba5d873931a0bce7f88dee0f779b))
* **ghidra:** share the fixed-result ELF client fixture ([#14601](https://github.com/morluto/rea/issues/14601)) ([66557c8](https://github.com/morluto/rea/commit/66557c843f216bc67af1913093b5a73f0e6d8420))
* **ghidra:** stage startup failure and interruption proofs ([#13748](https://github.com/morluto/rea/issues/13748)) ([6fa4f33](https://github.com/morluto/rea/commit/6fa4f337b3423f02134bbfef9467780d7a0abe21))
* **ghidra:** stop the fixture child in the close-during-cleanup regression ([d057ce4](https://github.com/morluto/rea/commit/d057ce45e4fcded5ad12fb912ebd978a1cc5c763))
* **ghidra:** synchronize import descriptor finalization ([#13370](https://github.com/morluto/rea/issues/13370)) ([7c8493d](https://github.com/morluto/rea/commit/7c8493d41d87a5ed29c28b0accd8382d17739d3d))
* **ghidra:** verify checkpoint storage and publication retry ([#12914](https://github.com/morluto/rea/issues/12914)) ([b2f55fa](https://github.com/morluto/rea/commit/b2f55fab50c1e3181d380c16d69d13c7c201f6bf))
* **ghidra:** verify metadata reads and doctor probe admission ([#12911](https://github.com/morluto/rea/issues/12911)) ([fd3f10a](https://github.com/morluto/rea/commit/fd3f10a0eb4ae0acbd6f4ca7a6975bb430775cbc))
* **ghidra:** verify the bare unmapped selector rejection against real Ghidra ([66b8e7b](https://github.com/morluto/rea/commit/66b8e7b2e482cb60d9694996efc45beb6de024d4))
* **ghidra:** verify the full checkpoint digest on publication ([b2f55fa](https://github.com/morluto/rea/commit/b2f55fab50c1e3181d380c16d69d13c7c201f6bf))
* give CLI and MCP test children an owned home ([6e5b6f1](https://github.com/morluto/rea/commit/6e5b6f1ede5477981bc745a11e5b9676337d51d5))
* **go:** check build information in a one-directory PE32 fixture ([#14303](https://github.com/morluto/rea/issues/14303)) ([1a407cc](https://github.com/morluto/rea/commit/1a407cc645b8fc01a7ab4c721d1b494f1f61cf65))
* **go:** consolidate image metadata and extent checks ([#12859](https://github.com/morluto/rea/issues/12859)) ([96d7946](https://github.com/morluto/rea/commit/96d79460db1483b28aaaee55234125bb9f818293))
* **go:** consolidate native pointer mapping coverage ([#13449](https://github.com/morluto/rea/issues/13449)) ([87180a8](https://github.com/morluto/rea/commit/87180a86d9e8c28cdb2207e96e4f39facf22c9eb))
* **go:** consolidate retained metadata views ([#12875](https://github.com/morluto/rea/issues/12875)) ([aa84c59](https://github.com/morluto/rea/commit/aa84c59d8b8eed8822295a4c029bd0c282b91c52))
* **go:** expect loader-equivalent PE header facts in the MZ diagnostics ([#14293](https://github.com/morluto/rea/issues/14293)) ([a43bfa6](https://github.com/morluto/rea/commit/a43bfa62ee35aa5fb2c1e710bb390adcd5bc7b46))
* **go:** shrink cumulative header search fixtures ([#12800](https://github.com/morluto/rea/issues/12800)) ([fce3470](https://github.com/morluto/rea/commit/fce34706dd0e8175a9121a20e8b67e96f3f79984))
* **gpu:** consolidate AMD note provenance coverage ([#13568](https://github.com/morluto/rea/issues/13568)) ([61c7f2b](https://github.com/morluto/rea/commit/61c7f2b47f5da5de298b5d7bc05d30431feae69c))
* **guards:** verify CLI prose exemptions independently ([#12828](https://github.com/morluto/rea/issues/12828)) ([9af5501](https://github.com/morluto/rea/commit/9af55017cf508a49b9cb49d18000380edb670ea3))
* **guidance:** consolidate search and locator contracts ([#13312](https://github.com/morluto/rea/issues/13312)) ([ae4e0c8](https://github.com/morluto/rea/commit/ae4e0c83dd327076501d2f8fdb801e1bde4ae09d))
* **har:** consolidate producer and evidence coverage ([#13202](https://github.com/morluto/rea/issues/13202)) ([1c982b8](https://github.com/morluto/rea/commit/1c982b82fea64a1562d2dc1a863e4ec76dccee9d))
* **hopper:** consolidate host and launcher selection coverage ([#12934](https://github.com/morluto/rea/issues/12934)) ([6d895a9](https://github.com/morluto/rea/commit/6d895a9e8b7615e441fc0230382ae3af798ffb1f))
* **hopper:** consolidate launcher failure and provenance checks ([#12877](https://github.com/morluto/rea/issues/12877)) ([d3c29cd](https://github.com/morluto/rea/commit/d3c29cddb68a60e5cc2794bda4337f0bb762f15e))
* **hopper:** queue bridge reconnects before closing the previous client ([#13325](https://github.com/morluto/rea/issues/13325)) ([5b1bc26](https://github.com/morluto/rea/commit/5b1bc26c37847f16ea616d08b6aeb60aa77cc264))
* **hopper:** share the dialog window fixture ([#14556](https://github.com/morluto/rea/issues/14556)) ([9200a2a](https://github.com/morluto/rea/commit/9200a2ab5a1c463626271297ae7d195a6fec3b5c))
* **ida:** consolidate advertised observation and effect checks ([#13008](https://github.com/morluto/rea/issues/13008)) ([9bb06b2](https://github.com/morluto/rea/commit/9bb06b29caa081d3aed924135df8a5910c33b306))
* **ida:** consolidate callee batch and evidence coverage ([#12929](https://github.com/morluto/rea/issues/12929)) ([f505759](https://github.com/morluto/rea/commit/f505759dd6a4675e7fc06e97cdfd66cea63096b7))
* **ida:** consolidate callee coverage across graph and trace ([#12927](https://github.com/morluto/rea/issues/12927)) ([ed42b4f](https://github.com/morluto/rea/commit/ed42b4f17999ad36fb3146ab6d46a3e6f30ba878))
* **ida:** consolidate containment and address context checks ([#12996](https://github.com/morluto/rea/issues/12996)) ([40c2163](https://github.com/morluto/rea/commit/40c21638e51a2075f2e0488482bd2d67205c091d))
* **ida:** consolidate diagnostic redaction checks ([#13002](https://github.com/morluto/rea/issues/13002)) ([0d1f40b](https://github.com/morluto/rea/commit/0d1f40bf2a9440d3f36e13513af080ac601b4607))
* **ida:** consolidate HTTP diagnostic format checks ([#13000](https://github.com/morluto/rea/issues/13000)) ([765ee73](https://github.com/morluto/rea/commit/765ee73094f1cb129935ca452a420419504eee24))
* **ida:** consolidate input and workspace validation checks ([#13001](https://github.com/morluto/rea/issues/13001)) ([0b29fc3](https://github.com/morluto/rea/commit/0b29fc37f837c32760718b207c95e1e6c8322972))
* **ida:** consolidate native result precedence checks ([#12999](https://github.com/morluto/rea/issues/12999)) ([8ce8376](https://github.com/morluto/rea/commit/8ce837662b3aeb7144edd93484675a1ec27bef2d))
* **ida:** consolidate readiness and regex deadline checks ([#12992](https://github.com/morluto/rea/issues/12992)) ([809e6bb](https://github.com/morluto/rea/commit/809e6bbafd7815c7767b4e2f1ff9c61f7453e93e))
* **ida:** consolidate registration and profile selection checks ([#12998](https://github.com/morluto/rea/issues/12998)) ([3746764](https://github.com/morluto/rea/commit/37467640cb0fadfc908b7c48bc481b8834b41456))
* **ida:** consolidate registration composition fixtures ([#12989](https://github.com/morluto/rea/issues/12989)) ([b5db321](https://github.com/morluto/rea/commit/b5db3218a20036169df0be8242dc8db2f37327e0))
* **ida:** consolidate relationship routing and coverage checks ([#12995](https://github.com/morluto/rea/issues/12995)) ([10789bc](https://github.com/morluto/rea/commit/10789bc4c1de2611baff34026e4e24e9b38cf407))
* **ida:** consolidate selector errors and partial evidence checks ([#12997](https://github.com/morluto/rea/issues/12997)) ([a2b5a32](https://github.com/morluto/rea/commit/a2b5a321639076bb29c8e5bc02bdc58f5c8af749))
* **ida:** consolidate startup diagnostics and remove fixture waits ([#12994](https://github.com/morluto/rea/issues/12994)) ([a93f558](https://github.com/morluto/rea/commit/a93f558d0ea7ba8607b87cdfdd26ee8938f7c5e0))
* **ida:** consolidate verifier admission and oracle checks ([#13003](https://github.com/morluto/rea/issues/13003)) ([6cf4328](https://github.com/morluto/rea/commit/6cf432865676df308bc7ba6cd29b6688a4c66753))
* **ida:** consolidate worker release and retry checks ([#12993](https://github.com/morluto/rea/issues/12993)) ([4df6b37](https://github.com/morluto/rea/commit/4df6b371b08bdc219a0d90d13605a99319c65d73))
* **ida:** consolidate workspace copy and release checks ([#12991](https://github.com/morluto/rea/issues/12991)) ([8fefe18](https://github.com/morluto/rea/commit/8fefe18381bf69b3785c9ae4195067c0ef7ba076))
* **ida:** decode the Hex-Rays query line without importing site ([#14144](https://github.com/morluto/rea/issues/14144)) ([3a63f78](https://github.com/morluto/rea/commit/3a63f7803f98dc57dfc5a6205bb8a0a22c89a40d))
* **ida:** remove unused target setup from configuration checks ([#12821](https://github.com/morluto/rea/issues/12821)) ([e023c9f](https://github.com/morluto/rea/commit/e023c9fe5451b41d6f88843fd1b250b375fc5376))
* **ida:** use owned configuration fixtures ([e023c9f](https://github.com/morluto/rea/commit/e023c9fe5451b41d6f88843fd1b250b375fc5376))
* **il2cpp:** consolidate retained metadata projection coverage ([#12870](https://github.com/morluto/rea/issues/12870)) ([cfc1644](https://github.com/morluto/rea/commit/cfc1644238016a78bb31c122561849698df4f29b))
* **il2cpp:** consolidate section geometry and prefix checks ([#12863](https://github.com/morluto/rea/issues/12863)) ([7e2e4d4](https://github.com/morluto/rea/commit/7e2e4d41f5d0e0d17682576f8b0a5a220bfee070))
* **il2cpp:** verify exact native registration results ([#13640](https://github.com/morluto/rea/issues/13640)) ([9f22928](https://github.com/morluto/rea/commit/9f2292821465dabd2286f36ea054c6cdcf8ef74b))
* **installer:** isolate release selection and consolidate dry-run coverage ([06ffe5c](https://github.com/morluto/rea/commit/06ffe5c63e64e3f89876bb7189fc51e471713549))
* **install:** isolate installer fixtures from ambient configuration ([#12810](https://github.com/morluto/rea/issues/12810)) ([06ffe5c](https://github.com/morluto/rea/commit/06ffe5c63e64e3f89876bb7189fc51e471713549))
* **javascript:** consolidate exported callable binding proofs ([#13575](https://github.com/morluto/rea/issues/13575)) ([fa35707](https://github.com/morluto/rea/commit/fa35707313eaf118991c73b9650a9e3c04c6a9ec))
* **javascript:** consolidate public loader authority coverage ([#13567](https://github.com/morluto/rea/issues/13567)) ([503e134](https://github.com/morluto/rea/commit/503e134ec136febd6d198167fcd931da185f914c))
* **javascript:** consolidate source map acceptance fixtures ([#13056](https://github.com/morluto/rea/issues/13056)) ([66d1bb1](https://github.com/morluto/rea/commit/66d1bb13dcb0722134e698d91c3a9da8d5a21ec4))
* **javascript:** cover array holes, nested spreads and an empty spread before an argument in kill signals ([909d470](https://github.com/morluto/rea/commit/909d4702f22c2976e96bcac309043de02aeba62e))
* **javascript:** cover the inline-HTML unavailable scope through the public CLI ([3eae4de](https://github.com/morluto/rea/commit/3eae4de89fa22e0b253131a5df7b9ba45bf6a886))
* **javascript:** pin the external-script loads edge to its HTML source ([fe8e571](https://github.com/morluto/rea/commit/fe8e571f78ac68d57c3ddbd2d254d9d53b70994d))
* **javascript:** reuse semantic graph node and registry fixtures ([#14550](https://github.com/morluto/rea/issues/14550)) ([8835c18](https://github.com/morluto/rea/commit/8835c18c47c483f56d3b71892b564908d50c9755))
* **javascript:** share one MCP session in GraphQL contract tests ([c26fe5b](https://github.com/morluto/rea/commit/c26fe5b6ff1306155d79d56815851741c34a1949))
* **javascript:** share sessions in builtin default tests ([c227b8e](https://github.com/morluto/rea/commit/c227b8e4de9e147022a2e63091dfa4e96c9bd53a))
* **javascript:** use the file MCP session for default route tests ([fedff66](https://github.com/morluto/rea/commit/fedff667580b9ba0d03798369a633826c48e9796))
* **javascript:** use the file MCP session in factory completion tests ([bcb38e2](https://github.com/morluto/rea/commit/bcb38e2ae5eee0ffa79d61baa5981dc37e1fdd5c))
* **javascript:** verify candidate response provenance in the graph ([9f74043](https://github.com/morluto/rea/commit/9f74043fa69c6a2a375a0c457a2ee00bdda92ae9))
* **jeb:** consolidate catalog and authority checks ([533af33](https://github.com/morluto/rea/commit/533af33a36d44ee9229b79933310b3fdf611c809))
* **jeb:** consolidate HTTP deadline and cancellation checks ([#12843](https://github.com/morluto/rea/issues/12843)) ([baf8035](https://github.com/morluto/rea/commit/baf80358cb3c79818d4d5cd3b8a8e388ac6c978c))
* **jeb:** consolidate HTTP deadline and cancellation coverage ([baf8035](https://github.com/morluto/rea/commit/baf80358cb3c79818d4d5cd3b8a8e388ac6c978c))
* **jeb:** consolidate tool contract coverage at the SDK boundary ([#12803](https://github.com/morluto/rea/issues/12803)) ([533af33](https://github.com/morluto/rea/commit/533af33a36d44ee9229b79933310b3fdf611c809))
* **jeb:** distinguish structured and text refusal evidence ([86acb2a](https://github.com/morluto/rea/commit/86acb2a9640b203d0a2b3de62c56e509498266c0))
* **jeb:** independently verify structured and text refusal envelopes ([#12817](https://github.com/morluto/rea/issues/12817)) ([86acb2a](https://github.com/morluto/rea/commit/86acb2a9640b203d0a2b3de62c56e509498266c0))
* **json:** observe streamed cancellation and file recovery ([#13050](https://github.com/morluto/rea/issues/13050)) ([486eb81](https://github.com/morluto/rea/commit/486eb814056bdf2482254eb22052cba6b666ee70))
* **json:** verify file diagnostics through each output format ([243b9a3](https://github.com/morluto/rea/commit/243b9a37f678d27169786cab2f74861958400261))
* **json:** verify structured CLI file diagnostics ([#13051](https://github.com/morluto/rea/issues/13051)) ([243b9a3](https://github.com/morluto/rea/commit/243b9a37f678d27169786cab2f74861958400261))
* **kuna:** exercise contradictory rows and coordinate shared cancellation ([#12802](https://github.com/morluto/rea/issues/12802)) ([766fb9e](https://github.com/morluto/rea/commit/766fb9e78e4b1f169f210239aef1c5fdbe535988))
* **ledger:** share the packaged process manifest fixture ([#14526](https://github.com/morluto/rea/issues/14526)) ([cb477ff](https://github.com/morluto/rea/commit/cb477ff0e7d1eccdfecbdf1faceee3a46c09eb84))
* **limits:** assert structured apktool and Go limit fields ([#14667](https://github.com/morluto/rea/issues/14667)) ([6f39bae](https://github.com/morluto/rea/commit/6f39bae043a5cc78902cfd58d6e5cd140bac9c28))
* **lint:** share Vitest rule tester setup ([#14552](https://github.com/morluto/rea/issues/14552)) ([1db5c70](https://github.com/morluto/rea/commit/1db5c707523e225c5327ddbc6f5e75333fa86e5b))
* **lldb:** consolidate bridge journal and FIFO checks ([#12808](https://github.com/morluto/rea/issues/12808)) ([7f5a39c](https://github.com/morluto/rea/commit/7f5a39c0c10c49e637cdf13b9dd8fabd7fe296b7))
* **macho:** consolidate classic and modern dylib encoding proofs ([#13952](https://github.com/morluto/rea/issues/13952)) ([d9ba8db](https://github.com/morluto/rea/commit/d9ba8db6e1ea4f96c9a7d400d3d9f8c1d6d9874e))
* **macho:** consolidate command framing and admission proofs ([#13964](https://github.com/morluto/rea/issues/13964)) ([590414c](https://github.com/morluto/rea/commit/590414cc112a79599d3fe4571ba22371ee001f12))
* **macho:** consolidate fixed header and extent proofs ([#13919](https://github.com/morluto/rea/issues/13919)) ([2f79fa8](https://github.com/morluto/rea/commit/2f79fa8ef0565b7d2c18dff42ae075890c019c83))
* **macho:** consolidate lazy payload reuse and capacity proofs ([#13958](https://github.com/morluto/rea/issues/13958)) ([dab60db](https://github.com/morluto/rea/commit/dab60dbe511b2a07dd2ca05c2a653b08fe42fabe))
* **macho:** consolidate lipo field and native slice proofs ([#13937](https://github.com/morluto/rea/issues/13937)) ([806c547](https://github.com/morluto/rea/commit/806c547ed812a2e8380c88f47f3f22c1ddc09352))
* **macho:** consolidate native path framing proofs ([#13926](https://github.com/morluto/rea/issues/13926)) ([ac10dc0](https://github.com/morluto/rea/commit/ac10dc0bc76072d1dbcb7d204ea92438576088e9))
* **macho:** make slice cancellation and cleanup ordering deterministic ([#13944](https://github.com/morluto/rea/issues/13944)) ([62f3ca2](https://github.com/morluto/rea/commit/62f3ca29d6a0557502e5203371bb4e4ce1f71b14))
* **macho:** remove fixtures for the retired otool text parser ([#14510](https://github.com/morluto/rea/issues/14510)) ([c3d85a8](https://github.com/morluto/rea/commit/c3d85a854b41ce23fb4b4fb661613f20ea6b5cc0))
* **managed:** bound projection budget fixtures ([337fd43](https://github.com/morluto/rea/commit/337fd43a0f91aa63c9697fd5dc912f7807454ba3))
* **managed:** consolidate ambiguous heap and Module identity checks ([#13377](https://github.com/morluto/rea/issues/13377)) ([5fc6b33](https://github.com/morluto/rea/commit/5fc6b3351e897860dc213fce3a7bfde63848b34a))
* **managed:** consolidate graph projection checks ([#12979](https://github.com/morluto/rea/issues/12979)) ([7cc9fa1](https://github.com/morluto/rea/commit/7cc9fa1166b04d97c38dac63a83a41b0045aa29d))
* **managed:** consolidate identity and finalization checks ([#12845](https://github.com/morluto/rea/issues/12845)) ([52cf28b](https://github.com/morluto/rea/commit/52cf28b28e544eae8c4f9af5587de8d11aa78dda))
* **managed:** consolidate metadata ExtraData coverage ([e8105d6](https://github.com/morluto/rea/commit/e8105d6be9c5b96a0635f09e0eeef9672f112e8f))
* **managed:** consolidate observed member matching proofs ([#13386](https://github.com/morluto/rea/issues/13386)) ([2fdf3d6](https://github.com/morluto/rea/commit/2fdf3d61d92526ecc2c978b7029f4f86f6de3b2b))
* **managed:** consolidate snapshot cancellation coverage ([52cf28b](https://github.com/morluto/rea/commit/52cf28b28e544eae8c4f9af5587de8d11aa78dda))
* **managed:** exercise both comparison snapshot admissions ([#13384](https://github.com/morluto/rea/issues/13384)) ([6154c61](https://github.com/morluto/rea/commit/6154c610a65096aeddcc05c4d22a55564736d042))
* **mcp:** consolidate admission and lifecycle checks ([#12833](https://github.com/morluto/rea/issues/12833)) ([bb7bdd2](https://github.com/morluto/rea/commit/bb7bdd2fba4cbdd72e3c82df93fa64b7f0575799))
* **mcp:** consolidate artifact verifier catalog and schema checks ([#13260](https://github.com/morluto/rea/issues/13260)) ([3102d18](https://github.com/morluto/rea/commit/3102d18bfc3bb5c9fe6a3d37692a226032bc5d91))
* **mcp:** consolidate browser provider probe ownership checks ([#13166](https://github.com/morluto/rea/issues/13166)) ([96d88a6](https://github.com/morluto/rea/commit/96d88a67c31da87bf470629e9c90fcddb8d275fc))
* **mcp:** consolidate browser source boundary checks ([#13234](https://github.com/morluto/rea/issues/13234)) ([2e83fbd](https://github.com/morluto/rea/commit/2e83fbd394fcae313b58767d4c028f23a4c33935))
* **mcp:** consolidate debugger retirement evidence checks ([#13014](https://github.com/morluto/rea/issues/13014)) ([72a8ae0](https://github.com/morluto/rea/commit/72a8ae01a3cb006b8ff5320a92177d4841b801af))
* **mcp:** consolidate default HTTP input capacity checks ([#13258](https://github.com/morluto/rea/issues/13258)) ([6dbd868](https://github.com/morluto/rea/commit/6dbd86847e589471dee822b5357d98ecc4746af4))
* **mcp:** consolidate deferred runtime and recorder cleanup ([#13247](https://github.com/morluto/rea/issues/13247)) ([051658d](https://github.com/morluto/rea/commit/051658daa15aa2fd952692eaab1b64198c2f2591))
* **mcp:** consolidate derived operation progress coverage ([#12778](https://github.com/morluto/rea/issues/12778)) ([3caa46f](https://github.com/morluto/rea/commit/3caa46f980bbc1d9ef9e1f25b4e046cfc0d03ca9))
* **mcp:** consolidate HTTP admission and socket reuse checks ([#13252](https://github.com/morluto/rea/issues/13252)) ([333e6de](https://github.com/morluto/rea/commit/333e6de3111f8dcdb56aa6d17c499aa39c0c9f3e))
* **mcp:** consolidate HTTP factory and shutdown settlement checks ([#13253](https://github.com/morluto/rea/issues/13253)) ([1ed4471](https://github.com/morluto/rea/commit/1ed4471c59753e72fd9bc0d4c409d24049d2ce2d))
* **mcp:** consolidate input schema compatibility contracts ([#13323](https://github.com/morluto/rea/issues/13323)) ([664c0c5](https://github.com/morluto/rea/commit/664c0c5267c12ab2cfa388d6cb722d084b7ce4bf))
* **mcp:** consolidate JavaScript Evidence transport checks ([#13055](https://github.com/morluto/rea/issues/13055)) ([9a388af](https://github.com/morluto/rea/commit/9a388afdfca3acbb7a4dc849b047e5c5faf4e906))
* **mcp:** consolidate progressive catalog wire checks ([#13248](https://github.com/morluto/rea/issues/13248)) ([00974e5](https://github.com/morluto/rea/commit/00974e5a613d6df669c5a7f0ef7f143d03254154))
* **mcp:** consolidate reduced output schema proof at the SDK boundary ([#12823](https://github.com/morluto/rea/issues/12823)) ([40c6dad](https://github.com/morluto/rea/commit/40c6dade8eb608141ec62dd90a8ee4195d52fbd8))
* **mcp:** consolidate relative inspection path checks ([#14323](https://github.com/morluto/rea/issues/14323)) ([d4ce142](https://github.com/morluto/rea/commit/d4ce142fc8f4705b1130c4ad0511713e0dcc6bfc))
* **mcp:** consolidate result delivery and capture checks ([#12836](https://github.com/morluto/rea/issues/12836)) ([11c9512](https://github.com/morluto/rea/commit/11c951228c6ae466c8391a0871164ab11d89aa5e))
* **mcp:** consolidate runtime shutdown and retry checks ([4edb900](https://github.com/morluto/rea/commit/4edb900bdd1211f76390b95cabc4a2c898198438))
* **mcp:** consolidate shutdown and retry lifecycle checks ([#12847](https://github.com/morluto/rea/issues/12847)) ([4edb900](https://github.com/morluto/rea/commit/4edb900bdd1211f76390b95cabc4a2c898198438))
* **mcp:** consolidate shutdown settlement and admission checks ([#13243](https://github.com/morluto/rea/issues/13243)) ([8d591e3](https://github.com/morluto/rea/commit/8d591e38f9f3b63a977c5f9892de8c3942feebee))
* **mcp:** cover wrapped ENOTCONN connection loss ([68657d5](https://github.com/morluto/rea/commit/68657d55bb30521bf4388919c369ca13a6e45d5b)), refs [#11362](https://github.com/morluto/rea/issues/11362)
* **mcp:** distinguish schema recursion from instance data ([#13249](https://github.com/morluto/rea/issues/13249)) ([61eabd2](https://github.com/morluto/rea/commit/61eabd25dcea5399bf74a8764cafc3f297bbb49c))
* **mcp:** prove session detail admission before provider probes ([#13641](https://github.com/morluto/rea/issues/13641)) ([6fc05b7](https://github.com/morluto/rea/commit/6fc05b7a4d9fcaf1efe64b66b21f68ff328bc580))
* **mcp:** share address context capacity setup ([#14542](https://github.com/morluto/rea/issues/14542)) ([d11eba6](https://github.com/morluto/rea/commit/d11eba6295c764b10a72341d9fa29178bf7b2b7f))
* **mcp:** share caller-owned in-memory handshakes ([#14424](https://github.com/morluto/rea/issues/14424)) ([efeac85](https://github.com/morluto/rea/commit/efeac85e0f2338b91d35c32ae2a67b75d96604ea))
* **mcp:** share isolated file inspection sessions ([#14426](https://github.com/morluto/rea/issues/14426)) ([d0c51d1](https://github.com/morluto/rea/commit/d0c51d1fa063c09d345a279b732d6b7c32623baa))
* **mcp:** share the listed-tool evidence caller ([#14676](https://github.com/morluto/rea/issues/14676)) ([20428db](https://github.com/morluto/rea/commit/20428dbc397eac27925278316a1ee9e70a122716))
* **mcp:** share the successful tool assertion ([#14576](https://github.com/morluto/rea/issues/14576)) ([3bb225c](https://github.com/morluto/rea/commit/3bb225c564249330b6286187bffaccd12f5b1f10))
* **mcp:** strengthen portable pattern witnesses ([#13324](https://github.com/morluto/rea/issues/13324)) ([d08c523](https://github.com/morluto/rea/commit/d08c52384ac1e7dde8a5c1f0a4a320a83f082268))
* **mitmproxy:** consolidate transport evidence checks ([#12935](https://github.com/morluto/rea/issues/12935)) ([f61c38c](https://github.com/morluto/rea/commit/f61c38c8208f33c2b0a7fd906b89d505cfd5a917))
* **model:** consolidate historical layout and retained views ([#12878](https://github.com/morluto/rea/issues/12878)) ([6dde865](https://github.com/morluto/rea/commit/6dde865ccf11625aaafd4c1daed22b0e01aa8495))
* **native-ui:** consolidate deadline and interruption coverage ([#12850](https://github.com/morluto/rea/issues/12850)) ([a63690a](https://github.com/morluto/rea/commit/a63690ad3bd5fad2321a0a897f4ebb0020a27870))
* **native:** accept either dyld_info exit in the file-type refusal ([d131cd2](https://github.com/morluto/rea/commit/d131cd25f5c71bc1ddce8cf6237390920c5600e1))
* **native:** accept plutil nesting diagnostics on stdout ([9d9be40](https://github.com/morluto/rea/commit/9d9be40313972e7eefc5680f9df6b0722a45e56e))
* **native:** consolidate keyed archive scalar journeys ([#12799](https://github.com/morluto/rea/issues/12799)) ([7f41107](https://github.com/morluto/rea/commit/7f411078a3ddd85d570bc1ed5050ecb372be7a38))
* **native:** consolidate signature cancellation coverage ([8f762f9](https://github.com/morluto/rea/commit/8f762f9bc84032efe06141fa0ad667e4e35560ed))
* **native:** consolidate signature target cancellation coverage ([#12791](https://github.com/morluto/rea/issues/12791)) ([8f762f9](https://github.com/morluto/rea/commit/8f762f9bc84032efe06141fa0ad667e4e35560ed))
* **native:** consolidate symbol-origin matching coverage ([#13423](https://github.com/morluto/rea/issues/13423)) ([9a885bd](https://github.com/morluto/rea/commit/9a885bd684d8b0ba87b6ab54be012dd420e67771))
* **native:** isolate Objective-C ivar alignment coverage ([#13205](https://github.com/morluto/rea/issues/13205)) ([204434e](https://github.com/morluto/rea/commit/204434e087e2f3fee260c46abb928345d3171b44))
* **native:** retain per-ivar alignment facts in mixed lists ([#3424](https://github.com/morluto/rea/issues/3424)) ([3dcd6b6](https://github.com/morluto/rea/commit/3dcd6b62e813e1d7808ee4d0554130b5aa207538))
* **native:** reuse the owned process fixture for plist linting ([#14593](https://github.com/morluto/rea/issues/14593)) ([a9d1031](https://github.com/morluto/rea/commit/a9d103167484234027415cf7816f4bd8335bf8a7))
* **native:** share Mach-O inspection invocation fixtures ([#14543](https://github.com/morluto/rea/issues/14543)) ([2f510ac](https://github.com/morluto/rea/commit/2f510acf5197a04cece4f75903bbe66569a3ac73))
* **native:** share Swift reader location and evidence fixtures ([#14551](https://github.com/morluto/rea/issues/14551)) ([21a91b5](https://github.com/morluto/rea/commit/21a91b5f2a2f63e4a92b4053b64671114e06f644))
* **nuget:** consolidate filename provenance and retained Evidence checks ([#13396](https://github.com/morluto/rea/issues/13396)) ([c45decb](https://github.com/morluto/rea/commit/c45decb70b71ce6443dc161547c05ca2ab50b1ce))
* **nuget:** distinguish metadata budget and cancellation phases ([#13394](https://github.com/morluto/rea/issues/13394)) ([9fee59e](https://github.com/morluto/rea/commit/9fee59e418d7995457ab219c0c2053d45cc22336))
* **package:** consolidate verifier diagnostics and setup applicability ([#12862](https://github.com/morluto/rea/issues/12862)) ([c6fe1e4](https://github.com/morluto/rea/commit/c6fe1e43e81c55065216e166247af043c95e9584))
* **pcap:** consolidate packet provider output and cleanup coverage ([#12816](https://github.com/morluto/rea/issues/12816)) ([4b79eaa](https://github.com/morluto/rea/commit/4b79eaa9edae781b4c094caea9158d0f39498492))
* **pcap:** consolidate tool admission coverage ([#12834](https://github.com/morluto/rea/issues/12834)) ([15d53ae](https://github.com/morluto/rea/commit/15d53aecb0ad8e5442414c43c44b44293c199266))
* **pe:** consolidate certificate parsing and public error proofs ([#13565](https://github.com/morluto/rea/issues/13565)) ([3b6734b](https://github.com/morluto/rea/commit/3b6734bfaebccb717d655f93ef1d361a772c8ebc))
* **pe:** consolidate resource coverage through public adapters ([#13562](https://github.com/morluto/rea/issues/13562)) ([3f1046d](https://github.com/morluto/rea/commit/3f1046d0f813f268ba3f1caf59c7575132c6807e))
* **pe:** distinguish unsupported DOS input from truncated input ([#14302](https://github.com/morluto/rea/issues/14302)) ([d6e602c](https://github.com/morluto/rea/commit/d6e602cbfc52cd86f442a27d8b057294388c3ae9))
* **process:** bound inherited-pipe fixture lifetime to its workspace ([#13030](https://github.com/morluto/rea/issues/13030)) ([d989ff0](https://github.com/morluto/rea/commit/d989ff06e8bdc5705ddab72b4e3c7f3965eb6043))
* **process:** check SIGHUP limitation through its exported owner constant ([de44e5e](https://github.com/morluto/rea/commit/de44e5e2735fbe04226db629f3a077c8b1fa9be0))
* **process:** consolidate capture finalization and timer checks ([#12852](https://github.com/morluto/rea/issues/12852)) ([7b8ddab](https://github.com/morluto/rea/commit/7b8ddab284bc8e4a16ce8fb2d2b7a5247c72c1af))
* **process:** consolidate command timeout and output ownership checks ([#12905](https://github.com/morluto/rea/issues/12905)) ([86b4360](https://github.com/morluto/rea/commit/86b4360ce23aa640f1cdd475cffb0860fba8c723))
* **process:** consolidate Darwin compiler diagnostics and module cache checks ([#12896](https://github.com/morluto/rea/issues/12896)) ([c8b645b](https://github.com/morluto/rea/commit/c8b645b7ffae7ff265f50144c83a6d09003b2f26))
* **process:** consolidate Darwin helper cache publication and cancellation ([#12898](https://github.com/morluto/rea/issues/12898)) ([a2acbe3](https://github.com/morluto/rea/commit/a2acbe393971a7961db5d88d241efe2ad2ab3f51))
* **process:** consolidate Darwin helper request and cleanup proof ([#12897](https://github.com/morluto/rea/issues/12897)) ([193bc53](https://github.com/morluto/rea/commit/193bc533be12d0c8bc1c7aa93430dd755c015411))
* **process:** consolidate held lease peer and retry proof ([#13693](https://github.com/morluto/rea/issues/13693)) ([b10fde8](https://github.com/morluto/rea/commit/b10fde8a28731f15e62a3c1932d0c96d330fec06))
* **process:** consolidate local bridge transport and cancellation coverage ([#12907](https://github.com/morluto/rea/issues/12907)) ([9fff01f](https://github.com/morluto/rea/commit/9fff01f791b670a76a8f506f647a9a3f971f1164))
* **process:** consolidate native capture finalization proof ([7b8ddab](https://github.com/morluto/rea/commit/7b8ddab284bc8e4a16ce8fb2d2b7a5247c72c1af))
* **process:** consolidate native Darwin token refusal coverage ([#12901](https://github.com/morluto/rea/issues/12901)) ([c0d3f2e](https://github.com/morluto/rea/commit/c0d3f2ea9359649c4da705e1755feee44808bf92))
* **process:** consolidate owned command finalization proof ([#13686](https://github.com/morluto/rea/issues/13686)) ([3fbfeb9](https://github.com/morluto/rea/commit/3fbfeb9f0718fe1df0abb80685dd0c2f5077f41d))
* **process:** consolidate PID authority and native exit settlement coverage ([#12895](https://github.com/morluto/rea/issues/12895)) ([21f8f56](https://github.com/morluto/rea/commit/21f8f56dde0d2dafba9576f21342b5dc44250619))
* **process:** consolidate process capture finalization checks ([#12785](https://github.com/morluto/rea/issues/12785)) ([c5907d3](https://github.com/morluto/rea/commit/c5907d3944fd7cbbcb884cdca68fa4e26e95ba45))
* **process:** consolidate process inventory and native row checks ([#12889](https://github.com/morluto/rea/issues/12889)) ([880e623](https://github.com/morluto/rea/commit/880e62351e010a008b6373e3d23d5072e3fd8138))
* **process:** consolidate producer recovery and cleanup evidence ([#13694](https://github.com/morluto/rea/issues/13694)) ([de0b7f6](https://github.com/morluto/rea/commit/de0b7f65150c458946af5c42ff098af442ca9675))
* **process:** consolidate provider startup deadline coverage ([#12773](https://github.com/morluto/rea/issues/12773)) ([eb1e75b](https://github.com/morluto/rea/commit/eb1e75b809a8169f06f6980fe6245582b183b744))
* **process:** consolidate run-token fallback and native retry coverage ([#12892](https://github.com/morluto/rea/issues/12892)) ([afc8c0a](https://github.com/morluto/rea/commit/afc8c0ae7ba35009b4a9aace530f01cefc149f54))
* **process:** consolidate selected child environment proofs ([#13074](https://github.com/morluto/rea/issues/13074)) ([9626788](https://github.com/morluto/rea/commit/96267880c3dec7715f8e71293ed2bc13c9eacf24))
* **process:** consolidate startup interruption and finalize proofs ([#13742](https://github.com/morluto/rea/issues/13742)) ([ba0645a](https://github.com/morluto/rea/commit/ba0645a9a441e02b2c4c0b71198152fbf1ded361))
* **process:** consolidate stream framing and token proofs ([#13714](https://github.com/morluto/rea/issues/13714)) ([aab4768](https://github.com/morluto/rea/commit/aab47683f5bebecf87a8f496a2f1074c5cb09f94))
* **process:** consolidate supervised output closure and cleanup checks ([#12906](https://github.com/morluto/rea/issues/12906)) ([3a002fb](https://github.com/morluto/rea/commit/3a002fb708991e9f3b0933c315e96bdfcd0aa703))
* **process:** consolidate symlink snapshot captures ([#14051](https://github.com/morluto/rea/issues/14051)) ([bb29caa](https://github.com/morluto/rea/commit/bb29caa5098595c729b30f9ace938560ba715a4c))
* **process:** consolidate worker and transport ownership checks ([#12887](https://github.com/morluto/rea/issues/12887)) ([819a726](https://github.com/morluto/rea/commit/819a72678f8a05b5f892f65ae3b8b7b23656cc70))
* **process:** cover an unrelated process exiting during the cleanup sweep ([30be558](https://github.com/morluto/rea/commit/30be558254ec88a45166c76fd3b40857c7f43614))
* **process:** exercise Ghidra reserved reply IDs ([5f7a586](https://github.com/morluto/rea/commit/5f7a586aa59f25b99095a71903effcdba9b4d1d7))
* **process:** exercise reserved success IDs with a valid frame ([#12787](https://github.com/morluto/rea/issues/12787)) ([5f7a586](https://github.com/morluto/rea/commit/5f7a586aa59f25b99095a71903effcdba9b4d1d7))
* **process:** join descriptor inspection and consolidate ownership proof ([#12891](https://github.com/morluto/rea/issues/12891)) ([cbe3d16](https://github.com/morluto/rea/commit/cbe3d16e4459bd030f1727e9fd22ace763c3b992))
* **process:** publish timeout stop signal atomically in ExecFileOutput test ([#13151](https://github.com/morluto/rea/issues/13151)) ([df1bd11](https://github.com/morluto/rea/commit/df1bd118959edc956575156dee55fc45b2b8b93b))
* **process:** reuse the provider fixture stop helper ([#14469](https://github.com/morluto/rea/issues/14469)) ([8478fea](https://github.com/morluto/rea/commit/8478feae7023536bc073f9576466e6696eadab9a))
* **process:** share the procfs descriptor fixture ([#14592](https://github.com/morluto/rea/issues/14592)) ([6e771da](https://github.com/morluto/rea/commit/6e771da08eb17a82d34c7f7e0b09d13484193a17))
* **process:** stop inherited-pipe fixtures when their workspace disappears ([d989ff0](https://github.com/morluto/rea/commit/d989ff06e8bdc5705ddab72b4e3c7f3965eb6043))
* **process:** synchronize debugger output fixtures ([#13817](https://github.com/morluto/rea/issues/13817)) ([0b5e1c8](https://github.com/morluto/rea/commit/0b5e1c87f6930c903f10c2577d233b98f0ba8f97))
* **process:** synchronize launcher exit proof and remove duplicate deadline check ([#12890](https://github.com/morluto/rea/issues/12890)) ([19f9a01](https://github.com/morluto/rea/commit/19f9a016559060cce5debec1403f19e6394fdb88))
* **process:** verify Darwin snapshot and helper reply ownership ([#12904](https://github.com/morluto/rea/issues/12904)) ([6e99f60](https://github.com/morluto/rea/commit/6e99f607f7e6ff10ec77cf0ebd5a34cf527d54a6))
* **process:** verify shared helper publication and cancellation at ownership boundary ([a2acbe3](https://github.com/morluto/rea/commit/a2acbe393971a7961db5d88d241efe2ad2ab3f51))
* **providers:** consolidate bridge request lifecycle checks ([#13033](https://github.com/morluto/rea/issues/13033)) ([5fb7126](https://github.com/morluto/rea/commit/5fb7126a65e158af326789585cd09c206b2186fc))
* **providers:** consolidate composite child ownership checks ([#12986](https://github.com/morluto/rea/issues/12986)) ([ddbfd07](https://github.com/morluto/rea/commit/ddbfd073694fdea0fc8028dedb19b3d5792538bc))
* **providers:** consolidate refusal and finalization checks ([#12985](https://github.com/morluto/rea/issues/12985)) ([efe2da7](https://github.com/morluto/rea/commit/efe2da79a86e89f596c1741d73ea18b583b3ccac))
* **providers:** consolidate selection diagnostics checks ([#12982](https://github.com/morluto/rea/issues/12982)) ([01022e9](https://github.com/morluto/rea/commit/01022e9afe83462c4d9e7dc6502785d8c0108cea))
* **providers:** share availability and target support fixtures ([#14434](https://github.com/morluto/rea/issues/14434)) ([e21bf86](https://github.com/morluto/rea/commit/e21bf8661cc323819b768e9b79698aa1cbd0b7e2))
* **providers:** share deferred artifact finalization setup ([#14547](https://github.com/morluto/rea/issues/14547)) ([b6b3694](https://github.com/morluto/rea/commit/b6b36947cd16f4a2680c0f97c8c3701526ea7d6a))
* **providers:** share Java probe preparation cleanup ([#14530](https://github.com/morluto/rea/issues/14530)) ([5424e90](https://github.com/morluto/rea/commit/5424e90b0288f48e9e206d0eef631bda3b95bcbc))
* **providers:** share layout and crash inspection fixtures ([#14435](https://github.com/morluto/rea/issues/14435)) ([7676a38](https://github.com/morluto/rea/commit/7676a386a12ecb3168a3872bc515222ca26b166d))
* **providers:** share placeholder Hopper project files ([#14813](https://github.com/morluto/rea/issues/14813)) ([a1749f1](https://github.com/morluto/rea/commit/a1749f1b6552240923c5c1921a3b976a1252d4e7))
* **providers:** share process group and workspace cleanup assertions ([#14487](https://github.com/morluto/rea/issues/14487)) ([da1ba03](https://github.com/morluto/rea/commit/da1ba036c9133795d6ad0b8329e53e587bdd31b5))
* prune redundant and superseded tests ([#14271](https://github.com/morluto/rea/issues/14271)) ([5c3ed5d](https://github.com/morluto/rea/commit/5c3ed5d028378eeed09f4b4c471882f9ee9b11f6))
* **pyinstaller:** reuse archive reader fixtures ([#14879](https://github.com/morluto/rea/issues/14879)) ([e70ca8d](https://github.com/morluto/rea/commit/e70ca8d02b50bd4139673be10c02cbd4785fa339))
* **python:** consolidate pyc parser and CLI coverage ([#13566](https://github.com/morluto/rea/issues/13566)) ([917ab7f](https://github.com/morluto/rea/commit/917ab7f5fd8b25c3c9512ded08b3b7ebb903bf3b))
* **python:** distinguish malformed marshal lengths from capacity failures ([#12801](https://github.com/morluto/rea/issues/12801)) ([db01712](https://github.com/morluto/rea/commit/db0171297d14c71127b39915f2063561ae1b8a84))
* **python:** verify malformed signed marshal count defects ([db01712](https://github.com/morluto/rea/commit/db0171297d14c71127b39915f2063561ae1b8a84))
* **reference:** consolidate Git exclusion and policy checks ([#12846](https://github.com/morluto/rea/issues/12846)) ([18cd307](https://github.com/morluto/rea/commit/18cd307b6edbdd31ae85445cb76d5c8c9f6d0258))
* **reference:** consolidate Git metadata and policy checks ([18cd307](https://github.com/morluto/rea/commit/18cd307b6edbdd31ae85445cb76d5c8c9f6d0258))
* **reference:** consolidate import and descriptor ownership coverage ([#13526](https://github.com/morluto/rea/issues/13526)) ([a5afd70](https://github.com/morluto/rea/commit/a5afd70bee139f90844dacfc4cfa1ae10cbdc0d0))
* **reference:** consolidate reader scheduling and failure checks ([#12835](https://github.com/morluto/rea/issues/12835)) ([4f5d1b2](https://github.com/morluto/rea/commit/4f5d1b250c0d90d6cb53009ffb56a0fdd0a7a929))
* **reference:** verify exact exclusions against failed ancestors ([68e6953](https://github.com/morluto/rea/commit/68e6953897c1100faed203ad8af22c41c2a823a0))
* **reference:** verify exclusion and missing-root outcomes ([#12831](https://github.com/morluto/rea/issues/12831)) ([68e6953](https://github.com/morluto/rea/commit/68e6953897c1100faed203ad8af22c41c2a823a0))
* **registration:** share the isolated child process environment ([#14525](https://github.com/morluto/rea/issues/14525)) ([63d1eca](https://github.com/morluto/rea/commit/63d1ecac00f8f0358a54db5f41f8a00d9d86d30d))
* **release-exposure:** consolidate native and packaged evidence checks ([#13382](https://github.com/morluto/rea/issues/13382)) ([ca7572d](https://github.com/morluto/rea/commit/ca7572d6e926b744c6ee9bd9f343974d63154f93))
* **release:** consolidate immutable checkpoint fixtures ([#13388](https://github.com/morluto/rea/issues/13388)) ([1a613fd](https://github.com/morluto/rea/commit/1a613fd0d548aa978febfa55374ddf8bf55766f8))
* remove stale imports after temporary directory fixture migration ([#14605](https://github.com/morluto/rea/issues/14605)) ([8dd0452](https://github.com/morluto/rea/commit/8dd045224afeb3b5f298fb9fcae370e5898f0e0b))
* **replay:** remove unused factory fixtures ([#14511](https://github.com/morluto/rea/issues/14511)) ([2f2a66f](https://github.com/morluto/rea/commit/2f2a66f2115db4002891b8056f734cd1f3c26a01))
* **resources:** consolidate directory reader identity checks ([#12941](https://github.com/morluto/rea/issues/12941)) ([8a971e1](https://github.com/morluto/rea/commit/8a971e192ad60cd73956f79dd24d8a77061e9aa0))
* **resources:** consolidate output publication coverage ([#12938](https://github.com/morluto/rea/issues/12938)) ([329510a](https://github.com/morluto/rea/commit/329510a5e189333b88dabcb7062e33dcb7d5c95a))
* **resources:** consolidate scope close and lease checks ([#12849](https://github.com/morluto/rea/issues/12849)) ([6c067ec](https://github.com/morluto/rea/commit/6c067ec9afd12feba801a18f1e675559f699f3ce))
* **resources:** consolidate stable artifact chunk coverage ([#12937](https://github.com/morluto/rea/issues/12937)) ([f454348](https://github.com/morluto/rea/commit/f45434828103d16cb2b82e6e6373c15d19da9296))
* **resources:** consolidate stable provider finalization proofs ([#13808](https://github.com/morluto/rea/issues/13808)) ([0cb6824](https://github.com/morluto/rea/commit/0cb6824b6392a0aa4c29d281f926d1d9677a4768))
* restore audited startup, launcher, and BEAM contracts ([#12884](https://github.com/morluto/rea/issues/12884)) ([6cd055b](https://github.com/morluto/rea/commit/6cd055bfca0c81f7af5abc0626feeb82bea3ca3d))
* **reverse:** consolidate command outcome coverage ([#12776](https://github.com/morluto/rea/issues/12776)) ([9899c66](https://github.com/morluto/rea/commit/9899c6659af12cbdf1ca5595c72bda57e042b280))
* **rizin:** consolidate detach inventory and protocol checks ([#13031](https://github.com/morluto/rea/issues/13031)) ([ba90341](https://github.com/morluto/rea/commit/ba903414213db4271add58a1f73c2e6f74eb1fba))
* **rizin:** consolidate frame bounds and subprocess fixtures ([#13016](https://github.com/morluto/rea/issues/13016)) ([24d3dab](https://github.com/morluto/rea/commit/24d3dab4623ad51a93b190957f7a00c3dc82199e))
* **rizin:** consolidate stdin failure and cleanup checks ([#13018](https://github.com/morluto/rea/issues/13018)) ([8ab232b](https://github.com/morluto/rea/commit/8ab232b4d8e51e68ac9cc4829da0ae0800a6c4ea))
* **rizin:** synchronize partial output with command deadlines ([#13040](https://github.com/morluto/rea/issues/13040)) ([3059921](https://github.com/morluto/rea/commit/3059921cc67d7d8506c59a6ca64f9bb399559044))
* **rizin:** verify ownership when close readback is unavailable ([#13029](https://github.com/morluto/rea/issues/13029)) ([cd6d713](https://github.com/morluto/rea/commit/cd6d713e946da1d2c44f454aee7e3847b03d3c07))
* run repeated CLI formatting capacity pairings in process ([#14279](https://github.com/morluto/rea/issues/14279)) ([3cb7ca9](https://github.com/morluto/rea/commit/3cb7ca9eeb57733396662720897c7bf2ba2dc430))
* **rust:** consolidate auditable revision and cycle checks ([76ae995](https://github.com/morluto/rea/commit/76ae995f2b71d01802c94ff5a2284dcc5ff2b57b))
* **rust:** consolidate carrier and public Evidence coverage ([#13571](https://github.com/morluto/rea/issues/13571)) ([c70d1af](https://github.com/morluto/rea/commit/c70d1af4162deb4827b5db9f967fb12d18221186))
* **rust:** consolidate carrier budgets and retained views ([#12872](https://github.com/morluto/rea/issues/12872)) ([75908cc](https://github.com/morluto/rea/commit/75908cc1fa8fd36c0da515cfb62c69db654410ab))
* **rust:** consolidate dependency cycle and format revision checks ([#12868](https://github.com/morluto/rea/issues/12868)) ([76ae995](https://github.com/morluto/rea/commit/76ae995f2b71d01802c94ff5a2284dcc5ff2b57b))
* **sessions:** share fixture provider identity construction ([#14545](https://github.com/morluto/rea/issues/14545)) ([15e5b42](https://github.com/morluto/rea/commit/15e5b421bf0ebbc23e8c555a68e80c44d49ac768))
* **setup:** consolidate backup transaction coverage ([#13519](https://github.com/morluto/rea/issues/13519)) ([a9ae4aa](https://github.com/morluto/rea/commit/a9ae4aa0bc0d6ce0e57ed9f2fc20224ac8d33dec))
* **setup:** consolidate backup, skill recovery and consent journeys ([#13498](https://github.com/morluto/rea/issues/13498)) ([1ad48ef](https://github.com/morluto/rea/commit/1ad48ef3c0179a5d25cbca2ab6ab504f454e927d))
* **setup:** consolidate client cleanup and shared registration coverage ([#13503](https://github.com/morluto/rea/issues/13503)) ([10c21a6](https://github.com/morluto/rea/commit/10c21a608cd0c92050750e270a5fcf1b4bb003da))
* **setup:** consolidate configuration transaction and recovery checks ([#13289](https://github.com/morluto/rea/issues/13289)) ([d0cbb20](https://github.com/morluto/rea/commit/d0cbb20a6c735b70f4cd2e98e36fcd51c65ba9c2))
* **setup:** consolidate Cursor JSONC uninstall coverage ([#13533](https://github.com/morluto/rea/issues/13533)) ([03a9b54](https://github.com/morluto/rea/commit/03a9b549e117f266220f8628558c261d6eacd821))
* **setup:** consolidate Hopper download failure coverage ([#12928](https://github.com/morluto/rea/issues/12928)) ([1c2ad52](https://github.com/morluto/rea/commit/1c2ad52b285c24a26873bef16abb0f2630a0410c))
* **setup:** consolidate installer consent and plan disclosure checks ([#12869](https://github.com/morluto/rea/issues/12869)) ([234cae0](https://github.com/morluto/rea/commit/234cae0592ca4ef6ef002598a3e39396e1739501))
* **setup:** consolidate malformed dry-run CLI coverage ([6bc96f3](https://github.com/morluto/rea/commit/6bc96f3f9900dcebd9c502592d325cd495d554ae))
* **setup:** consolidate manual-client selection coverage ([f718e17](https://github.com/morluto/rea/commit/f718e17caaa8fa73d6a8705833e811a3be85b994))
* **setup:** consolidate OpenCode dialect and project discovery checks ([#13559](https://github.com/morluto/rea/issues/13559)) ([317974d](https://github.com/morluto/rea/commit/317974d4f4129d8fc2cf7aee6be820d7bc3f6a94))
* **setup:** consolidate registration status contracts ([#13303](https://github.com/morluto/rea/issues/13303)) ([e9b0f0b](https://github.com/morluto/rea/commit/e9b0f0b68c3f63cfbadd4da8e5ce4554dac28b67))
* **setup:** consolidate TOML client preservation checks ([#13294](https://github.com/morluto/rea/issues/13294)) ([825afe0](https://github.com/morluto/rea/commit/825afe019c9e35b9e4a44ae0efef338435df752d))
* **setup:** cover client name resolution and typo suggestions ([fe1f851](https://github.com/morluto/rea/commit/fe1f85105705b272282e96042c93e588c20f1c42))
* **setup:** cover registration removal layout in JSON client files ([1278b0a](https://github.com/morluto/rea/commit/1278b0a7731badfe3fd01c4b6b91d26f82d3179f))
* **setup:** exercise the MSIX registration regression in Windows CI ([#13189](https://github.com/morluto/rea/issues/13189)) ([c806ba8](https://github.com/morluto/rea/commit/c806ba8ed79ea6e8e0e7e14700fb17893da2fd49))
* **setup:** reject tampered packages with both signing subkeys ([#14925](https://github.com/morluto/rea/issues/14925)) ([1111a46](https://github.com/morluto/rea/commit/1111a4642ad7805e0c8679d4f19fb70cbfa2b716))
* **setup:** run the MSIX registration regression in Windows CI ([c806ba8](https://github.com/morluto/rea/commit/c806ba8ed79ea6e8e0e7e14700fb17893da2fd49))
* **snapshot:** consolidate Ghidra replay and import coverage ([#12915](https://github.com/morluto/rea/issues/12915)) ([4269f79](https://github.com/morluto/rea/commit/4269f796782cfc4cd17cb4050371417960f6b70f))
* **snapshots:** consolidate non-object file admission checks ([#13047](https://github.com/morluto/rea/issues/13047)) ([eb84f90](https://github.com/morluto/rea/commit/eb84f90417d23cd73a9b2f097b80c3737cad8268))
* **snapshots:** verify ambiguous provenance through direct replay ([#13046](https://github.com/morluto/rea/issues/13046)) ([b6fced4](https://github.com/morluto/rea/commit/b6fced40a3917168d3dcd3faece150707a6f8072))
* **snapshots:** verify byte consistency across file scans ([#13049](https://github.com/morluto/rea/issues/13049)) ([88d829b](https://github.com/morluto/rea/commit/88d829bc0dc752f46e53b6a50ba52a65b4044be0))
* **snapshots:** verify live source metadata refresh ([#13048](https://github.com/morluto/rea/issues/13048)) ([34da2cc](https://github.com/morluto/rea/commit/34da2cce1f75a3fff8532d9b7cc6d8082c7cbcb6))
* **source-maps:** synchronize inherited output checks ([2b571cd](https://github.com/morluto/rea/commit/2b571cd3bb7cff26785a66ab004606b7504fc149))
* **sourcemap:** consolidate browser capture coverage checks ([#13063](https://github.com/morluto/rea/issues/13063)) ([d69a7fd](https://github.com/morluto/rea/commit/d69a7fdbf6225abd1d27cddbfc341a6350df790a))
* **sourcemap:** consolidate browser evidence and interpretation budgets ([#13061](https://github.com/morluto/rea/issues/13061)) ([a9c9a53](https://github.com/morluto/rea/commit/a9c9a530c065298ea8e45886dd2e7744472661af))
* **sourcemap:** consolidate capture coverage and validation ([d69a7fd](https://github.com/morluto/rea/commit/d69a7fdbf6225abd1d27cddbfc341a6350df790a))
* **sourcemap:** consolidate fetch budget and redirect deadline checks ([#13060](https://github.com/morluto/rea/issues/13060)) ([e1ad87b](https://github.com/morluto/rea/commit/e1ad87ba88d6fd7dd2a9d27a6fa08ac071bbed08))
* **sourcemap:** consolidate fetch cancellation and response ownership checks ([#13059](https://github.com/morluto/rea/issues/13059)) ([c340608](https://github.com/morluto/rea/commit/c3406087b72846b630d66d7ac13a462b26ec5fc7))
* **sourcemap:** consolidate fetch deadline and cleanup proofs ([#13062](https://github.com/morluto/rea/issues/13062)) ([7b3457c](https://github.com/morluto/rea/commit/7b3457cdfeaf6a8722f6406c02d4e5bbf15b8796))
* **sourcemap:** consolidate indexed coordinate and overlap checks ([#13065](https://github.com/morluto/rea/issues/13065)) ([5bbd238](https://github.com/morluto/rea/commit/5bbd238f2f90e28d21edf5dbfdaa0b4cbf14f0e5))
* **sourcemap:** consolidate indexed section admission checks ([#13066](https://github.com/morluto/rea/issues/13066)) ([47d8658](https://github.com/morluto/rea/commit/47d86582c82701ac7fbb6ad57bb85689ba4e8e6b))
* **sourcemap:** consolidate inherited output and index checks ([#12841](https://github.com/morluto/rea/issues/12841)) ([2b571cd](https://github.com/morluto/rea/commit/2b571cd3bb7cff26785a66ab004606b7504fc149))
* **sourcemap:** consolidate original source dependency coverage ([#13064](https://github.com/morluto/rea/issues/13064)) ([35ece22](https://github.com/morluto/rea/commit/35ece22417f5bfd652df77d2334d3e61228b8277))
* **sourcemap:** consolidate point lookup and CLI parity ([#13067](https://github.com/morluto/rea/issues/13067)) ([07225b8](https://github.com/morluto/rea/commit/07225b8b3eaffa041494ba9f00094d77df378a62))
* **sourcemap:** consolidate point lookup and original location cases ([07225b8](https://github.com/morluto/rea/commit/07225b8b3eaffa041494ba9f00094d77df378a62))
* **sourcemap:** consolidate retained views and MCP delivery checks ([#13070](https://github.com/morluto/rea/issues/13070)) ([a9463bf](https://github.com/morluto/rea/commit/a9463bf1a938d7cba158c53a2d832250e96a953f))
* **sourcemap:** isolate artifact identity and retain rejected reports ([#13069](https://github.com/morluto/rea/issues/13069)) ([eca10e8](https://github.com/morluto/rea/commit/eca10e848f7302a2c80ddf89dc6811f42c7f5e68))
* **sourcemap:** observe late fetch cleanup ownership ([c340608](https://github.com/morluto/rea/commit/c3406087b72846b630d66d7ac13a462b26ec5fc7))
* **sourcemap:** repair codec deadline verification ([#13057](https://github.com/morluto/rea/issues/13057)) ([dc16719](https://github.com/morluto/rea/commit/dc16719b04aebcace578996c8135946b6fffc905))
* **sourcemap:** verify codec reply runtime budgets ([#13058](https://github.com/morluto/rea/issues/13058)) ([3388827](https://github.com/morluto/rea/commit/338882782e3b58cde3b03200af2ff4b638506029))
* **sourcemap:** verify the codec deadline outside the launcher ([dc16719](https://github.com/morluto/rea/commit/dc16719b04aebcace578996c8135946b6fffc905))
* **sqlite:** consolidate inventory column capacity checks ([#12798](https://github.com/morluto/rea/issues/12798)) ([d21636a](https://github.com/morluto/rea/commit/d21636ae071d6cd9223150a72e6a59d930ce9673))
* **sqlite:** consolidate inventory column capacity coverage ([d21636a](https://github.com/morluto/rea/commit/d21636ae071d6cd9223150a72e6a59d930ce9673))
* **sqlite:** consolidate retained views and journal coverage ([#12876](https://github.com/morluto/rea/issues/12876)) ([b38438b](https://github.com/morluto/rea/commit/b38438bab4ecac3b85bb7808e8af53a138c10d52))
* **trace:** assert adjustable nesting budget refusals ([#14647](https://github.com/morluto/rea/issues/14647)) ([7768770](https://github.com/morluto/rea/commit/77687702b3d0e375e8698128a5b4746022e8e4f6))
* **uefi:** consolidate extraction publication contracts ([#13627](https://github.com/morluto/rea/issues/13627)) ([9e0d132](https://github.com/morluto/rea/commit/9e0d132ef3c16649333a9dfd8c43f5ddd335fa80))
* **uefi:** consolidate volume ownership and checksum proofs ([#14070](https://github.com/morluto/rea/issues/14070)) ([df7f8b9](https://github.com/morluto/rea/commit/df7f8b9ead0dd472cd74803ea1bb90a62865fd4b))
* **uefi:** reuse the driver file across firmware fixtures ([#14570](https://github.com/morluto/rea/issues/14570)) ([e6a4965](https://github.com/morluto/rea/commit/e6a4965084b713d663c14e7e48cce8a30c3f5ec5))
* **v8:** consolidate code cache parser and recovery coverage ([#12784](https://github.com/morluto/rea/issues/12784)) ([8af645c](https://github.com/morluto/rea/commit/8af645c25c7f36f6be74d4baff4aee6d8b422d75))
* **v8:** consolidate code-cache parser and recovery coverage ([8af645c](https://github.com/morluto/rea/commit/8af645c25c7f36f6be74d4baff4aee6d8b422d75))
* **v8:** consolidate relative CLI and source-byte checks ([#12867](https://github.com/morluto/rea/issues/12867)) ([aa16513](https://github.com/morluto/rea/commit/aa1651311d27a4a0a224d00f427eaee9c4fd1387))
* **v8:** cover the six-word code cache header ([978cc6d](https://github.com/morluto/rea/commit/978cc6d46bb663cb97244a758205e0988a238deb))
* **verification:** consolidate fixture retry and process lineage checks ([#13237](https://github.com/morluto/rea/issues/13237)) ([4f64006](https://github.com/morluto/rea/commit/4f640064a4c743dd1b912c0e72c1ebf063ca00d6))
* **wasm:** consolidate WABT and glue parser checks ([c11e73b](https://github.com/morluto/rea/commit/c11e73bd642cee0e12f0dfd7826d412dd9332506))
* **wasm:** consolidate WABT output and glue scanner checks ([#12822](https://github.com/morluto/rea/issues/12822)) ([c11e73b](https://github.com/morluto/rea/commit/c11e73bd642cee0e12f0dfd7826d412dd9332506))
* **web:** acknowledge CDP socket timeout phases before advancing time ([#13181](https://github.com/morluto/rea/issues/13181)) ([8691cfa](https://github.com/morluto/rea/commit/8691cfa96b9130262491b7af991583c1aca63f1d))
* **web:** consolidate accessibility and storage comparison proofs ([#13085](https://github.com/morluto/rea/issues/13085)) ([3f494e1](https://github.com/morluto/rea/commit/3f494e18fa6aac74199bda740a11c6c94e242d5c))
* **web:** consolidate artifact cleanup ownership proofs ([#13077](https://github.com/morluto/rea/issues/13077)) ([82224d9](https://github.com/morluto/rea/commit/82224d9f6ccd845a87ff9ff45643c560e4c625f5))
* **web:** consolidate attached emulation and CDP admission checks ([#13156](https://github.com/morluto/rea/issues/13156)) ([32549cb](https://github.com/morluto/rea/commit/32549cb3f535ca61bb8441b790531116b047fe88))
* **web:** consolidate attached navigation stop checks ([#13143](https://github.com/morluto/rea/issues/13143)) ([ad6e511](https://github.com/morluto/rea/commit/ad6e511b60b6288ce413ff91e4a8ee7302319aaa))
* **web:** consolidate browser artifact privacy checks ([#13150](https://github.com/morluto/rea/issues/13150)) ([f609aa3](https://github.com/morluto/rea/commit/f609aa3393fba07dbd27e7ad5de6c7a0e930fc34))
* **web:** consolidate browser event ownership checks ([#13135](https://github.com/morluto/rea/issues/13135)) ([3eff450](https://github.com/morluto/rea/commit/3eff45097763704a45b9830c6cc15ebaec45828a))
* **web:** consolidate browser opening deadlines and late release checks ([#13158](https://github.com/morluto/rea/issues/13158)) ([52437cd](https://github.com/morluto/rea/commit/52437cd431968aef3c03d3673fe31a6487d9efa4))
* **web:** consolidate browser provider observation checks ([#13154](https://github.com/morluto/rea/issues/13154)) ([c23aa49](https://github.com/morluto/rea/commit/c23aa499f669ed09f7636724a8ef5f45ae9412e4))
* **web:** consolidate browser session cleanup receipts ([#13146](https://github.com/morluto/rea/issues/13146)) ([65038fa](https://github.com/morluto/rea/commit/65038faf7e0fc424df2f764aa56d34b853c7e3dc))
* **web:** consolidate browser session initialization cleanup checks ([#13144](https://github.com/morluto/rea/issues/13144)) ([811e26d](https://github.com/morluto/rea/commit/811e26d339aa75e62531761557eb85b338d5b78a))
* **web:** consolidate Browser worker inventory proofs ([#13098](https://github.com/morluto/rea/issues/13098)) ([e6df39b](https://github.com/morluto/rea/commit/e6df39bbba9c434942e742540b41c9e39a368bb3))
* **web:** consolidate capture completeness proofs ([#13089](https://github.com/morluto/rea/issues/13089)) ([2d9c208](https://github.com/morluto/rea/commit/2d9c2088173067c8004eb379b47e03f1a374b502))
* **web:** consolidate CDP binary body proofs ([#13097](https://github.com/morluto/rea/issues/13097)) ([1585513](https://github.com/morluto/rea/commit/15855137b79de905bb63e4a6afdf08c8410ed865))
* **web:** consolidate CDP browser socket identity checks ([#13180](https://github.com/morluto/rea/issues/13180)) ([4f9ce44](https://github.com/morluto/rea/commit/4f9ce44908ff2e5bdfc3f391fee2a1777ece3da6))
* **web:** consolidate CDP command settlement checks ([#13110](https://github.com/morluto/rea/issues/13110)) ([80b980e](https://github.com/morluto/rea/commit/80b980e5f43102aa1985727a2535a510cd85d2e5))
* **web:** consolidate CDP context retention proofs ([#13090](https://github.com/morluto/rea/issues/13090)) ([cc24a0b](https://github.com/morluto/rea/commit/cc24a0b4c0416f4643967398f8c7dfb6a298de8f))
* **web:** consolidate CDP discovery and HTTP response contracts ([#13173](https://github.com/morluto/rea/issues/13173)) ([b95bd81](https://github.com/morluto/rea/commit/b95bd814a7126f7aca445f0ad7efdbbee788bd9e))
* **web:** consolidate CDP document selection cases ([#13183](https://github.com/morluto/rea/issues/13183)) ([ce61cca](https://github.com/morluto/rea/commit/ce61cca68a6ecf9d11f3d348c2e2fc7126be46c4))
* **web:** consolidate CDP frame and session identity checks ([#13174](https://github.com/morluto/rea/issues/13174)) ([48a2ad5](https://github.com/morluto/rea/commit/48a2ad5e0b64f4bce322584a24150b1b79ccdcbb))
* **web:** consolidate CDP handshake and transport cleanup checks ([#13177](https://github.com/morluto/rea/issues/13177)) ([10e1a5a](https://github.com/morluto/rea/commit/10e1a5ab25773749be49756548ae41e9c63ecc90))
* **web:** consolidate CDP policy and metadata proofs ([#13102](https://github.com/morluto/rea/issues/13102)) ([de6e5ff](https://github.com/morluto/rea/commit/de6e5ff9e0bb5cbc9255dfdf025924ad0d2ea50a))
* **web:** consolidate CDP request identity and redirect proofs ([#13096](https://github.com/morluto/rea/issues/13096)) ([9a16142](https://github.com/morluto/rea/commit/9a16142fad208c1c8c1abef5bb401172b09f086f))
* **web:** consolidate CDP resource metadata proofs ([#13103](https://github.com/morluto/rea/issues/13103)) ([3ef94f1](https://github.com/morluto/rea/commit/3ef94f1f338349ad1aecb2ec3ea8f7d9217f9fc5))
* **web:** consolidate CDP response body lifecycle proofs ([#13094](https://github.com/morluto/rea/issues/13094)) ([e76b521](https://github.com/morluto/rea/commit/e76b521461b64907795435eba9db5b79e0af2e3e))
* **web:** consolidate CDP response status proofs ([#13095](https://github.com/morluto/rea/issues/13095)) ([68f13d0](https://github.com/morluto/rea/commit/68f13d06d22ba9b5a57788c3aba29c7bd6a3dd70))
* **web:** consolidate CDP wire reply and event checks ([#13175](https://github.com/morluto/rea/issues/13175)) ([ae2c214](https://github.com/morluto/rea/commit/ae2c2142a3a7879c08809b1aeca72d213c4488b1))
* **web:** consolidate Chromium startup contract checks ([#13157](https://github.com/morluto/rea/issues/13157)) ([6961a8c](https://github.com/morluto/rea/commit/6961a8c47cbf349a286295abf5fb78f383d45abe))
* **web:** consolidate DOM base URL and origin checks ([#13108](https://github.com/morluto/rea/issues/13108)) ([15d5119](https://github.com/morluto/rea/commit/15d511951f9e759c5c8601267f71e7a54c0f0a5e))
* **web:** consolidate DOM snapshot position and SVG proofs ([#13104](https://github.com/morluto/rea/issues/13104)) ([4ad0e3e](https://github.com/morluto/rea/commit/4ad0e3ea786dfc2fe1784ca8d2d3e8328637ad9c))
* **web:** consolidate event admission budget checks ([#13137](https://github.com/morluto/rea/issues/13137)) ([ad20b4e](https://github.com/morluto/rea/commit/ad20b4e1fcda12736705cdb2a39410ef0b461ebd))
* **web:** consolidate exact response number checks ([#13118](https://github.com/morluto/rea/issues/13118)) ([fba0e43](https://github.com/morluto/rea/commit/fba0e43af3292a57d07420bb1db2c6e388d23a10))
* **web:** consolidate final event privacy checks ([#13138](https://github.com/morluto/rea/issues/13138)) ([bbadf6e](https://github.com/morluto/rea/commit/bbadf6ebf4172daef81158749829fc08747ba322))
* **web:** consolidate interrupted module resolution evidence ([#13072](https://github.com/morluto/rea/issues/13072)) ([f63915d](https://github.com/morluto/rea/commit/f63915d6f2bc55328bd3e38a337079b127d8113d))
* **web:** consolidate marked response redaction checks ([#13131](https://github.com/morluto/rea/issues/13131)) ([c53c701](https://github.com/morluto/rea/commit/c53c7018e4f9fa6776c631b6e71e8a817509597e))
* **web:** consolidate module context and resolver evidence checks ([#13071](https://github.com/morluto/rea/issues/13071)) ([56a0617](https://github.com/morluto/rea/commit/56a0617f518432f14ba981c8c55f1b920f857f5e))
* **web:** consolidate module syntax and capture identity fixtures ([#13073](https://github.com/morluto/rea/issues/13073)) ([8322b55](https://github.com/morluto/rea/commit/8322b555523ed83aa895af5e4ff666023ca511fc))
* **web:** consolidate network capture queue lifecycle checks ([#13125](https://github.com/morluto/rea/issues/13125)) ([9a9ee6c](https://github.com/morluto/rea/commit/9a9ee6cf3d97fffea4849902872ad9b028cbc54f))
* **web:** consolidate network content evidence checks ([#13128](https://github.com/morluto/rea/issues/13128)) ([c20ee87](https://github.com/morluto/rea/commit/c20ee87b2b849846d5959339670dd0b48ba3df0e))
* **web:** consolidate passive capture comparison coverage ([#13200](https://github.com/morluto/rea/issues/13200)) ([286d599](https://github.com/morluto/rea/commit/286d599e9f42a4a509a3006b0551e1f18006a2f2))
* **web:** consolidate passive capture uncertainty checks ([#13083](https://github.com/morluto/rea/issues/13083)) ([9a66726](https://github.com/morluto/rea/commit/9a66726389aa74d4a7e49874d641ba085ae6c087))
* **web:** consolidate passive CDP admission proofs ([#13092](https://github.com/morluto/rea/issues/13092)) ([750120a](https://github.com/morluto/rea/commit/750120a4ce5405ca3b803287be8d522d21e341d9))
* **web:** consolidate passive CDP event fact proofs ([#13093](https://github.com/morluto/rea/issues/13093)) ([47a108e](https://github.com/morluto/rea/commit/47a108e64e3cf981901673e2bb795bace99235b8))
* **web:** consolidate passive CDP response header proofs ([#13099](https://github.com/morluto/rea/issues/13099)) ([97f10e8](https://github.com/morluto/rea/commit/97f10e8957811bcabd8393d2dd2f2427d7ee9388))
* **web:** consolidate passive HTTP metadata proofs ([#13087](https://github.com/morluto/rea/issues/13087)) ([e144285](https://github.com/morluto/rea/commit/e1442859dc492a666de9777547d9ac235528d89f))
* **web:** consolidate passive script map matching proofs ([#13088](https://github.com/morluto/rea/issues/13088)) ([e94475b](https://github.com/morluto/rea/commit/e94475bdccc5f122f53dbde5a162348c10de0567))
* **web:** consolidate provider shutdown and cleanup recovery checks ([#13152](https://github.com/morluto/rea/issues/13152)) ([5dad3b1](https://github.com/morluto/rea/commit/5dad3b1f291a9e5845f90d76ba4a45da39106964))
* **web:** consolidate redirect ancestry comparison proofs ([#13082](https://github.com/morluto/rea/issues/13082)) ([5b04c74](https://github.com/morluto/rea/commit/5b04c74ae05d3c5acf739f2941cd8d9145761f3d))
* **web:** consolidate request credential evidence checks ([#13129](https://github.com/morluto/rea/issues/13129)) ([2703239](https://github.com/morluto/rea/commit/270323942bd211463b67b3d7b18aa1ffb2c4eb90))
* **web:** consolidate request schema validation checks ([#13132](https://github.com/morluto/rea/issues/13132)) ([edff877](https://github.com/morluto/rea/commit/edff877c48542d4206e4b91f4fb07bf649aceb88))
* **web:** consolidate saved response retention checks ([#13133](https://github.com/morluto/rea/issues/13133)) ([4a249df](https://github.com/morluto/rea/commit/4a249dfde64a5c15a20066792a0573d78921f47d))
* **web:** consolidate saved scenario path checks ([#13122](https://github.com/morluto/rea/issues/13122)) ([b5cb5e2](https://github.com/morluto/rea/commit/b5cb5e2f0dd740993dc35a02c8d94068cf79df46))
* **web:** consolidate scenario alignment and ordering proofs ([#13078](https://github.com/morluto/rea/issues/13078)) ([b723393](https://github.com/morluto/rea/commit/b7233936118915a1f9c230873c95be08f7ae06e7))
* **web:** consolidate scenario capture schema coverage ([#13169](https://github.com/morluto/rea/issues/13169)) ([505cac1](https://github.com/morluto/rea/commit/505cac14878cebf56ac2ac939aaf51f82fd688f2))
* **web:** consolidate scenario deadline and diagnostic checks ([#13149](https://github.com/morluto/rea/issues/13149)) ([560de52](https://github.com/morluto/rea/commit/560de528a35ced86c4b719e62091011c43a4e193))
* **web:** consolidate scenario event coverage proofs ([#13079](https://github.com/morluto/rea/issues/13079)) ([2dc27d1](https://github.com/morluto/rea/commit/2dc27d164ab2c989d3fe06e8f1dcb2892366f686))
* **web:** consolidate scenario Evidence delivery checks ([#13161](https://github.com/morluto/rea/issues/13161)) ([8d17fcb](https://github.com/morluto/rea/commit/8d17fcb7a2ba1760112f37dc47be20404ba86a09))
* **web:** consolidate scenario Evidence promotion checks ([#13160](https://github.com/morluto/rea/issues/13160)) ([b0043f1](https://github.com/morluto/rea/commit/b0043f1fe45cae22b10d8d6ea5514892ccb96030))
* **web:** consolidate scenario input diagnostics ([#13159](https://github.com/morluto/rea/issues/13159)) ([0fa220c](https://github.com/morluto/rea/commit/0fa220c73598d21da80b4ede6fe32fbc3527928a))
* **web:** consolidate scenario process and cleanup coverage ([#13165](https://github.com/morluto/rea/issues/13165)) ([b5ba2f0](https://github.com/morluto/rea/commit/b5ba2f0f6e9b7404d95bf61260925d7c1541980d))
* **web:** consolidate scenario request cleanup checks ([#13116](https://github.com/morluto/rea/issues/13116)) ([ad4c558](https://github.com/morluto/rea/commit/ad4c558789289f42f3be74694080d5a99c4ad16d))
* **web:** consolidate scenario response body bounds ([#13120](https://github.com/morluto/rea/issues/13120)) ([6ae91b2](https://github.com/morluto/rea/commit/6ae91b2a10ee178c057c0afecf2c6a012824cdde))
* **web:** consolidate scenario startup redaction fixtures ([#13171](https://github.com/morluto/rea/issues/13171)) ([82d613e](https://github.com/morluto/rea/commit/82d613ec63fadad1940db06c5de2aaaeccb1e010))
* **web:** consolidate scenario storage identity checks ([#13115](https://github.com/morluto/rea/issues/13115)) ([447b791](https://github.com/morluto/rea/commit/447b79139c6b7a43a48c88a9838dfcd3e814ee9b))
* **web:** consolidate scenario transaction and context proofs ([#13081](https://github.com/morluto/rea/issues/13081)) ([3a60c55](https://github.com/morluto/rea/commit/3a60c55a91c3211fe087c572570c8e907d881e7e))
* **web:** consolidate screenshot document and reply checks ([#13107](https://github.com/morluto/rea/issues/13107)) ([383709c](https://github.com/morluto/rea/commit/383709ca7e2af26249d19143e3b6b1b736c6fb88))
* **web:** consolidate script metadata admission and projection proofs ([#13091](https://github.com/morluto/rea/issues/13091)) ([6878e24](https://github.com/morluto/rea/commit/6878e24cc75aba57f04e1d60aec9d39d19c3659d))
* **web:** consolidate service-worker initialization cancellation checks ([#13147](https://github.com/morluto/rea/issues/13147)) ([ad0bfa5](https://github.com/morluto/rea/commit/ad0bfa5bd081e4bd1ff62636dcc88661dc6111ca))
* **web:** consolidate service-worker policy lifecycle checks ([#13112](https://github.com/morluto/rea/issues/13112)) ([bb18055](https://github.com/morluto/rea/commit/bb18055d1234266a5d852f26f9b8d07e7ce4ac71))
* **web:** consolidate service-worker policy restoration checks ([#13145](https://github.com/morluto/rea/issues/13145)) ([cc81464](https://github.com/morluto/rea/commit/cc814643ab7fc4f817538c5f0cf5c879df2d9c3e))
* **web:** consolidate storage fingerprint comparison proofs ([#13084](https://github.com/morluto/rea/issues/13084)) ([251f863](https://github.com/morluto/rea/commit/251f863f30388f02017d0e34c790e529e8a7c183))
* **web:** consolidate transaction admission and omission checks ([#13127](https://github.com/morluto/rea/issues/13127)) ([c9a6f5d](https://github.com/morluto/rea/commit/c9a6f5dedc7766424e9d82d29a94d8ed39064fd9))
* **web:** consolidate UI response observation lifecycle checks ([#13121](https://github.com/morluto/rea/issues/13121)) ([648d1f8](https://github.com/morluto/rea/commit/648d1f8f9d45822fbb729492a9519d12d4cf6fa6))
* **web:** consolidate warm CDP peer cleanup checks ([#13179](https://github.com/morluto/rea/issues/13179)) ([faab3d9](https://github.com/morluto/rea/commit/faab3d98d1d26b3bbc395c5d89a8f90f076f57bb))
* **web:** consolidate WebSocket payload comparison proofs ([#13086](https://github.com/morluto/rea/issues/13086)) ([ccfdd61](https://github.com/morluto/rea/commit/ccfdd6157282d3eaaeb7e6cfe9779bbe445b6ac9))
* **web:** consolidate wide scenario reference admission ([#13163](https://github.com/morluto/rea/issues/13163)) ([03795d5](https://github.com/morluto/rea/commit/03795d55b3914a646a82d0e300836ce4c002b990))
* **web:** consolidate XHTML SVG namespace proofs ([#13105](https://github.com/morluto/rea/issues/13105)) ([c451857](https://github.com/morluto/rea/commit/c451857d380a809ba276b9c16f01865bd29494b0))
* **web:** control authorization retries and consolidate session termination ([#13196](https://github.com/morluto/rea/issues/13196)) ([905090c](https://github.com/morluto/rea/commit/905090c0ca5b6014e769421e844349c8b9054fcd))
* **web:** control CDP teardown timing and consolidate cleanup proof ([#13199](https://github.com/morluto/rea/issues/13199)) ([33d1c6e](https://github.com/morluto/rea/commit/33d1c6ee44773c7874fe3aeea0bb2e016e108e72))
* **web:** control scenario request deadline phases ([#13119](https://github.com/morluto/rea/issues/13119)) ([6ecafb5](https://github.com/morluto/rea/commit/6ecafb590e4c506ac932877580f07b60ed7d9e91))
* **web:** eliminate wall-clock waits from storage cleanup checks ([#13114](https://github.com/morluto/rea/issues/13114)) ([f27aa1a](https://github.com/morluto/rea/commit/f27aa1ad900477cc3620b82c39621ad1b3080b09))
* **web:** exercise browser setup recovery and cleanup grace ([#13148](https://github.com/morluto/rea/issues/13148)) ([436977b](https://github.com/morluto/rea/commit/436977b0e98187205b4e16bccea9d8ddc17c88d7))
* **web:** exercise encoded query limits across heap sizes ([#13123](https://github.com/morluto/rea/issues/13123)) ([c09a277](https://github.com/morluto/rea/commit/c09a27770fd123bcb26204f7730dbd824cd6971b))
* **web:** exercise provider cancellation through a real session boundary ([#13155](https://github.com/morluto/rea/issues/13155)) ([3704869](https://github.com/morluto/rea/commit/37048691997fdef1e22227b7f5d60e09e19043fd))
* **web:** exercise real browser release during scenario cleanup ([#13113](https://github.com/morluto/rea/issues/13113)) ([3c4450a](https://github.com/morluto/rea/commit/3c4450ac7e81bbd82d7d2eff847c9b92476679ec))
* **web:** isolate captured module artifact checks ([#13075](https://github.com/morluto/rea/issues/13075)) ([4304a66](https://github.com/morluto/rea/commit/4304a6697446f2342a7052b580306c521d944a73))
* **web:** make CDP discovery deadline checks deterministic ([#13109](https://github.com/morluto/rea/issues/13109)) ([5521bff](https://github.com/morluto/rea/commit/5521bff467d110a774cfc7390f418f1d0f41ed7e))
* **website:** consolidate generated site verification checks ([#12783](https://github.com/morluto/rea/issues/12783)) ([e174349](https://github.com/morluto/rea/commit/e17434945f0d1108018363db379eb1c65c7eeb81))
* **website:** consolidate verifier and fallback coverage ([e174349](https://github.com/morluto/rea/commit/e17434945f0d1108018363db379eb1c65c7eeb81))
* **web:** tighten event receipt and listener budget checks ([#13142](https://github.com/morluto/rea/issues/13142)) ([81b2934](https://github.com/morluto/rea/commit/81b293448eb85527890e1facfd3f9c631920d915))
* **web:** use the file MCP session in HAR boundary fact tests ([4f486d5](https://github.com/morluto/rea/commit/4f486d5262a6b5350114800c6d2a24d1c9fc7bed))
* **web:** verify importer integrity through Chromium ([#13076](https://github.com/morluto/rea/issues/13076)) ([ca1c328](https://github.com/morluto/rea/commit/ca1c3284ba825f4e757cd5d8011b7127cc8e5749))
* **web:** verify network content source event provenance ([#13130](https://github.com/morluto/rea/issues/13130)) ([c3dbbd4](https://github.com/morluto/rea/commit/c3dbbd4ab58e432ba36a70c65c09857be5726e1f))
* **windows:** consolidate executable lookup and cancellation coverage ([#12894](https://github.com/morluto/rea/issues/12894)) ([56682a7](https://github.com/morluto/rea/commit/56682a75c153ad4e8c0f1d1e55cad79555cebb68))
* **windows:** consolidate Job Object settlement and output polling checks ([#12893](https://github.com/morluto/rea/issues/12893)) ([0ed5f76](https://github.com/morluto/rea/commit/0ed5f7671349917937ad9ca7068e315b238ad1a9))
* **zip:** consolidate archive coverage and name checks ([#12857](https://github.com/morluto/rea/issues/12857)) ([ae449a3](https://github.com/morluto/rea/commit/ae449a3021f5cc573351aaa9acd9a6bf218ff420))


### Continuous Integration

* **apple:** discover and run every macOS-gated test on macOS ([fa2776d](https://github.com/morluto/rea/commit/fa2776d065f51b65d88348dc80ffc4b5a0a14834))
* **apple:** give the macOS lane room for the discovered macOS-gated tests ([8d31a29](https://github.com/morluto/rea/commit/8d31a29daaadd208c6ba293641be83541e6d7907))
* **apple:** run the bundle executable provenance regression on macOS ([5d136df](https://github.com/morluto/rea/commit/5d136df3ce720385a7cb33137bf77962733c08aa))
* **apple:** run the macOS lane when a pull request changes a macOS-gated test ([3280b1a](https://github.com/morluto/rea/commit/3280b1a66963aaa27d516c19f0cd55df62713955))
* build the runtime in the deep static job explicitly ([c22c1ab](https://github.com/morluto/rea/commit/c22c1ab1795677b7a52a840d30257cb1cad28ee7))
* compare frozen selections with observed test failures ([#14301](https://github.com/morluto/rea/issues/14301)) ([54f6fd4](https://github.com/morluto/rea/commit/54f6fd4f907caef76127c7e377ef181c0b5a4a82))
* **deps:** update the CodeQL action to 4.39.5 ([#14926](https://github.com/morluto/rea/issues/14926)) ([1d05636](https://github.com/morluto/rea/commit/1d056364b1cf19517b453f7bfa060e88294d00c7))
* **deps:** upgrade Pages, artifact transfers and cache actions together ([#8128](https://github.com/morluto/rea/issues/8128)) ([d957d43](https://github.com/morluto/rea/commit/d957d43ec196a498dc1c9540edbbad809f471e52))
* **deps:** upgrade setup-node to 7.1.0 and preserve explicit npm cache policy ([#8133](https://github.com/morluto/rea/issues/8133)) ([3075064](https://github.com/morluto/rea/commit/3075064d692b06668900eb4c1805d88df22dcf96))
* fit the binary layout toolchain download into three attempts ([f781e31](https://github.com/morluto/rea/commit/f781e310916e3d93d5fa0671132b9ce29fcf1c51))
* **limits:** enforce numeric inventory drift on documentation changes ([#12881](https://github.com/morluto/rea/issues/12881)) ([aaf151f](https://github.com/morluto/rea/commit/aaf151f5d6cca927823ac605699e587dfca2c043))
* measure portable runner time for recorded selection predictions ([#14304](https://github.com/morluto/rea/issues/14304)) ([24f35b4](https://github.com/morluto/rea/commit/24f35b401867904e23869698d3490a1894916fe1))
* **mutation:** run four Stryker workers on the sweep's 4-vCPU runner ([#15001](https://github.com/morluto/rea/issues/15001)) ([0c7ebd6](https://github.com/morluto/rea/commit/0c7ebd68c4818a55cdd013ac73ccd9b41e141e07))
* publish the portable build cache only for selected consumers ([#14307](https://github.com/morluto/rea/issues/14307)) ([2b818e0](https://github.com/morluto/rea/commit/2b818e0dbf6df8583cd36307b29406fc0d047f55))
* record affected-test predictions above the live cutoff ([#14300](https://github.com/morluto/rea/issues/14300)) ([e6bf4af](https://github.com/morluto/rea/commit/e6bf4af1c913dd1b3d04c632298c6db045f1e95f))
* **release:** preserve unpublished versions and verify npm before tagging ([#12770](https://github.com/morluto/rea/issues/12770)) ([ad2b34c](https://github.com/morluto/rea/commit/ad2b34ca9b30769ec8ff8ef26025a38a9a32c589))
* resume hosted APT package downloads across bounded attempts ([d87c365](https://github.com/morluto/rea/commit/d87c3659505ef5d586945d342425881a1918beb1))
* retry transient failures of pinned release downloads ([1919f7e](https://github.com/morluto/rea/commit/1919f7ef67abf4cf19149692f27e023941a738e5))
* run Knip in the build job on every code change ([b546063](https://github.com/morluto/rea/commit/b5460632c945f471766a96c59cbf57cd5cd007b8))
* run the verified actionlint release binary ([#14309](https://github.com/morluto/rea/issues/14309)) ([21facfd](https://github.com/morluto/rea/commit/21facfdeac604d6afcb7ce4495388c2d8afaae63))
* shallow-checkout the classifier for qualification runs ([#14312](https://github.com/morluto/rea/issues/14312)) ([b73cc58](https://github.com/morluto/rea/commit/b73cc58925f09c08dca88cbbe1e04d7182cf7643))
* validate workflow anchors with actionlint 1.7.12 ([#14298](https://github.com/morluto/rea/issues/14298)) ([f919526](https://github.com/morluto/rea/commit/f9195263d0ae23df996d28f4a7bf848067d936fa))
* wait for static checks before broad PR test shards ([#14299](https://github.com/morluto/rea/issues/14299)) ([b8dd2c4](https://github.com/morluto/rea/commit/b8dd2c47d46419b0d82d03c1de2f261b7ffe3f73))
* **windows:** run the caller path separator regression in the Windows lane ([#4988](https://github.com/morluto/rea/issues/4988)) ([21cfc80](https://github.com/morluto/rea/commit/21cfc809bc9465b4c39d0f14874bdbbd58159f44))

## [6.10.1](https://github.com/morluto/rea/compare/rea-agents-6.10.0...rea-agents-6.10.1) (2026-11-20)


### Bug Fixes

* **kuna:** use one constant for the serial job count ([#12735](https://github.com/morluto/rea/issues/12735)) ([3e3faf2](https://github.com/morluto/rea/commit/3e3faf2fc32dbadc96a45f51f4361eb64ce6ed32))

## [6.10.0](https://github.com/morluto/rea/compare/rea-agents-6.9.0...rea-agents-6.10.0) (2026-11-20)

### Highlights

- Inspect and extract UEFI firmware volumes, files, and AMI NVRAM with three offline CLI and MCP tools. [#12342](https://github.com/morluto/rea/pull/12342). Thanks @bartman081523.
- Inspect Android boot images and OTA payloads, NES 2.0 containers, and Maven, Gradle, and NuGet package metadata. [a88c0a5](https://github.com/morluto/rea/commit/a88c0a55544e16a710ddaad2feb5a2c6e7011f4e) [#9487](https://github.com/morluto/rea/pull/9487) [#11378](https://github.com/morluto/rea/pull/11378) [#10674](https://github.com/morluto/rea/pull/10674) [05be423](https://github.com/morluto/rea/commit/05be423acbdf3a56673bdbd3004e4b500c0f5217) [#10353](https://github.com/morluto/rea/pull/10353) [43b9fa8](https://github.com/morluto/rea/commit/43b9fa87fbbaa74224731a1fe3a8e67a2d336ae3) [#10351](https://github.com/morluto/rea/pull/10351) [#8144](https://github.com/morluto/rea/issues/8144). Thanks @Davmunrey, @gensokyo-dev, @jayykernel, @mvanhorn.
- Evidence revision 2 gives file, process, debugger, and browser observations explicit subject identities. See the migration details below.
- The verified Ghidra 12.2 lane opens recognized DOS COM files and supports more RISC-V, MIPS32, and PowerPC64 ELF targets. [#4811](https://github.com/morluto/rea/pull/4811) [#4487](https://github.com/morluto/rea/issues/4487) [#2362](https://github.com/morluto/rea/pull/2362) [#2338](https://github.com/morluto/rea/issues/2338) [#12517](https://github.com/morluto/rea/pull/12517) [#12085](https://github.com/morluto/rea/issues/12085). Thanks @abhay-2108, @AurelioB, @Davmunrey, @kaoru0822-kitauji, @Rinkia.

### Changes

- JavaScript semantic indexing uses fixed object shapes for nested evaluation contexts to reduce allocation overhead. [#9007](https://github.com/morluto/rea/pull/9007). Thanks @mshzy.
- Inspect ELF dynamic dependencies and required symbol versions, resolve separate debug-file linkage, inspect DWARF compilation units offline, and decode FDO packaging and dlopen notes. [e9c72db](https://github.com/morluto/rea/commit/e9c72dbd1fa6b318cb3e455c92df064eed62333a) [#7868](https://github.com/morluto/rea/pull/7868) [54e3918](https://github.com/morluto/rea/commit/54e3918d1c09991970aadf8f0eb1ab6bcf6f83fb) [#9560](https://github.com/morluto/rea/pull/9560) [637e4cb](https://github.com/morluto/rea/commit/637e4cb60c99b1b17026855297cb03e299c3ba89) [#8523](https://github.com/morluto/rea/pull/8523) [#7237](https://github.com/morluto/rea/pull/7237) [#7235](https://github.com/morluto/rea/issues/7235). Thanks @AniketR10, @gensokyo-dev, @mvanhorn.
- Read cargo-auditable dependencies from WebAssembly and export Go and Rust dependency Evidence as CycloneDX. [#5069](https://github.com/morluto/rea/pull/5069) [237b1ea](https://github.com/morluto/rea/commit/237b1ea5b39ea9fc5373aa08a9f54d25715c4873) [#8445](https://github.com/morluto/rea/pull/8445). Thanks @gensokyo-dev, @kaoru0822-kitauji, @mvanhorn, @yu0809.
- Decode CPython 3.14 and 3.15 bytecode and use Kuna 1.1000. [1d08253](https://github.com/morluto/rea/commit/1d08253ff2cb68838b93cf9275000c39bf1f507a) [#10518](https://github.com/morluto/rea/pull/10518) [#12107](https://github.com/morluto/rea/pull/12107). Thanks @abhisheksharma001, @gensokyo-dev, @N0zoM1z0.
- Managed member inspection retains `unresolved_definitions` and summarizes unresolved definition coordinates. Native inspection surfaces prototype instruction conflicts, resolves RISC-V initializer pointers, and identifies which Mach-O slices a signature covers. [#12462](https://github.com/morluto/rea/pull/12462) [#8161](https://github.com/morluto/rea/pull/8161) [#1244](https://github.com/morluto/rea/issues/1244) [#12109](https://github.com/morluto/rea/pull/12109) [#11620](https://github.com/morluto/rea/pull/11620). Thanks @akshad-exe, @N0zoM1z0, @ShuaixinHuang.
- GDB and Rizin explain why stopped sessions reject commands and why a debugger stop or close could not finish. [#11652](https://github.com/morluto/rea/pull/11652) [#11517](https://github.com/morluto/rea/pull/11517) [#11185](https://github.com/morluto/rea/pull/11185).
- Setup manages fx, Junie, Goose, and Kilo registrations, supports explicit MCP catalog profile selection, and flags a shared `enable: false` as a manual conflict. Compact MCP input schemas use a portable advertised dialect. [#10709](https://github.com/morluto/rea/pull/10709) [#9354](https://github.com/morluto/rea/pull/9354) [#11019](https://github.com/morluto/rea/pull/11019) [#10632](https://github.com/morluto/rea/pull/10632). Thanks @kaoru0822-kitauji.
- Reader errors name failed integrity checks and enforced limits. Bridge refusals identify whether the request was sent, and recovery names the relevant control or the next operation for an oversized MCP result. [#11052](https://github.com/morluto/rea/pull/11052) [#11056](https://github.com/morluto/rea/pull/11056) [#11021](https://github.com/morluto/rea/pull/11021) [#11119](https://github.com/morluto/rea/pull/11119) [#11125](https://github.com/morluto/rea/pull/11125) [#11129](https://github.com/morluto/rea/pull/11129) [#11505](https://github.com/morluto/rea/pull/11505) [#11634](https://github.com/morluto/rea/pull/11634) [#11623](https://github.com/morluto/rea/pull/11623) [#11133](https://github.com/morluto/rea/pull/11133) [#11172](https://github.com/morluto/rea/pull/11172) [#11015](https://github.com/morluto/rea/pull/11015) [#11777](https://github.com/morluto/rea/pull/11777).

### Fixes

- Desktop Evidence retains dconf failures with empty stderr. APT inspection honors disabled deb822 stanzas, uses ASCII separators, preserves tokens and effective identities for one-line sources, and verifies single-stanza identities. Desktop application lookup honors hidden overrides and rejects malformed overrides or desktop group padding before masking IDs. [#10230](https://github.com/morluto/rea/pull/10230) [#10223](https://github.com/morluto/rea/issues/10223) [#12501](https://github.com/morluto/rea/pull/12501) [#12498](https://github.com/morluto/rea/issues/12498) [#12680](https://github.com/morluto/rea/pull/12680) [#12692](https://github.com/morluto/rea/pull/12692) [#12711](https://github.com/morluto/rea/pull/12711) [#12694](https://github.com/morluto/rea/issues/12694) [#12363](https://github.com/morluto/rea/pull/12363) [#12675](https://github.com/morluto/rea/pull/12675) [#12671](https://github.com/morluto/rea/issues/12671) [#12686](https://github.com/morluto/rea/pull/12686) [#12708](https://github.com/morluto/rea/pull/12708). Thanks @kaoru0822-kitauji, @Plastic-time, @ShuaixinHuang.
- Windows shortcut inspection handles pre-epoch timestamps and validates LinkInfo offsets and fixed-size ExtraData blocks. Windows executable discovery uses PATH/PATHEXT, continues past malformed entries, and refuses unresolved objdump or Rizin commands. Headless IDA stdio bounds executable discovery, handles Windows launchers, and retains failed-launch cleanup for retry. [#10305](https://github.com/morluto/rea/pull/10305) [#10303](https://github.com/morluto/rea/issues/10303) [#12403](https://github.com/morluto/rea/pull/12403) [#10361](https://github.com/morluto/rea/pull/10361) [422cff0](https://github.com/morluto/rea/commit/422cff00ab989e5c5eecbcf50ebb65ca271c8b87) [#10891](https://github.com/morluto/rea/pull/10891) [998faa4](https://github.com/morluto/rea/commit/998faa41189c6924bdb42d18dc584ec5a8775d71) [#10739](https://github.com/morluto/rea/pull/10739). Thanks @kaoru0822-kitauji, @wunianze666-netizen.
- Setup refresh preserves or repairs Hermes and Goose YAML aliases and merge-inherited settings, including inherited stdio transport. MCP records deferred schemas before protocol framing. [b138f52](https://github.com/morluto/rea/commit/b138f52e12fdda3942855232a2a5bb3ed50d0943) [#10430](https://github.com/morluto/rea/pull/10430) [#9351](https://github.com/morluto/rea/pull/9351). Thanks @kaoru0822-kitauji.
- Finalization keeps cancellation as the primary error when appropriate, captures cancellation during recovered-value publication, and preserves the initial failure after close. Cleanup reports live resources independently of failed closes, retains composite provider clients for retry, and combines provider cleanup failures while retaining their causes. Artifact readers also retain member stream failures during shutdown. [2e1e659](https://github.com/morluto/rea/commit/2e1e6593f266b859d2f0fc858d51ed2f280b6849) [#10645](https://github.com/morluto/rea/pull/10645) [#12589](https://github.com/morluto/rea/pull/12589) [#12599](https://github.com/morluto/rea/pull/12599) [#12591](https://github.com/morluto/rea/issues/12591) [#12002](https://github.com/morluto/rea/pull/12002) [#12489](https://github.com/morluto/rea/pull/12489) [#12487](https://github.com/morluto/rea/issues/12487). Thanks @anant8140, @Plastic-time.
- Browser capture admits relative Playwright trace paths through the CLI, validates large scenario reference lists, retains wide native numeric exclusions, reports capture-script semantic limits, keeps invalid CDP and Playwright response statuses unknown while preserving the trace’s reported status and error, bounds retained network-body verification memory, and speeds up script export conflict detection. [4822082](https://github.com/morluto/rea/commit/48220827c484ae0ecb82d3122ff74aa3e23859c8) [#10575](https://github.com/morluto/rea/pull/10575) [#10359](https://github.com/morluto/rea/pull/10359) [#10343](https://github.com/morluto/rea/pull/10343) [#10341](https://github.com/morluto/rea/issues/10341) [#11755](https://github.com/morluto/rea/pull/11755) [#11565](https://github.com/morluto/rea/issues/11565) [#12296](https://github.com/morluto/rea/pull/12296) [#12292](https://github.com/morluto/rea/issues/12292) [#12231](https://github.com/morluto/rea/pull/12231) [#12225](https://github.com/morluto/rea/pull/12225) [#12724](https://github.com/morluto/rea/pull/12724). Thanks @chessing234, @kaoru0822-kitauji, @ShuaixinHuang.
- JavaScript analysis retains large async chunk collections, proven property presence at reads, shared array-iterator prototype effects, projected array dependencies, and lexical ordering across standalone blocks. It preserves uncertainty before initialization and after immutable pattern targets, and fixes V8 code-cache header handling. CommonJS wrapper redeclarations no longer invent application owners. Destructuring retains dependencies across const aliases, inactive defaults, and nested numeric properties. [#10362](https://github.com/morluto/rea/pull/10362) [#12477](https://github.com/morluto/rea/pull/12477) [#7559](https://github.com/morluto/rea/issues/7559) [#12493](https://github.com/morluto/rea/pull/12493) [#12490](https://github.com/morluto/rea/issues/12490) [#12519](https://github.com/morluto/rea/pull/12519) [#12558](https://github.com/morluto/rea/pull/12558) [#12701](https://github.com/morluto/rea/pull/12701) [#12682](https://github.com/morluto/rea/pull/12682) [#12673](https://github.com/morluto/rea/pull/12673) [#10279](https://github.com/morluto/rea/pull/10279) [#12084](https://github.com/morluto/rea/pull/12084) [#12513](https://github.com/morluto/rea/pull/12513) [#12613](https://github.com/morluto/rea/pull/12613) [#12595](https://github.com/morluto/rea/pull/12595). Thanks @coygeek, @kaoru0822-kitauji, @SII-YDD, @XiaoBinGan.
- ELF readers preserve literal directories in origin expansion, decode 32-bit PRPSINFO values correctly, and retain readable build IDs beside compressed notes. They preserve GNU version slots and dynamic-string diagnostics and distinguish an exhausted string table from a capped scan. ELF admission validates dynamic table framing, section and zlib declarations, interpreter sizes, and dependency table extents, and preserves unwind budget facts. [#10215](https://github.com/morluto/rea/pull/10215) [#10189](https://github.com/morluto/rea/pull/10189) [#12674](https://github.com/morluto/rea/pull/12674) [#12685](https://github.com/morluto/rea/pull/12685) [#12678](https://github.com/morluto/rea/pull/12678) [#12693](https://github.com/morluto/rea/pull/12693) [#12445](https://github.com/morluto/rea/pull/12445) [#12193](https://github.com/morluto/rea/pull/12193) [#12113](https://github.com/morluto/rea/pull/12113) [#12344](https://github.com/morluto/rea/pull/12344) [#12308](https://github.com/morluto/rea/pull/12308). Thanks @kaoru0822-kitauji, @wunianze666-netizen, @XiaoBinGan.
- PE readers reject out-of-file resource directories before applying the entry budget, validate certificate framing before capacity checks, and bound TLS and export reads to declared section content. GGUF readers reserve framing for fields following metadata values. UEFI extraction accepts the same `max_volumes` and `max_files` scan controls as inspection. [#10375](https://github.com/morluto/rea/pull/10375) [#12336](https://github.com/morluto/rea/pull/12336) [#12432](https://github.com/morluto/rea/pull/12432) [#12338](https://github.com/morluto/rea/pull/12338) [#12538](https://github.com/morluto/rea/pull/12538).
- Gradle recognizes metadata via the root version marker, reports unfamiliar format versions, and preserves variant identity. Maven preserves qualified property keys and non-ASCII whitespace in POM version values, and matches declarations in the project namespace. NuGet handles OPC part-name equivalence and rejects invalid manifest relationship target modes. [#12488](https://github.com/morluto/rea/pull/12488) [#12648](https://github.com/morluto/rea/pull/12648) [#12677](https://github.com/morluto/rea/pull/12677) [#11860](https://github.com/morluto/rea/pull/11860) [#12672](https://github.com/morluto/rea/pull/12672) [#12691](https://github.com/morluto/rea/pull/12691) [#12684](https://github.com/morluto/rea/pull/12684) [#12714](https://github.com/morluto/rea/pull/12714). Thanks @ShuaixinHuang, @xu91102.
- Android mapping inspection reports residual signatures without a mapping member. Boot and OTA readers validate boot headers, vendor ramdisk tables, and OTA manifest and signature extents before capacity checks. MIPS inspection identifies unsupported Android relocation declarations. Harmony inspection matches manifests at exact archive-root paths. Deno lockfile inspection retains valid specifiers alongside undecodable rows. [#12494](https://github.com/morluto/rea/pull/12494) [#12396](https://github.com/morluto/rea/pull/12396) [#12395](https://github.com/morluto/rea/pull/12395) [#12431](https://github.com/morluto/rea/pull/12431) [#12397](https://github.com/morluto/rea/pull/12397) [#12700](https://github.com/morluto/rea/pull/12700) [#12667](https://github.com/morluto/rea/pull/12667).

- Mach-O parsing validates symbol extents before the hardening scan limit and maps high-backed segments in their declared virtual range. Hopper verifies the Mach-O profile signature before loader selection. ELF and Android OTA share exact-frame Zstandard decoding. [#12465](https://github.com/morluto/rea/pull/12465) [#12479](https://github.com/morluto/rea/pull/12479) [#12485](https://github.com/morluto/rea/pull/12485) [#12416](https://github.com/morluto/rea/pull/12416) [#12398](https://github.com/morluto/rea/issues/12398).
- GPU inspection reports malformed containers as `invalid_format` and validates standalone PTX encoding during discovery. Core-note reads respect the recorded source range, and PyInstaller and Swift readers check entry framing and vtable bounds before applying capacity ceilings. [#10644](https://github.com/morluto/rea/pull/10644) [#12707](https://github.com/morluto/rea/pull/12707) [#12634](https://github.com/morluto/rea/pull/12634) [#12622](https://github.com/morluto/rea/pull/12622) [#12627](https://github.com/morluto/rea/pull/12627).
- Go SBOM export retains local modules without Package URL namespaces. Managed inspection retains module identity when its name is unreadable. The reference-source importer preserves cancellation during policy-file cleanup, and process capture handles Darwin-helper exit without crashing the host. [#12293](https://github.com/morluto/rea/pull/12293) [#12441](https://github.com/morluto/rea/pull/12441) [#12323](https://github.com/morluto/rea/pull/12323) [#11714](https://github.com/morluto/rea/pull/11714). Thanks @IvenKooLab.
- MCP doctor honors output choices on argument errors. Capture image readers validate PNG headers, and trace and keyed-archive errors expose the enforced parser limit. Sigrok catalog scans retain selected decoder rows only. The documentation site resolves authored links to their published routes. [#2693](https://github.com/morluto/rea/pull/2693) [#12310](https://github.com/morluto/rea/pull/12310) [#12335](https://github.com/morluto/rea/pull/12335) [#12324](https://github.com/morluto/rea/pull/12324) [#12284](https://github.com/morluto/rea/pull/12284) [#12453](https://github.com/morluto/rea/pull/12453). Thanks @jasonchen505.

### ⚠ BREAKING CHANGES

- Evidence records and hand-built bundles require `evidence_format: 2`. Recreate older observations, bundles, and snapshots with 6.10. Re-exporting old observations does not update their identities. Read `subject.identity` in place of `subject.digest`, `subject.format`, and `subject.architecture` (file identities use `sha256`). Every record has a subject, using an explicit unknown identity when appropriate. Identity, including an artifact's selection, participates in Evidence IDs. Recreate 6.7-era artifact summaries before using `compare_artifacts`. [#11416](https://github.com/morluto/rea/pull/11416) [#10861](https://github.com/morluto/rea/pull/10861).
- Snapshots use `target: {kind, identity}` and a non-null `execution.subject: {identity, name, local_path}`. Binding errors use the same target shape. Universal Mach-O Evidence IDs include the selected slice. Live page tools and their views use a `{kind: "url", url, origin}` identity with credentials removed, null origin for opaque URLs, and null subject name and local path. Withheld or unreadable URLs retain an unknown identity. Recreate affected Evidence and snapshots. [#11551](https://github.com/morluto/rea/pull/11551) [PR 11559](https://github.com/morluto/rea/pull/11559/files).
- Process captures require `manifest.root_process`. Their subject identity is `{kind: "process", pid, start_time, executable_sha256}` when observed, `{kind: "unknown", reason: "not-observed"}` when the start identity could not be read, and `{kind: "unknown", reason: "withheld-by-caller"}` when PID normalization is enabled. Accept `cleanup_outcome: "cleaned"` on quiesced settlements. Recreate saved process Evidence. Existing omission semantics still apply: `raw_data` is omitted when it equals `data`, and `residual_unknowns` is omitted when there are none. [#11568](https://github.com/morluto/rea/pull/11568) [#10481](https://github.com/morluto/rea/pull/10481) [#8032](https://github.com/morluto/rea/issues/8032) [#10956](https://github.com/morluto/rea/pull/10956). Thanks @gensokyo-dev, @N0zoM1z0, @Rinkia, @wunianze666-netizen.
- Rizin command Evidence and GDB startup and console Evidence use `{kind: "session", session_kind, id, target}`. The session target identifies the initial launch file when REA can observe it. GDB accepts an optional executable. Without one, or when the file identity could not be observed, the target is unknown with reason `not-observed`. The binding describes the launch file only. The current inferior's identity requires a separate observation. Recreate debugger Evidence because its IDs change. [PR 11570](https://github.com/morluto/rea/pull/11570/files) [PR 11572](https://github.com/morluto/rea/pull/11572/files) [230db70](https://github.com/morluto/rea/commit/230db70fb473dd15928ae6c1a885f7e8a5507dae) [#11710](https://github.com/morluto/rea/pull/11710) [#11581](https://github.com/morluto/rea/issues/11581). Thanks @gensokyo-dev, @N0zoM1z0.
- Ghidra and Hopper profiles replace hand-bumped markers with `analysis_profile.parameters.producer` containing `rea_version` and `sources_sha256`. Ghidra drops `bridge_sources_sha256` and version suffixes on selection values. Hopper drops `function_dossier_coverage`. Profiles and Evidence IDs change. Open the target and save a fresh snapshot. [#11320](https://github.com/morluto/rea/pull/11320).
- Ghidra requires a supported 12.x build starting at 12.2 and a JDK within that build's declared range (25 or newer for the verified 12.2 build). For a DOS COM file accepted by ComLoader, read the reported `load_address` (now linear `0x100`). The BinaryLoader fallback still uses `1000:0100`. [#12081](https://github.com/morluto/rea/pull/12081) [#12086](https://github.com/morluto/rea/pull/12086).
- IDA attached registrations must explicitly set `"protocol": "native"` and use the native plugin endpoint for an open GUI database. Migrate legacy 1.4 proxy registrations to that mode or to an ida-pro-mcp 2.x supervisor in headless mode. `procedure_callers` is removed from IDA profiles, and IDA assembly/instruction tools drop the `may_show_ui` annotation. [#10846](https://github.com/morluto/rea/pull/10846) [#11546](https://github.com/morluto/rea/pull/11546) [#10516](https://github.com/morluto/rea/issues/10516).
- Use `rea mcp` or `rea --mcp` in place of `rea <command> --mcp`. Regenerate shell hooks with `rea completions <shell>` and update Markdown argument-diagnostic snapshots for the new rendering. Flag-shaped unknown MCP subcommands honor the selected output format. [7d502dd](https://github.com/morluto/rea/commit/7d502ddb0d8d80d0e16a80b0edc813f704e3ac31) [#11724](https://github.com/morluto/rea/pull/11724) [62014b5](https://github.com/morluto/rea/commit/62014b566d79c563933e32182c4e7515fd9a54e2) [#11742](https://github.com/morluto/rea/pull/11742) [#10583](https://github.com/morluto/rea/issues/10583) [#11654](https://github.com/morluto/rea/issues/11654). Thanks @gensokyo-dev, @N0zoM1z0.
- MCP rejects `full` input and output schema profiles. Remove those settings or select `compact`. An unset `REA_MCP_OUTPUT_SCHEMA_PROFILE` now means `off`; set it to `compact` to receive `tools/list[].outputSchema`. MCP limit errors omit `details.limit.cli_flag`; the CLI still supplies its own flag when applicable. [#10693](https://github.com/morluto/rea/pull/10693) [#11413](https://github.com/morluto/rea/pull/11413).
- Use absolute local paths in MCP calls to `inspect_pcap_capture`, `start_rizin_debug_session`, `start_gdb_session` (including `inferior_tty`), `load_frida_script`, and `instrument_with_frida`. CLI `--script-file` still accepts a relative path and records the resolved absolute `source_path`. [#11508](https://github.com/morluto/rea/pull/11508) [#11079](https://github.com/morluto/rea/issues/11079) [#11580](https://github.com/morluto/rea/pull/11580) [#11506](https://github.com/morluto/rea/issues/11506).
- Native `rea analyze` rejects JavaScript-only options such as `--integrity-policy` with `invalid_request` naming the flag. Pass those options only for JavaScript targets. For `inspect-managed-members --detail summary`, rename `--evidence-bundle <path>` to `--evidence_output <path>` and read `.summary` and `.evidence_bundle` in stdout. Publication failures use the shared error shape. Composite CLI failures such as those from `compare-managed-members` can carry completed inputs as `details.argument_observations[]` entries with `{argument, observation}`. [PR 10808](https://github.com/morluto/rea/pull/10808/files) [PR 10845](https://github.com/morluto/rea/pull/10845/files) [PR 10961](https://github.com/morluto/rea/pull/10961/files).
- For a missing, unreadable, or non-regular target-selected plist, decode `target_unavailable` with `details.path` and `reason` in place of `invalid_request` with input issues. Open a plist outside the current app bundle or resource root as a separate target. [#9754](https://github.com/morluto/rea/pull/9754) [#10798](https://github.com/morluto/rea/pull/10798). Thanks @Anandumv.
- In Cutter JSON command output, integers beyond JavaScript's safe range are decimal strings. Parse them with a lossless integer type. Cutter's `output_truncated` and `document_generation` may be null. Treat truncation as unknown and list sessions again before choosing `expected_generation`. GDB MI decodes `\e` to ESC instead of rejecting the record. [#12457](https://github.com/morluto/rea/pull/12457) [#10726](https://github.com/morluto/rea/pull/10726).
- ADB package output preserves whitespace in `version_name`. Decode `numeric_issues` and `coverage`; malformed `versionCode` and `user_id` declarations make coverage partial. For a malformed version token such as `45abc`, expect a `version_code` issue with reason `invalid_format`, an increased issue total, and a null version code unless a later valid declaration supplies it. [1adc3fa](https://github.com/morluto/rea/commit/1adc3fa5532c9ac96fe44620c051e943af45504c) [#10519](https://github.com/morluto/rea/pull/10519) [#7123](https://github.com/morluto/rea/issues/7123) [#7271](https://github.com/morluto/rea/issues/7271) [#7281](https://github.com/morluto/rea/issues/7281) [#7388](https://github.com/morluto/rea/issues/7388) [#7409](https://github.com/morluto/rea/issues/7409) [#7534](https://github.com/morluto/rea/issues/7534) [#7692](https://github.com/morluto/rea/issues/7692) [#8067](https://github.com/morluto/rea/issues/8067) [#8141](https://github.com/morluto/rea/issues/8141) [#8302](https://github.com/morluto/rea/issues/8302) [#9195](https://github.com/morluto/rea/issues/9195) [#10172](https://github.com/morluto/rea/issues/10172) [#10389](https://github.com/morluto/rea/issues/10389). Thanks @1052326311, @2SinceJuly, @carcraze, @coygeek, @deepakrakshit, @Eldergenix, @gensokyo-dev, @HeadmasterEggy, @Hiba-Malik, @kittimzhe, @mawahnnie, @N0zoM1z0, @Rinkia, @saariuslystoned, @ShuaixinHuang, @sx4im, @theo-73, @wunianze666-netizen.
- Update coverage decoders for native initializers and kernel build configs to accept `partial` for observed but incomplete coverage and `unknown` when completeness could not be established. ELF unwind ranges use `partial` in place of `incomplete`, and capped model metadata arrays use `partial` in place of `preview`. [#11483](https://github.com/morluto/rea/pull/11483) [#11486](https://github.com/morluto/rea/pull/11486) [#11463](https://github.com/morluto/rea/pull/11463) [#11469](https://github.com/morluto/rea/pull/11469).
- Managed member comparison uses tagged objects in `limitations[]`; read `code` and `side` in place of `limitation_reasons` or message prefixes. Recreate managed observations. Supply explicit nullable `assembly`, boolean `nesting_read`, and `signature_resolution` as `"type-names-v2"` or null. Null is only valid without examined members, references, call edges, or field accesses. The historical bare-name comparison mode is removed. Call edges and field accesses require `target_row_resolved`. [#11177](https://github.com/morluto/rea/pull/11177) [#10952](https://github.com/morluto/rea/pull/10952) [#11334](https://github.com/morluto/rea/pull/11334) [PR 10992](https://github.com/morluto/rea/pull/10992/files).
- Recreate JavaScript and Electron captures missing runtime `scripts.parse_failed_total` or active Electron `parameters.resolved_paths`. Application analysis requires `statistics.skipped_javascript_files` and `summary.protocol_registrations`. Original-source and module-edge links require `source_index` and `declaration_index`. [#10958](https://github.com/morluto/rea/pull/10958) [#10990](https://github.com/morluto/rea/pull/10990).
- Recreate browser captures using the current producers. Source-map items require `effective_url`, invalid maps require `response_identity`, and mapping rows require `source_index` and `declaration_index`. WebMCP declarations require `schema_property_names_coverage`. Storage results require `content_fingerprints`, `fingerprint_algorithm`, and `fingerprints_complete`; IndexedDB schema fingerprints require `projection_version: 2`. Link rows require `context_url` and `context_scope`. [PR 10991](https://github.com/morluto/rea/pull/10991/files) [PR 11002](https://github.com/morluto/rea/pull/11002/files).
- Browser page inspections require accessibility states, script `frame_id`, and worker `opener_target_id` and `parent_frame_id`. Web-bundle captures require `capture.target_origin`. Scenario network rows with a null redirect predecessor require `redirected_from_transaction_state`. In page network requests, include `redirects: []` when there are no redirects. DOM snapshots require `node_value_length_unit`, and redirect timeline rows require `redirect_response`. Recreate captures before comparing them, including inline inspections. Re-import reference sources so every `exclusions[]` row carries `entry_kind`, using the explicit unknown kind where applicable. [#11344](https://github.com/morluto/rea/pull/11344) [PR 11014](https://github.com/morluto/rea/pull/11014/files) [PR 10897](https://github.com/morluto/rea/pull/10897/files).
- Recreate PCAP Evidence with `dns_queries[].query_labels_hex` and explicit tshark/capinfos identity fields. Recreate desktop state Evidence with `effective_view_policy.sqlite_view_bytes`, SQLite Evidence with `worker_timeout_ms`, and Dart AOT Evidence with `string_pool.policy`. [PR 10879](https://github.com/morluto/rea/pull/10879/files) [PR 10886](https://github.com/morluto/rea/pull/10886/files).
- Recreate Android packages, component views, and reference observations with component declaration facets, `target_definition`, and `direct_invokes_coverage`. Declaration coverage and counts drop `unknown`; manifest views declare `facet: "manifest"`. JNI failures with kind `integrity` require `integrity_check`. [#11624](https://github.com/morluto/rea/pull/11624) [PR 10904](https://github.com/morluto/rea/pull/10904/files).
- Recreate native Evidence for Mach-O encryption, malformed slice causes, import facts and symbol `runtime_name`; ELF import/export encoding and export visibility; value-flow `limits`; load-image permissions and relocation symbols; Swift `type_reference_kind`; and GPU `amd_target_metadata`. Update strict readers for removed legacy values such as unknown ELF export visibility and `modinfo_field_exceeds_limit`. [PR 10946](https://github.com/morluto/rea/pull/10946/files).
- Recreate inventory Evidence missing ESP `format_metadata.flash_dump`, PE signer observations missing `unsigned_attribute_oids`, and firmware inspection or extraction results missing `analysis_timeout_ms`. [#11595](https://github.com/morluto/rea/pull/11595).

Full contribution record: [1589 commits and 1383 merged PRs](https://github.com/morluto/rea/blob/rea-agents-6.10.0/docs/releases/6.10.0.contributions.json).

## [6.9.0](https://github.com/morluto/rea/compare/rea-agents-6.8.0...rea-agents-6.9.0) (2026-11-11)

### Highlights

- Build and test desktop tasks from recorded application state, including downloaded Linux apps, reusable build computers and multiple tasks per capture.
- Inspect more shipped artifacts offline: standalone application bundles, embedded firmware, NTFS acquisitions, API contracts and V8 code-cache containers.
- Keep native and runtime investigations grounded in retained Evidence, with paged results, explicit coverage and recoverable resource limits.

### Changes

- Analyze targets and create private runtimes on fixed local ReFS volumes as well as NTFS, preserving persistent ACL, file identity, snapshot and cleanup checks. [#10086](https://github.com/morluto/rea/pull/10086). Thanks @QianNangong.
- Capture, export and witness desktop tasks inside a build computer; keep an agentenv computer available through MCP and prepare a build host from one command. [#8954](https://github.com/morluto/rea/pull/8954), [#9041](https://github.com/morluto/rea/pull/9041), [#9045](https://github.com/morluto/rea/pull/9045), [#9049](https://github.com/morluto/rea/pull/9049), [#9199](https://github.com/morluto/rea/pull/9199). Thanks @earakely-scale.
- Install desktop apps from SHA-256-pinned AppImages or upstream archives, retain selected package dependencies, and isolate explicitly declared build secrets. [#9215](https://github.com/morluto/rea/pull/9215), [#9112](https://github.com/morluto/rea/pull/9112), [#9225](https://github.com/morluto/rea/pull/9225). Thanks @earakely-scale.
- Choose seed/end checkpoints, open seed documents at launch, build several tasks from one capture, and evaluate unreadable app state through headless checks or a screen judge. [#9037](https://github.com/morluto/rea/pull/9037), [#9054](https://github.com/morluto/rea/pull/9054), [#9216](https://github.com/morluto/rea/pull/9216), [#9217](https://github.com/morluto/rea/pull/9217), [issue morluto/rea#9676](https://github.com/morluto/rea/issues/9676). Thanks @earakely-scale.
- Read gzip and XML desktop documents and draft assertions for nested fields, attribute text, child text and member counts. [#9050](https://github.com/morluto/rea/pull/9050), [#9111](https://github.com/morluto/rea/pull/9111), [#9114](https://github.com/morluto/rea/pull/9114), [#9132](https://github.com/morluto/rea/pull/9132), [#9185](https://github.com/morluto/rea/pull/9185). Thanks @earakely-scale.
- Inventory and extract .NET single-file, Bun standalone and Deno compile executables, with caller-selected entries and output destinations. [#3787](https://github.com/morluto/rea/pull/3787), [#4031](https://github.com/morluto/rea/pull/4031), [#6998](https://github.com/morluto/rea/pull/6998), [#8527](https://github.com/morluto/rea/pull/8527), [issue morluto/rea#2352](https://github.com/morluto/rea/issues/2352), [issue morluto/rea#3490](https://github.com/morluto/rea/issues/3490). Thanks @gensokyo-dev, @jsk1004ha, @matbrgz, @mvanhorn, @Rinkia, @Zhong-fan.
- Read UnityFS bundles, Godot 3 PCK archives, WeChat mini-program packages, Zstandard ZIP members and classic iNES regions. [#7699](https://github.com/morluto/rea/pull/7699), [#7781](https://github.com/morluto/rea/pull/7781), [#8148](https://github.com/morluto/rea/pull/8148), [#7780](https://github.com/morluto/rea/pull/7780), [#2816](https://github.com/morluto/rea/pull/2816). Thanks @blankym, @gensokyo-dev, @ShuaixinHuang, @XiaoBinGan, @Zhong-fan.
- Inspect and extract Intel HEX, Motorola S-record, U-Boot uImage/FIT, ESP flash, UF2 and DfuSe firmware regions while retaining their container declarations. [#7136](https://github.com/morluto/rea/pull/7136), [#7234](https://github.com/morluto/rea/pull/7234), [#7771](https://github.com/morluto/rea/pull/7771), [#7498](https://github.com/morluto/rea/pull/7498), [#8228](https://github.com/morluto/rea/pull/8228), [#8230](https://github.com/morluto/rea/pull/8230). Thanks @555aaditya, @Entrpi, @gensokyo-dev, @iamcipherdev.
- Inventory offline NTFS MFT records and paired USN journal acquisitions; retain source names, journal-version coverage and verified extension-attribute ownership. [#9911](https://github.com/morluto/rea/pull/9911), [#9914](https://github.com/morluto/rea/pull/9914), [#9957](https://github.com/morluto/rea/pull/9957), [#10006](https://github.com/morluto/rea/pull/10006), [issue morluto/rea#9867](https://github.com/morluto/rea/issues/9867). Thanks @2SinceJuly, @gensokyo-dev, @jayykernel, @N0zoM1z0.
- Inspect V8 code-cache headers and retained byte patterns without executing the cache; report Electron cachedData boundaries and custom URL protocol registrations. [#8993](https://github.com/morluto/rea/pull/8993), [#9501](https://github.com/morluto/rea/pull/9501), [#2978](https://github.com/morluto/rea/pull/2978). Thanks @2SinceJuly, @gensokyo-dev, @UnknownHacker1, @XiaoBinGan.
- Inventory local OpenAPI operations and GraphQL SDL fields/references; compare static JavaScript endpoints with HAR observations. [#9104](https://github.com/morluto/rea/pull/9104), [#9140](https://github.com/morluto/rea/pull/9140), [#9090](https://github.com/morluto/rea/pull/9090), [issue morluto/rea#3591](https://github.com/morluto/rea/issues/3591). Thanks @gensokyo-dev, @Y0UW1SH.
- Import saved Playwright v10 trace Evidence, page scenario summaries, reuse saved response values across steps, and validate browser scenarios offline. [#9127](https://github.com/morluto/rea/pull/9127), [#7120](https://github.com/morluto/rea/pull/7120), [#7267](https://github.com/morluto/rea/pull/7267), [#7343](https://github.com/morluto/rea/pull/7343), [issue morluto/rea#5488](https://github.com/morluto/rea/issues/5488), [issue morluto/rea#6167](https://github.com/morluto/rea/issues/6167). Thanks @debavelaerel, @earakely-scale, @gensokyo-dev, @jayykernel, @kaoru0822-kitauji, @z2Ace0107.
- Replay captured environment writes, including variable member sets, sorted creates, references, toggles and subsequent reads that explain the resulting state. [#7260](https://github.com/morluto/rea/pull/7260), [#7274](https://github.com/morluto/rea/pull/7274), [#7332](https://github.com/morluto/rea/pull/7332), [#7539](https://github.com/morluto/rea/pull/7539), [#7600](https://github.com/morluto/rea/pull/7600). Thanks @earakely-scale.
- Apply selected R8 mappings, inspect Android manifest component declarations, link static JNI candidates and trace callers of external DEX methods. [#7456](https://github.com/morluto/rea/pull/7456), [#7379](https://github.com/morluto/rea/pull/7379), [#7472](https://github.com/morluto/rea/pull/7472), [#8154](https://github.com/morluto/rea/pull/8154), [issue morluto/rea#4448](https://github.com/morluto/rea/issues/4448), [issue morluto/rea#6329](https://github.com/morluto/rea/issues/6329), [issue morluto/rea#6403](https://github.com/morluto/rea/issues/6403), [issue morluto/rea#7811](https://github.com/morluto/rea/issues/7811). Thanks @555aaditya, @coygeek, @gensokyo-dev, @harshjohiya, @jayykernel, @Rinkia, @xu91102.
- Expose managed field defaults, project retained member views, suggest Unity managed members and retain IL2CPP v108 header/string Evidence. [#8015](https://github.com/morluto/rea/pull/8015), [#7968](https://github.com/morluto/rea/pull/7968), [#5511](https://github.com/morluto/rea/pull/5511), [#9925](https://github.com/morluto/rea/pull/9925), [issue morluto/rea#7282](https://github.com/morluto/rea/issues/7282). Thanks @379061296, @8rulerstar, @dhruvac29, @Entrpi, @gensokyo-dev, @Henglie, @kaoru0822-kitauji, @ShuaixinHuang, @XiaoBinGan, @xu91102.
- Report ELF/PE/Mach-O hardening, per-slice Mach-O encryption, initializer/finalizer functions and ELF function ranges recovered from unwind tables. [#8524](https://github.com/morluto/rea/pull/8524), [#5359](https://github.com/morluto/rea/pull/5359), [#9574](https://github.com/morluto/rea/pull/9574), [#9585](https://github.com/morluto/rea/pull/9585), [issue morluto/rea#4306](https://github.com/morluto/rea/issues/4306). Thanks @chordpli, @coygeek, @gensokyo-dev, @mvanhorn.
- Read Linux core-dump process/mapping notes, kernel version/configuration data and Android ELF identity notes; join Apple IPS images to admitted Mach-O slices. [#8830](https://github.com/morluto/rea/pull/8830), [#9573](https://github.com/morluto/rea/pull/9573), [#9502](https://github.com/morluto/rea/pull/9502), [#9570](https://github.com/morluto/rea/pull/9570). Thanks @2SinceJuly, @mvanhorn, @rishikeshgowdakk, @saariuslystoned.
- Open native extension/framework/XPC/plugin bundles, retain LLDB source coordinates and recover bounded Go string literals from pointer/length headers. [#8117](https://github.com/morluto/rea/pull/8117), [#2800](https://github.com/morluto/rea/pull/2800), [#9206](https://github.com/morluto/rea/pull/9206). Thanks @kaoru0822-kitauji, @matbrgz, @saariuslystoned.
- Reuse Ghidra projects through verified copies and checkpoint owned Programs across sessions; add Windows P0 DOS MZ and RISC-V ilp32 admission. [#7236](https://github.com/morluto/rea/pull/7236), [#9236](https://github.com/morluto/rea/pull/9236), [#7144](https://github.com/morluto/rea/pull/7144), [#8229](https://github.com/morluto/rea/pull/8229), [issue morluto/rea#1048](https://github.com/morluto/rea/issues/1048). Thanks @akushonkamen, @corysutyak, @dark13b, @Entrpi, @gensokyo-dev.
- Retry failed Kuna or directory decompiles independently and preserve stored pointer references and decompile-export source facts. [#8793](https://github.com/morluto/rea/pull/8793), [#8811](https://github.com/morluto/rea/pull/8811), [#8851](https://github.com/morluto/rea/pull/8851), [#8805](https://github.com/morluto/rea/pull/8805).
- Read selected Evidence records and discover missing links without transferring whole bundles; aggregate retained comparison references and compare artifact inventories. [#8528](https://github.com/morluto/rea/pull/8528), [#8633](https://github.com/morluto/rea/pull/8633), [#8267](https://github.com/morluto/rea/pull/8267), [#7869](https://github.com/morluto/rea/pull/7869), [issue morluto/rea#7678](https://github.com/morluto/rea/issues/7678), [issue morluto/rea#8214](https://github.com/morluto/rea/issues/8214), [issue morluto/rea#8307](https://github.com/morluto/rea/issues/8307), [issue morluto/rea#8454](https://github.com/morluto/rea/issues/8454). Thanks @Entrpi, @gensokyo-dev, @kaoru0822-kitauji.
- Page retained native observations, procedure/instruction references, feature traces and batch decompile summaries instead of repeating complete results. [#7134](https://github.com/morluto/rea/pull/7134), [#7146](https://github.com/morluto/rea/pull/7146), [#8585](https://github.com/morluto/rea/pull/8585), [#8588](https://github.com/morluto/rea/pull/8588), [#8591](https://github.com/morluto/rea/pull/8591), [#8594](https://github.com/morluto/rea/pull/8594), [#8629](https://github.com/morluto/rea/pull/8629), [#8631](https://github.com/morluto/rea/pull/8631), [issue morluto/rea#8498](https://github.com/morluto/rea/issues/8498), [issue morluto/rea#8510](https://github.com/morluto/rea/issues/8510). Thanks @gensokyo-dev, @kaoru0822-kitauji.
- Expose guided workflows and installed guidance search through CLI/MCP, recover from common argument-name mistakes, and support CSV/TSV analysis views. [#6995](https://github.com/morluto/rea/pull/6995), [#6996](https://github.com/morluto/rea/pull/6996), [#8305](https://github.com/morluto/rea/pull/8305), [#8649](https://github.com/morluto/rea/pull/8649), [#7254](https://github.com/morluto/rea/pull/7254), [issue morluto/rea#2146](https://github.com/morluto/rea/issues/2146), [issue morluto/rea#5482](https://github.com/morluto/rea/issues/5482), [issue morluto/rea#6916](https://github.com/morluto/rea/issues/6916), [issue morluto/rea#6918](https://github.com/morluto/rea/issues/6918), [issue morluto/rea#8290](https://github.com/morluto/rea/issues/8290). Thanks @coygeek, @Deepak-Kambala, @gensokyo-dev, @HarsH-1877, @jayykernel, @kaoru0822-kitauji, @pablodiazjorge, @Tapraj-Pathak.
- Select MCP tool families and compact output schemas; refresh provider candidates without switching and inspect provider-selection/release-verification diagnostics. [#7228](https://github.com/morluto/rea/pull/7228), [#7218](https://github.com/morluto/rea/pull/7218), [#8487](https://github.com/morluto/rea/pull/8487), [#8485](https://github.com/morluto/rea/pull/8485), [#9171](https://github.com/morluto/rea/pull/9171), [#9603](https://github.com/morluto/rea/pull/9603), [issue morluto/rea#2512](https://github.com/morluto/rea/issues/2512), [issue morluto/rea#3246](https://github.com/morluto/rea/issues/3246), [issue morluto/rea#8403](https://github.com/morluto/rea/issues/8403), [issue morluto/rea#9134](https://github.com/morluto/rea/issues/9134), [issue morluto/rea#9136](https://github.com/morluto/rea/issues/9136). Thanks @0xLLVEL, @2SinceJuly, @akshad-exe, @codebuff-team, @gensokyo-dev, @Henglie, @phucicb-hub, @wu546526.
- Add non-executing process-scenario dry runs, opt-in command timings and caller-selected reference-source exclusions. [#8469](https://github.com/morluto/rea/pull/8469), [#7042](https://github.com/morluto/rea/pull/7042), [#2630](https://github.com/morluto/rea/pull/2630), [issue morluto/rea#2443](https://github.com/morluto/rea/issues/2443), [issue morluto/rea#5484](https://github.com/morluto/rea/issues/5484), [issue morluto/rea#8398](https://github.com/morluto/rea/issues/8398). Thanks @2SinceJuly, @dhruvac29, @gensokyo-dev, @jayykernel, @matbrgz, @trackoor, @YunzhouLi-hub.
- Make resource-budget failures actionable across CLI/MCP and read per-call limits from the selected operation snapshot. [#9706](https://github.com/morluto/rea/pull/9706), [#9889](https://github.com/morluto/rea/pull/9889), [issue morluto/rea#9881](https://github.com/morluto/rea/issues/9881).
- Ship self-contained Claude Code/Codex plugin installs and a Cursor Marketplace plugin; add CodeBuddy and LM Studio setup registration. [#7514](https://github.com/morluto/rea/pull/7514), [#9878](https://github.com/morluto/rea/pull/9878), [#2492](https://github.com/morluto/rea/pull/2492), [#8611](https://github.com/morluto/rea/pull/8611), [issue morluto/rea#2490](https://github.com/morluto/rea/issues/2490). Thanks @cainiao1992, @cpruijsen, @GamerDubz, @gensokyo-dev.
- Inspect Windows Shell Link files and qualify recognized Python 3.14/3.15 pyc headers; choose Rizin decoder and map address for one-shot commands. [#7859](https://github.com/morluto/rea/pull/7859), [#8927](https://github.com/morluto/rea/pull/8927), [#8991](https://github.com/morluto/rea/pull/8991), [issue morluto/rea#8206](https://github.com/morluto/rea/issues/8206). Thanks @Entrpi, @mvanhorn, @XiaoBinGan, @xuanhieu.
- Register REA with Cline through its native MCP client settings during setup. [#10128](https://github.com/morluto/rea/pull/10128), [issue morluto/rea#10127](https://github.com/morluto/rea/issues/10127). Thanks @bramrahmadi.

### Fixes

- Keep UnityFS directory and payload reads within the declared bundle, reject undersized declarations, and prevent appended bytes from replacing the inventory or increasing its work budget. [58a0511660](https://github.com/morluto/rea/commit/58a051166047442b947c604c3f7ccde6707ee9df).
- Validate runtime configuration before doctor reports readiness or registration writes files; preserve the source of malformed stored settings and proposed overrides. [#10102](https://github.com/morluto/rea/pull/10102).
- Retry owned inspection descriptors before fresh process queries, preserve physical failures alongside cancellation, and retain cleanup authority until release succeeds. [#10113](https://github.com/morluto/rea/pull/10113), [#10141](https://github.com/morluto/rea/pull/10141), [#10109](https://github.com/morluto/rea/pull/10109).
- Keep distinct linker-map occurrences when source-map declarations overlap, including path spellings that normalize to the same location. [aa017c61ff](https://github.com/morluto/rea/commit/aa017c61ff3803dea3b823664ae255c4059c19d4), [f668c86271](https://github.com/morluto/rea/commit/f668c862717fd1c63c649a04709191bbe86e4479).
- Preserve remote OpenCode registrations and Hermes YAML anchor consumers instead of treating REA-like text as proof of local ownership. [#5152](https://github.com/morluto/rea/pull/5152), [issue morluto/rea#3325](https://github.com/morluto/rea/issues/3325). Thanks @coygeek, @gensokyo-dev, @xu91102.
- Reject malformed UTF-8 CDP discovery replies, preserve partial Playwright-import Evidence, and retain initial child scope when replaying WebMCP scripts. [#4524](https://github.com/morluto/rea/pull/4524), [#9543](https://github.com/morluto/rea/pull/9543). Thanks @Afloat16, @Plastic-time.
- Report unsupported filesystem paths and host-capacity failures at the responsible adb input boundary; retain local filesystem error provenance. [#6188](https://github.com/morluto/rea/pull/6188). Thanks @chordpli.
- Preserve uncertainty when JavaScript alias walks exhaust their budget, keep unisolated program-var routes unknown, and analyze first-party code before dependencies. [#9387](https://github.com/morluto/rea/pull/9387), [#6778](https://github.com/morluto/rea/pull/6778), [#9341](https://github.com/morluto/rea/pull/9341), [issue morluto/rea#8201](https://github.com/morluto/rea/issues/8201), [issue morluto/rea#9321](https://github.com/morluto/rea/issues/9321). Thanks @gongfpp, @mvanhorn, @Rfxan, @xuanhieu, @yaneyba.
- Resolve relative ESM backslash paths and exported/computed initializers; reject TLS versions and child-process literals Node itself refuses. [#4323](https://github.com/morluto/rea/pull/4323), [#5387](https://github.com/morluto/rea/pull/5387), [#9557](https://github.com/morluto/rea/pull/9557), [#9594](https://github.com/morluto/rea/pull/9594), [issue morluto/rea#4269](https://github.com/morluto/rea/issues/4269). Thanks @6eanut, @ahmed-husssain, @coygeek, @XiaoBinGan.
- Validate PE certificate alignment, name structures and RDN grouping, and distinguish legacy Windows targets before PE header admission. [#9276](https://github.com/morluto/rea/pull/9276), [#9625](https://github.com/morluto/rea/pull/9625), [#10048](https://github.com/morluto/rea/pull/10048), [#10070](https://github.com/morluto/rea/pull/10070), [issue morluto/rea#10003](https://github.com/morluto/rea/issues/10003), [issue morluto/rea#9946](https://github.com/morluto/rea/issues/9946). Thanks @AixSxT, @coygeek, @gensokyo-dev, @N0zoM1z0, @ShuaixinHuang, @wunianze666-netizen.
- Retain UTF-8 ZIP names in desktop exports, resolve nested desktop-entry IDs, and preserve reader inspection failures. [#9431](https://github.com/morluto/rea/pull/9431), [#9563](https://github.com/morluto/rea/pull/9563), [#9773](https://github.com/morluto/rea/pull/9773), [issue morluto/rea#9449](https://github.com/morluto/rea/issues/9449), [issue morluto/rea#9558](https://github.com/morluto/rea/issues/9558), [issue morluto/rea#9766](https://github.com/morluto/rea/issues/9766). Thanks @2SinceJuly, @ShuaixinHuang, @xu91102.
- Report the actual link-time kernel banner, list ELF initializers in images with COPY relocations, and leave cross-code-page shortcut-icon comparisons unknown. [#9690](https://github.com/morluto/rea/pull/9690), [#10084](https://github.com/morluto/rea/pull/10084), [#9691](https://github.com/morluto/rea/pull/9691), [issue morluto/rea#9688](https://github.com/morluto/rea/issues/9688), [issue morluto/rea#9689](https://github.com/morluto/rea/issues/9689). Thanks @Plastic-time, @thunderq10.
- Retain actionable debugger/provider failures: reconnect stale JEB MCP sessions, preserve GDB inferior-TTY checks, and report invalid IDA regex syntax. [#3754](https://github.com/morluto/rea/pull/3754), [#5539](https://github.com/morluto/rea/pull/5539), [#9544](https://github.com/morluto/rea/pull/9544), [issue morluto/rea#5099](https://github.com/morluto/rea/issues/5099). Thanks @akushonkamen, @coygeek, @flitzrrr, @Plastic-time.
- Keep missing native call-input bindings and exhausted MCP discovery pages distinct from absence. [#10088](https://github.com/morluto/rea/pull/10088), [#10017](https://github.com/morluto/rea/pull/10017), [issue morluto/rea#8358](https://github.com/morluto/rea/issues/8358), [issue morluto/rea#9995](https://github.com/morluto/rea/issues/9995). Thanks @coygeek, @gensokyo-dev, @N0zoM1z0.
- Preserve admitted EVM and pwntools replies and completed SQLite member facts through acquisition/finalization failures. [d77cf61](https://github.com/morluto/rea/commit/d77cf6186631743025a1bafb8c5a27262da6128e), [e813c4c](https://github.com/morluto/rea/commit/e813c4c344d2414d1b8dfe42a421792d91b01dcc), [669e617](https://github.com/morluto/rea/commit/669e617eec5422ebce1ab271af0fc7b51e90dc11).
- Attribute keyed-archive errors to the archive argument, distinguish launcher failures from registry errors, and validate capture limiters before starting work. [#7731](https://github.com/morluto/rea/pull/7731), [#7843](https://github.com/morluto/rea/pull/7843), [#7947](https://github.com/morluto/rea/pull/7947), [issue morluto/rea#7292](https://github.com/morluto/rea/issues/7292), [issue morluto/rea#7597](https://github.com/morluto/rea/issues/7597), [issue morluto/rea#7630](https://github.com/morluto/rea/issues/7630), [issue morluto/rea#7638](https://github.com/morluto/rea/issues/7638). Thanks @coygeek, @gensokyo-dev.
- Preserve unknown CDP coordinates and prior-hop response facts, deduplicate scenario guidance and recognize AppKit cell ownership. [#7842](https://github.com/morluto/rea/pull/7842), [#7807](https://github.com/morluto/rea/pull/7807), [#7933](https://github.com/morluto/rea/pull/7933), [#7916](https://github.com/morluto/rea/pull/7916), [issue morluto/rea#7342](https://github.com/morluto/rea/issues/7342), [issue morluto/rea#7426](https://github.com/morluto/rea/issues/7426), [issue morluto/rea#7434](https://github.com/morluto/rea/issues/7434), [issue morluto/rea#7681](https://github.com/morluto/rea/issues/7681). Thanks @coygeek, @gensokyo-dev.
- Read legacy Erlang atom tables correctly, exclude Harmony symlinks from unavailable files, and preserve uncertain JavaScript with-scope member writes. [#7844](https://github.com/morluto/rea/pull/7844), [#7886](https://github.com/morluto/rea/pull/7886), [#7914](https://github.com/morluto/rea/pull/7914), [issue morluto/rea#7418](https://github.com/morluto/rea/issues/7418), [issue morluto/rea#7545](https://github.com/morluto/rea/issues/7545), [issue morluto/rea#7602](https://github.com/morluto/rea/issues/7602). Thanks @coygeek.
- Preserve known artifact metadata without hashes, report missing Ghidra project programs as configuration errors, and retain unbacked file-offset diagnostics. [#7932](https://github.com/morluto/rea/pull/7932), [#8222](https://github.com/morluto/rea/pull/8222), [#8308](https://github.com/morluto/rea/pull/8308), [issue morluto/rea#7341](https://github.com/morluto/rea/issues/7341), [issue morluto/rea#8216](https://github.com/morluto/rea/issues/8216), [issue morluto/rea#8244](https://github.com/morluto/rea/issues/8244). Thanks @coygeek, @kaoru0822-kitauji, @macjayz.
- Scope Hopper recovery to the caller lifetime and preserve Mach-O host-slice, Godot digest, browser-resource and selected-slice distinctions. [#9905](https://github.com/morluto/rea/pull/9905), [#10016](https://github.com/morluto/rea/pull/10016).
- Retain partial OpenAPI Evidence, reject unrepresentable adb activity arguments, and preserve worker, Frida and owned-command failure/cancellation facts through cleanup. [#9908](https://github.com/morluto/rea/pull/9908), [#9918](https://github.com/morluto/rea/pull/9918), [#10055](https://github.com/morluto/rea/pull/10055), [#9963](https://github.com/morluto/rea/pull/9963), [#9964](https://github.com/morluto/rea/pull/9964).
- Decode escaped HAR, qlog and Playwright JSON strings without retaining the fragmented strings that inflated decoder heap usage. [#10139](https://github.com/morluto/rea/pull/10139), [issue morluto/rea#10132](https://github.com/morluto/rea/issues/10132). Thanks @fcumaoglu, @mecrimino.
- Preserve physical web-worker launch failures as the primary error when cancellation overlaps; retain cancellation separately from the exact launcher observation. [#10145](https://github.com/morluto/rea/pull/10145).
- Classify adb wireless-debugging mDNS serials as TCP while preserving USB precedence and unknown device kind. [#10134](https://github.com/morluto/rea/pull/10134). Thanks @rudycelekli.
- Normalize lipo’s i386 CPU spelling before Mach-O slice selection and recognize the `__chk_fail` FORTIFY handler import. [#10136](https://github.com/morluto/rea/pull/10136), [#10036](https://github.com/morluto/rea/pull/10036), [issue morluto/rea#10025](https://github.com/morluto/rea/issues/10025). Thanks @2SinceJuly, @coygeek, @rudycelekli.
- Retain process CLI cleanup owners until delivery, preserve known local retry leases alongside unknown prior cleanup, and align lifecycle boundaries with tagged cancellation facts. [#10147](https://github.com/morluto/rea/pull/10147). Thanks @wunianze666-netizen.
- Count only syntactically valid CSP nonce/hash sources when reporting browser policy. [#10135](https://github.com/morluto/rea/pull/10135). Thanks @rudycelekli.
- Reject ELF tables inside the declared header and unmatched NT_FILE mapping pathnames; keep PE imports within their declared directory bounds. [#10133](https://github.com/morluto/rea/pull/10133), [#10138](https://github.com/morluto/rea/pull/10138), [#10044](https://github.com/morluto/rea/pull/10044). Thanks @rudycelekli, @ShuaixinHuang, @wunianze666-netizen.
- Classify private nested Swift types by their own kind rather than their enclosing declaration. [#10085](https://github.com/morluto/rea/pull/10085), [issue morluto/rea#7501](https://github.com/morluto/rea/issues/7501). Thanks @BeqaKs, @Rinkia.

### ⚠ BREAKING CHANGES

- Settings clients must replace `effect`, `rea_restart_required`, `restart_required` and `restartRequired` with `update_mode` (`runtime`, `restart`, `parameter`) and `pending_restart`. Parameter-supplied limits cannot be changed by the runtime setter; restart-mode values retain their startup value until restart. [#9885](https://github.com/morluto/rea/pull/9885), [be20bdfb26f7](https://github.com/morluto/rea/commit/be20bdfb26f75a573a9cad49d091f5a27f8fc745), [aee1178839dd](https://github.com/morluto/rea/commit/aee1178839dddcc54de42cce6d5d91b7a913034b). Thanks @gensokyo-dev, @N0zoM1z0.
- Process and desktop callers must inspect `details.secondary_failures`/`secondaryFailures`: mixed batches keep physical/provider failures primary and retain typed cancellation with its original cause. Retained descriptors can produce `cleanup_incomplete`; follow the returned recovery instead of treating it as ordinary cancellation. Custom adapters must consume owner-issued inspection/sampling facts and retain their cleanup scopes until release succeeds. [#10141](https://github.com/morluto/rea/pull/10141), [#10113](https://github.com/morluto/rea/pull/10113), [#10109](https://github.com/morluto/rea/pull/10109).
- `rea mcp add --command` now accepts a local stdio launcher only: HTTP(S) executable URLs are rejected before settings writes, and package acquisition is removed. Configure remote transports in each client’s native settings and install/select the local launcher before registration. [#10102](https://github.com/morluto/rea/pull/10102).
- Runtime-instance graph identities now require `identity.capture_evidence_id` in addition to the capture digest and runtime key. Node IDs digest that identity, so regenerate reconciliation Evidence and rebuild node-keyed lookups even when the digest and runtime key are unchanged. [#10063](https://github.com/morluto/rea/pull/10063).
- Retained process symlinks require their stored target bytes; recapture legacy observations that only described a link without retaining its target. [#10082](https://github.com/morluto/rea/pull/10082).
- Function dossiers must record Swift literal inventory and its omissions together. Regenerate one-sided observations through a canonical provider; both-absent unsupported observations remain valid. [#10068](https://github.com/morluto/rea/pull/10068).
- Conformance manifest schema v2 separates exact string markers from fragments and rejects the old ambiguous `strings` field. Regenerate unversioned fixtures with `npm run build:fixtures`. [#9977](https://github.com/morluto/rea/pull/9977).
- Unavailable native/BEAM/Go/Rust view collections return `items.rows: null`, `coverage.status: "unavailable"`, `coverage.total: null` and `coverage.exhausted: false`; recorded empty collections still return `rows: []`. Refresh schemas, stop paging unavailable data and inspect `unknowns`; older saved views retain their recorded facts. [#9893](https://github.com/morluto/rea/pull/9893), [#8291](https://github.com/morluto/rea/pull/8291), [issue morluto/rea#8276](https://github.com/morluto/rea/issues/8276). Thanks @Xinglan233.
- Desktop witnessing requires the current generated verifier: re-export old bundles using their original Evidence/task inputs. Pre-6.9 captures missing required `state.baseline_non_files` are rejected before state inspection, drafting or export; capture the application again to obtain contemporaneous SQLite member facts. [#9898](https://github.com/morluto/rea/pull/9898), [#9470](https://github.com/morluto/rea/pull/9470).
- New browser captures record `save: []` for request actions that save nothing, changing scenario/Evidence digests. Keep historical digests with historical captures and use freshly recorded digests for new ones. [#9896](https://github.com/morluto/rea/pull/9896).
- Selected SQLite rows require `row_offset` and `next_row_offset`; `rows.order` is `rowid`, `primary_key` or `unspecified`. A null next offset means either no continuation or no stated order: an unordered sample can still have `truncated: true`. Inspect both `order` and `truncated` before concluding the sample is complete. [#9331](https://github.com/morluto/rea/pull/9331), [issue morluto/rea#8234](https://github.com/morluto/rea/issues/8234). Thanks @2SinceJuly, @555aaditya.
- Windows entropy Evidence now uses the admitted filesystem path spelling, so fresh analysis of a differently cased caller path can change `evidence_id`. Invalidate or re-key cached associations against the fresh Evidence, retaining old IDs only for their original observations. [#9393](https://github.com/morluto/rea/pull/9393). Thanks @HusnainMaroof.
- `caller_input_paths` values may be ordered arrays of strings as well as strings. Update strict consumers to preserve repeated selections. [#9626](https://github.com/morluto/rea/pull/9626), [#9624](https://github.com/morluto/rea/pull/9624).
- `observe_javascript_runtime` adds required `execution_context_id` fields to scripts and contexts. `context_key` is an opaque capture-local lifetime identity, not a reusable protocol ID, and Evidence identities change. Refresh schemas and recapture when new lifetime associations are needed. [#9471](https://github.com/morluto/rea/pull/9471), [issue morluto/rea#3382](https://github.com/morluto/rea/issues/3382). Thanks @coygeek.
- Refresh cached `inspect_address_context` schemas: unavailable facets may carry typed input or resource-constraint errors while successful sibling facets remain available. [#8444](https://github.com/morluto/rea/pull/8444), [#8424](https://github.com/morluto/rea/pull/8424), [#8419](https://github.com/morluto/rea/pull/8419).
- `analyze_function`/`trace_native_values` require `native_value_flow.limitations` on available and unavailable variants. Ghidra memory effects cover explicit high-p-code `LOAD`/`STORE` operations only; empty effects do not prove no memory access. The `value_flow_effect_scope` profile commitment invalidates older snapshots: retain embedded historical Evidence, reopen without the snapshot and save a fresh one. [#8651](https://github.com/morluto/rea/pull/8651).
- Ghidra byte searches require `skipped_overlays`; loaded overlays no longer count as not loaded, and adjacent initialized blocks are searched with explicit coverage. Reopen targets and save fresh analysis snapshots after the profile/search-policy changes; historical Evidence stays importable. [#8608](https://github.com/morluto/rea/pull/8608), [#8376](https://github.com/morluto/rea/pull/8376), [#8840](https://github.com/morluto/rea/pull/8840), [issue morluto/rea#8374](https://github.com/morluto/rea/issues/8374), [issue morluto/rea#8563](https://github.com/morluto/rea/issues/8563), [issue morluto/rea#8607](https://github.com/morluto/rea/issues/8607).
- `compare_functions` adds `function_match.method: "same-evidence"` when both inputs authenticate to one Evidence ID and entry comparison is unavailable. Accept the new matched variant, retain unknown dimensions and do not infer complete equivalence; one observation cannot have contradictory changed dimensions or hashes. [#8442](https://github.com/morluto/rea/pull/8442), [issue morluto/rea#8367](https://github.com/morluto/rea/issues/8367).
- Kuna `analyze_function` can return `native_value_flow: {available: false, reason, limitations}` instead of null. Check `available` and preserve the provider reason; null means procedure-scoped unrecorded unknown, not confirmed absence. The workflow-profile digest changes: older trace Evidence remains history but must be rerun to satisfy current replay. [#8785](https://github.com/morluto/rea/pull/8785), [issue morluto/rea#8783](https://github.com/morluto/rea/issues/8783).
- The opt-in hot/cold MCP catalog no longer preloads `inspect_analysis_view`. Discover it before use or batch it with its producer; the default full catalog remains available. [#9151](https://github.com/morluto/rea/pull/9151). Thanks @gensokyo-dev.
- `batch_decompile` and retained batch views now use `items[].status: "unavailable"` with `reason: "no_pseudocode"` for null pseudocode, replacing the former `error`/`capability_unavailable` item. Empty or non-text values remain `status: "error"` with `unreadable_output`. Both count toward `failed`; preserve item limitations and accept historical error items. [#8737](https://github.com/morluto/rea/pull/8737), [issue morluto/rea#8736](https://github.com/morluto/rea/issues/8736).
- `import_evidence_bundle`/CLI `evidence-import` now reject snapshot-shaped JSON with `invalid_request` instead of `evidence_integrity_mismatch`. Restore it with `open_binary.snapshot_path` or a compatible CLI `--snapshot`; bundle imports require a canonical bundle from `export_evidence_bundle`. [#8867](https://github.com/morluto/rea/pull/8867).
- REA-launched Chromium keeps its sandbox. If launch fails on root/container hosts, first enable host sandbox support, such as a suitable non-root user or namespace/setuid facilities. The explicit `REA_BROWSER_NO_SANDBOX=true` fallback disables Chromium’s sandbox and does not establish an REA isolation boundary. [#8738](https://github.com/morluto/rea/pull/8738), [issue morluto/rea#8722](https://github.com/morluto/rea/issues/8722). Thanks @chordpli, @hkeysai.
- Fresh objdump Evidence changes provider identity from `gnu.objdump`/`GNU objdump` to `{id: "objdump.command", name: "objdump command", version: null}`; launch errors use the same ID and architecture-list subjects may be null. Update provider-keyed caches/readers and retain the selected executable parameters without assuming GNU semantics; historical Evidence stays readable. [#8824](https://github.com/morluto/rea/pull/8824), [issue morluto/rea#8823](https://github.com/morluto/rea/issues/8823).
- Kuna verification policy is separate from analysis identity. Earlier snapshots and resumable directory exports are incompatible even with the same executable. Preserve old files, reopen without the snapshot and save a fresh one or choose a new export directory; the [Kuna guide](https://github.com/morluto/rea/blob/main/docs/kuna-provider.md) explains extracting/importing embedded Evidence as history. [#8699](https://github.com/morluto/rea/pull/8699).
- `inspect_analysis_view` rejects mismatched native parent predicates with `invalid_request` at `source.predicate_type`: function/inventory/observation views require `rea.analysis`, and matching views require `rea.native-function-matching`. Select the original correctly typed Evidence or rerun its producer; patching an existing predicate invalidates its identity. [#8451](https://github.com/morluto/rea/pull/8451).
- `trace_feature` can succeed when xrefs exist but owner lookup is unavailable. Accept `references[].containing_procedure.status: "unavailable"` with provider/reason fields instead of requiring a `found` member, and inspect `residual_unknowns`; `truncated: false` does not establish resolved ownership. [#8368](https://github.com/morluto/rea/pull/8368).
- `close_binary` retains investigation records; use `reset_investigation` to clear them. Cross-process recovery requires an explicitly acknowledged Evidence-bundle checkpoint. [#8361](https://github.com/morluto/rea/pull/8361), [issue morluto/rea#8347](https://github.com/morluto/rea/issues/8347). Thanks @gensokyo-dev.
- `compare_functions` adds the matched `function_match.method: "same-entry"` variant with required `entry_address` when authenticated artifact, architecture, mapping, slice and entry commitments agree despite a rename. Refresh schemas and keep name/identity changes separate from entry correspondence. [#8263](https://github.com/morluto/rea/pull/8263), [issue morluto/rea#8213](https://github.com/morluto/rea/issues/8213). Thanks @gensokyo-dev.
- `inspect_native_load_image` NativeAOT `metadata_recovery` uses a status-discriminated union: complete reports require `reason: null`; partial/not-applicable reports carry `{code, ...}` instead of prose reasons. Branch on codes and their fields while preserving historical/optional-extension strings. Invalid budgets now produce typed input/resource errors. [#8053](https://github.com/morluto/rea/pull/8053).
- `trace_javascript_semantics` adds `influences` edges and moves direct literal-argument seeds from call-site to expression nodes. Relevant unknown dependencies can change `found` to `partial`: handle that status and inspect unknowns. Reanalyze retained application graphs to obtain the new edges; old graphs stay readable. [#7939](https://github.com/morluto/rea/pull/7939), [issue morluto/rea#7500](https://github.com/morluto/rea/issues/7500). Thanks @Rinkia.
- `inspect_managed_members` changes `signature_resolution` from `type-names-v1` to `type-names-v2` and appends readable names to signature operands, such as `class:4 (Fixture.Program)`. Branch on the resolution version, accept annotated v2 strings and preserve historical v1/null displays. Signature digests are unchanged; `InternalCall` methods remain runtime-provided boundaries. [#5309](https://github.com/morluto/rea/pull/5309), [#9547](https://github.com/morluto/rea/pull/9547), [issue morluto/rea#5149](https://github.com/morluto/rea/issues/5149). Thanks @elricfd, @gensokyo-dev, @ln-bodicherla, @Plastic-time.
- MCP calls default to 1,024 combined array elements/object members; excess input is rejected before dispatch with nonretryable `resource_constraint`, `resource: "transport"` and `reported_limits.max_input_elements`. For larger inline calls, set `REA_MCP_MAX_INPUT_ELEMENTS` to a digit-only positive decimal safe integer (1–9007199254740991) and restart, or select retained/file inputs. Fractional/exponent spellings are invalid; inputs are never truncated. [#7905](https://github.com/morluto/rea/pull/7905), [issue morluto/rea#7882](https://github.com/morluto/rea/issues/7882). Thanks @gensokyo-dev.
- `inspect_macho` text names/paths can be null for non-UTF-8 bytes, with `name_bytes_hex`, `segment_bytes_hex` and `path_bytes_hex` alternatives; unsafe numeric sizes/offsets/alignments can be null with exact companion fields, and delayed-init `options` are numeric. Refresh schemas and preserve these facts; absent byte fields in older Evidence remain unrecorded. [#7952](https://github.com/morluto/rea/pull/7952), [issue morluto/rea#7391](https://github.com/morluto/rea/issues/7391). Thanks @coygeek.
- Environment file-source errors move from the generic `evidence` issue path to `capture` for `environment-build` and `source.path` for environment bundle build/export. Missing/non-file/invalid UTF-8/JSON sources return `invalid_request` with `invalid_value`/`invalid_format` issues and `inspect_input_contract` recovery; repair the selected file. [#7900](https://github.com/morluto/rea/pull/7900), [issue morluto/rea#7523](https://github.com/morluto/rea/issues/7523). Thanks @coygeek.
- Selected unpaired UTF-16 surrogates now make TOON, Markdown, CSV and TSV output fail with `invalid_request` and a nonzero exit even after a successful operation; Markdown also refuses NUL. Use `--format json` or `--format yaml` to preserve these values rather than accepting substituted text. [#7852](https://github.com/morluto/rea/pull/7852), [issue morluto/rea#7592](https://github.com/morluto/rea/issues/7592), [issue morluto/rea#7593](https://github.com/morluto/rea/issues/7593). Thanks @coygeek.
- Reconstruction `evidence_bundle` inputs reject authenticated standalone records as `invalid_request` with field-level issues instead of accepting/misclassifying them as damaged bundles. Bundle-file import/export/comparison reports `invalid_request`/`invalid_input` with `details.reason: "wrong-kind"`. Supply a canonical bundle from `export_evidence_bundle`; tampered data remains an integrity failure. [#7895](https://github.com/morluto/rea/pull/7895), [issue morluto/rea#7562](https://github.com/morluto/rea/issues/7562). Thanks @coygeek.
- Environment coverage can use `method-replay` for non-GET safe reads. Clock-generating write plans without a global clock anchor now return `served: false`, `reason: "unknown-clock"` instead of being served. Extend reason handling and recapture usable start times/completed durations before replaying those writes. [#7834](https://github.com/morluto/rea/pull/7834), [63220edcc3b4](https://github.com/morluto/rea/commit/63220edcc3b47d44e72a7d77518172d81961e67a), [issue morluto/rea#7387](https://github.com/morluto/rea/issues/7387). Thanks @coygeek.
- Ghidra returns `not-in-listing` for in-memory addresses lacking listed instructions or defined data, replacing the former `undecodable` interpretation. Accept the new status and recreate snapshots after the raw-profile change; retain old embedded Evidence as history. [#7823](https://github.com/morluto/rea/pull/7823), [issue morluto/rea#7490](https://github.com/morluto/rea/issues/7490). Thanks @Entrpi.
- `capture_process_scenario`/CLI process capture rejects `columns: 1` before target launch; update both initial terminal widths and every resize to at least 2. Sensitive interaction `data` is empty with `sensitive`/`input_bytes`, and raw echoes are redacted. Recapture both sides before comparing older private-input Evidence. [#7848](https://github.com/morluto/rea/pull/7848), [#7804](https://github.com/morluto/rea/pull/7804), [issue morluto/rea#7582](https://github.com/morluto/rea/issues/7582), [issue morluto/rea#7782](https://github.com/morluto/rea/issues/7782). Thanks @coygeek, @gensokyo-dev.
- Managed setup registrations bind the selected absolute runtime and REA entry script, including package-runner cache paths. Keep that installation available; unknown registrations need confirmed manual repair. Setup no longer returns `prewarm` or emits its progress events. [c77735fa83a6](https://github.com/morluto/rea/commit/c77735fa83a66552ec45eef435ab3bb36026ecfe). Thanks @gensokyo-dev.
- macOS Hopper launch paths/arguments reject double quotes, backslashes and line breaks before handoff. Select literal-safe prepared paths/loader arguments or a compatible provider. [#7732](https://github.com/morluto/rea/pull/7732), [issue morluto/rea#7727](https://github.com/morluto/rea/issues/7727). Thanks @gensokyo-dev.
- New JavaScript application graphs omit the derived package `renderer` property. Use `renderer_declarations` for source fields and package-load edges for the selected candidate; historical Evidence remains readable. [5cf7133f823b](https://github.com/morluto/rea/commit/5cf7133f823bce2a3e42a6e1d0c8418e5ff9908d).
- Replace Cutter `--json=true/false` with `--json-output=true/false`; bare `--json` still selects CLI result formatting. Replace `rea compare-bundles` with `rea compare`; MCP `compare_bundles` is unchanged. [567ea4b1e8bb](https://github.com/morluto/rea/commit/567ea4b1e8bb7dda67563d06f1b4977c2d92995a), [3515b262218f](https://github.com/morluto/rea/commit/3515b262218f2d4ba94ce6a7bda9766747b3d84d).
- JEB engine refusals report `execution_failure` rather than `unsupported_target`; inspect retained upstream diagnostics for recovery. [c4cdb7658b0e](https://github.com/morluto/rea/commit/c4cdb7658b0eb5ef16b30bd8127479bce8c21233).
- ASAR file occurrences may contain `unpacked: false`. Accept an optional boolean; absent historical fields remain unknown. [60834e391c3f](https://github.com/morluto/rea/commit/60834e391c3f81eb2343eba288b735c3bf3bde61).
- Non-loopback MCP HTTP binds require `MCP_ALLOWED_HOSTS` or `rea mcp --http --allowed-hosts`. Bundle names must be unchanged HTTP hostnames within the 63-octet DNS-label limit. [#7172](https://github.com/morluto/rea/pull/7172). Thanks @DeryFerd, @gensokyo-dev.
- `binary_session {}` is compact by default and omits provider availability diagnostics/remediation, target-support diagnostics/capabilities and tool-group surface/effects/annotations. Request `{"detail":"complete"}` for these facts and recovery guidance. [#7127](https://github.com/morluto/rea/pull/7127), [issue morluto/rea#7109](https://github.com/morluto/rea/issues/7109). Thanks @kaoru0822-kitauji.
- Native input errors now include `details.operation` and field-level `details.issues`. Supply a nonempty `trace_native_values.procedure`; CLI `trace-native-values` rejects an empty procedure before opening the target as `VALIDATION_ERROR` with `fieldErrors`, while MCP reports `invalid_request` at `procedure`. [#7889](https://github.com/morluto/rea/pull/7889), [issue morluto/rea#7572](https://github.com/morluto/rea/issues/7572). Thanks @coygeek.
- Readable JavaScript members that normalize to one logical path now stop `analyze_javascript_application` with `artifact_operation_failed`, `details.reason: "path"` and a partial inventory instead of selecting one occurrence. Inspect the inventory and analyze a copy without collisions; all-unavailable colliding sources remain unknown. [#7864](https://github.com/morluto/rea/pull/7864), [issue morluto/rea#7626](https://github.com/morluto/rea/issues/7626). Thanks @coygeek.
- `trace_web_module_imports` with an empty/relative `REA_BROWSER_EXECUTABLE` now reports `capability_unavailable` with `invalid_browser_executable` instead of `missing_browser_executable`, retaining `details.diagnostics.executable`. Set an absolute Chromium path; an unset selection still means missing. [#7903](https://github.com/morluto/rea/pull/7903), [issue morluto/rea#7639](https://github.com/morluto/rea/issues/7639). Thanks @coygeek.
- Unresolvable `import-reference-source` roots, capture scenario files and web-network capture/Protobuf descriptor paths (`ELOOP`/`ENAMETOOLONG`) now report `invalid_request`/`invalid_input` with responsible field/host-code issues rather than generic execution/unreadable-output failures. Repair the symlink chain or choose a shorter path. [#7847](https://github.com/morluto/rea/pull/7847), [#7814](https://github.com/morluto/rea/pull/7814), [issue morluto/rea#7607](https://github.com/morluto/rea/issues/7607), [issue morluto/rea#7636](https://github.com/morluto/rea/issues/7636). Thanks @Abelo9996, @coygeek.
- `close_binary` with `snapshot_path` on a profileless/archive target now returns nonretryable `capability_unavailable` instead of `evidence_integrity_mismatch`, writes no snapshot and leaves the session open. Export needed Evidence, then close again without `snapshot_path`. [#7837](https://github.com/morluto/rea/pull/7837), [issue morluto/rea#7311](https://github.com/morluto/rea/issues/7311). Thanks @coygeek.
- adb local-file refusals occur before device commands: missing/non-file/uninspectable `local_path`/`apk_path` and file-blocked `output_directory` return `invalid_request` with field issues/host codes; output-producing calls formerly used `unreadable_output`. Supply regular source files and a directory path whose parents are directories. [#7885](https://github.com/morluto/rea/pull/7885), [issue morluto/rea#7549](https://github.com/morluto/rea/issues/7549), [issue morluto/rea#7550](https://github.com/morluto/rea/issues/7550). Thanks @coygeek.
- Evidence writes failing with `EFBIG`, `ENOSPC` or `EDQUOT` now report nonretryable `resource_constraint`, `details.reason: "storage-limit"`, path and optional `system_code` instead of `execution_failure`/`io`. Raise file-size allowance or free space/quota before retrying; a failed staged-file cleanup remains `cleanup_incomplete`. [#7887](https://github.com/morluto/rea/pull/7887), [issue morluto/rea#7573](https://github.com/morluto/rea/issues/7573). Thanks @coygeek.
- PE signers add optional nullable `unsigned_attribute_oids`: fresh null means absent, an OID array means present, and omission in old Evidence is unrecorded. Unsigned attributes produce `coverage.status: "partial"` because nested signatures/timestamp contents remain undecoded; accept the new field and limitations. [#7920](https://github.com/morluto/rea/pull/7920), [issue morluto/rea#7767](https://github.com/morluto/rea/issues/7767). Thanks @Rinkia.
- Valid ASN.1 exceeding certificate nesting/OID allowances now returns nonretryable `resource_constraint` rather than `invalid_request`/`invalid_input`, with `max_asn1_depth`/`max_oid_bytes`. These format/resource bounds have no runtime override; retain the diagnostics and use an independently suitable parser when necessary. [#9932](https://github.com/morluto/rea/pull/9932).
- `trace_call_path`/`build_call_path` require discovery and observed-result fields in `search_scope`. An exhausted observed graph can still yield `goal_status: "unknown"` when provider discovery is incomplete. Refresh result schemas and workflow-profile expectations instead of equating graph exhaustion with complete discovery. [#8443](https://github.com/morluto/rea/pull/8443).
- `inspect_native_instruction` adds `containing_instruction` for `not-instruction-boundary` and `containing_data` for `data`, with address/extent/identity/provenance. Accept these facts; omission in old Evidence is unrecorded. The Ghidra profile changes: reopen and save a fresh snapshot. [#8777](https://github.com/morluto/rea/pull/8777).
- `trace_native_values` adds required `page_truncated` and tagged `traversal` coverage. `truncated` combines page omission with traversal truncation; exactly filling a budget alone no longer proves truncation. Inspect page coverage before fetching another page and traversal reason before raising budgets. [#8309](https://github.com/morluto/rea/pull/8309), [issue morluto/rea#8283](https://github.com/morluto/rea/issues/8283). Thanks @kaoru0822-kitauji.
- `batch_decompile.addresses` has a separate hard ceiling of 20,000 entries. Split larger batches into calls of at most that size; increasing the configurable MCP transport allowance cannot remove this operation limit. [#5937](https://github.com/morluto/rea/pull/5937), [issue morluto/rea#5930](https://github.com/morluto/rea/issues/5930). Thanks @dakjdakd.
- `close_binary` can retire the target while retaining cleanup owners: `cleanup_incomplete` may have `recovery.kind: "retry_cleanup"` despite `retryable: false`. Keep the same connection open and call `close_binary` again without `snapshot_path` to retry owned cleanup. [#8329](https://github.com/morluto/rea/pull/8329), [issue morluto/rea#8211](https://github.com/morluto/rea/issues/8211). Thanks @kaoru0822-kitauji.
- Unconfirmed cleanup in `inspect_address_context`, `get_call_graph` or `trace_call_path` now produces tool-level `cleanup_incomplete` rather than a successful partial result or cancellation. Keep admitted partial Evidence and follow the returned same-session cleanup recovery. [#8417](https://github.com/morluto/rea/pull/8417), [#8516](https://github.com/morluto/rea/pull/8516), [issue morluto/rea#8369](https://github.com/morluto/rea/issues/8369), [issue morluto/rea#8416](https://github.com/morluto/rea/issues/8416). Thanks @kaoru0822-kitauji.
- `inspect_ntfs_journal` omits detailed `mftMetadata.record_headers` by default and leaves continuation at the first omitted record. Select `mft_record_limit` from 1 to 32 when those details are needed; inventory counts and explicit coverage remain inline. [1a8a9b749a](https://github.com/morluto/rea/commit/1a8a9b749a86e4b065a6b3ee6b8bad3b2761bac6). Thanks @gensokyo-dev, @N0zoM1z0.
- Desktop state directories now use `application.state_directories[].exists_at_start: null` plus `existence_error` when inspection fails (for example, access denial). Accept the tri-state field and preserve unknown instead of treating it as absence. [#9899](https://github.com/morluto/rea/pull/9899).

Full contribution record: [1848 commits and 1073 merged PRs](https://github.com/morluto/rea/blob/rea-agents-6.9.0/docs/releases/6.9.0.contributions.json).

## [6.8.0](https://github.com/morluto/rea/compare/rea-agents-6.7.0...rea-agents-6.8.0) (2026-10-25)

### Highlights

- Build local agent environments from network captures, browser scenarios, or a prompt, then serve derived reads and evidence-gated writes and compare them with fresh application captures.
- Inspect more shipped formats, including GPU code objects, BEAM, Python bytecode, Unity IL2CPP metadata, Godot PCK, PyInstaller, Node.js SEA, devicetree, and additional PE/ELF tables.
- Keep large investigations focused with retained summaries, selected fact queries, configurable recovery limits, and row-oriented CLI exports. Complete Evidence remains available.

### ⚠ BREAKING CHANGES

- **Function analysis:** `analyze_function` now defaults to a retained summary. Set `detail: "complete"` for the previous inline dossier; the CLI retains its complete default and requires `--evidence_output` when selecting a summary. [#5660](https://github.com/morluto/rea/pull/5660). Thanks @CryptoJones, @gensokyo-dev, @RishTheFish21.
- **Accessibility:** Accept JSON numbers and booleans in node `value`, alongside strings and null. Update consumers that previously assumed text-only values. [cc90771](https://github.com/morluto/rea/commit/cc90771af14f045538651615147d8bf86b576549), [#6759](https://github.com/morluto/rea/pull/6759), [#6467](https://github.com/morluto/rea/issues/6467). Thanks @coygeek, @gensokyo-dev, @mvanhorn.
- **JSON Lines:** `--format jsonl` now emits object-collection rows followed by a `$rea: "jsonl/v1"`, `type: "metadata"` record; scalar selections and unsupported reports are refused. Parse control records separately, select a single supported collection when necessary, and use `--format json` for the previous whole-document output. See [JSON Lines framing](https://github.com/morluto/rea/blob/rea-agents-6.8.0/docs/cli.md#json-lines-record-output). [#5629](https://github.com/morluto/rea/pull/5629), [#5487](https://github.com/morluto/rea/issues/5487). Thanks @gensokyo-dev, @jayykernel, @vijaykiran06.
- **Interface Builder:** Keyed-archive graph identities use decimal table UIDs instead of authored `objectID`/`object-id`. Treat authored IDs as attributes and update persisted graph lookups; ibtool and native NIBArchive identities keep their source semantics. [6fbe67d](https://github.com/morluto/rea/commit/6fbe67d66e3d716db69929503a3a232a7ada0860).
- **Frida:** `instrument-with-frida` JSON returns the canonical Evidence directly. Read `normalized_result.cleanup_error` instead of the former top-level wrapper field. [48f700e](https://github.com/morluto/rea/commit/48f700ee35e0988ed973e5486dc9db33f2a5d944).
- **Reconstruction proof:** ID-array proof records no longer establish verified or ready ledgers. Supply implementation/revision bindings and individual claim outcomes; handle inapplicable, unavailable, and failed proof diagnostics. [f8b65e7](https://github.com/morluto/rea/commit/f8b65e78723b1e2169f94dd1226198ea3139707e).
- **Mach-O imports:** Handle a null import `name` when identity is ambiguous; use `raw_name` and `name_status` to distinguish observed expressions from exact symbols. [5d0d243](https://github.com/morluto/rea/commit/5d0d243a45c9132e1aff75d454ab53d86a74cc31), [169512a](https://github.com/morluto/rea/commit/169512a35bb015ff209168fb8bc1c9b31a2c678b).
- **Node.js:** Use a runtime satisfying `^22.23.4 || ^24.22.1 || >=26.12.1`; Node 23 and 25 are unsupported. Upgrade Node before installing or updating REA; the installer does not upgrade it. [#6315](https://github.com/morluto/rea/pull/6315), [#6283](https://github.com/morluto/rea/issues/6283). Thanks @GamerDubz, @gensokyo-dev, @ShikamaruNaaraa.
- **Browser storage:** Historical hashed storage remains readable, but comparisons stay unknown until both captures are recaptured in the new representation. [#6341](https://github.com/morluto/rea/pull/6341), [#6289](https://github.com/morluto/rea/issues/6289). Thanks @coygeek, @gongfpp.
- **Environment serving:** `environment-serve` serves derived state by default, including write tools whose effects are confirmed by recorded evidence. Use `--replay-only` for stateless replay of manifest tools. Read stop-summary `state` instead of `state_evidence_id`. [#5351](https://github.com/morluto/rea/pull/5351), [#6158](https://github.com/morluto/rea/pull/6158). Thanks @earakely-scale, @gensokyo-dev, @kaoru0822-kitauji.
- **MCP schemas:** Input advertisements default to compact. Set `REA_MCP_INPUT_SCHEMA_PROFILE=full` for complete advertised guidance and nested constraints. [#5975](https://github.com/morluto/rea/pull/5975). Thanks @gensokyo-dev.
- **Browser console arguments:** Accept null `argument_types` and `text_capture.status: "unavailable"` when the protocol argument inventory is omitted or malformed; preserve that uncertainty. [#6016](https://github.com/morluto/rea/pull/6016), [#5934](https://github.com/morluto/rea/issues/5934). Thanks @coygeek, @kaoru0822-kitauji.
- **Reconstruction summaries:** `summary.by_evidence_authority` is keyed by Evidence authority; read the former source-state counts from required `summary.by_source_state`. Regenerate ledgers whose closure digests depended on the old projection. [#5875](https://github.com/morluto/rea/pull/5875), [#5838](https://github.com/morluto/rea/issues/5838). Thanks @coygeek, @kaoru0822-kitauji.
- **Swift bindings:** Conformance `type_name` and `protocol_name` may be null; consume typed `type_binding`/`protocol_binding` evidence. Replace the former Objective-C-specific import-binding type/schema with `MachoImportBinding`. [d0067ba](https://github.com/morluto/rea/commit/d0067ba34a39ea47dd7e11bb2e6169bc0938cc3f).
- **WebSocket frames:** Accept null opcodes and preserve unknown frame facts; numeric opcodes are restricted to the four-bit protocol range. [0bc2b42](https://github.com/morluto/rea/commit/0bc2b42001f684beffcf47b70e507443b1a5d320).
- **Resource-only inspection:** Evidence subjects and executable digests may be null. Use `resource_root` and each resource's reported provenance instead of requiring an executable target. [6a6adf7](https://github.com/morluto/rea/commit/6a6adf703fa44100643947d20fbc670f86260b1b).
- **Browser timestamps:** Console and session-timeline timestamps may be null when the protocol supplies no finite/comparable time. Keep unknown time explicit in sorting and comparisons. [690fc51](https://github.com/morluto/rea/commit/690fc518540bae982038a74f47ef7781201785aa), [2a0410f](https://github.com/morluto/rea/commit/2a0410f1717b3126e8a95063d77dea66a597010a).
- **Reference sources:** Read failed root enumeration from `rootFailure` rather than a synthetic failed child at `"."`; preserve the top-level source-graph limitation. [6296fdf](https://github.com/morluto/rea/commit/6296fdf560f1ac4aa55985558edaa98300aacdbc).
- **Filesystem capture:** Accept `entry_unavailable` and `identity_changed` enumeration omission reasons in addition to the previous reason literals. [c85b44e](https://github.com/morluto/rea/commit/c85b44e1b14851c54e65327a4807f79ad5cd5a61). Thanks @rudrakshagarwal4200-ai.
- **APK locales:** Replace numeric legacy selectors such as `es-r419` with `es-419` or `b+es+419`. Two-letter regions remain supported. [29910d1](https://github.com/morluto/rea/commit/29910d16b98fe4b607a7aa15928789a73614b0b9). Thanks @mertkayacs.
- **XML plist scalars:** Recognize `$plist_type: "unknown"` and read `element`, `literal`, and `reason`; unresolved XML scalars use this wrapper instead of the former real/null unknown marker or malformed scalar prefixes. Supported extended UTC years preserve their timestamp. [3537e58](https://github.com/morluto/rea/commit/3537e58c1ab29309f06eabf50bc52adba9817a0c).

### Changes

- **Binary layouts:** Inspect ELF32 i386, little-endian ARM, and little- or big-endian MIPS `EXEC`/`DYN`/`REL` layouts on Linux x64 using a caller-supplied pwntools environment. [#7052](https://github.com/morluto/rea/pull/7052), [#6934](https://github.com/morluto/rea/issues/6934). Thanks @roblennon, @salmanalmutairi1.
- **Agent environments:** Project network captures and Evidence files into manifests, preserve template path pairs and positions, export AgentEnv bundles, and serve manifests as replay environments. [#4954](https://github.com/morluto/rea/pull/4954), [#5293](https://github.com/morluto/rea/pull/5293), [#5664](https://github.com/morluto/rea/pull/5664), [#4999](https://github.com/morluto/rea/pull/4999), [#4975](https://github.com/morluto/rea/pull/4975). Thanks @earakely-scale, @gensokyo-dev, @kaoru0822-kitauji.
- **Capture to environment:** Build environments from browser scenarios or a prompt, extract the initial observed state, and compare the environment with application probe captures. [#5182](https://github.com/morluto/rea/pull/5182), [#6946](https://github.com/morluto/rea/pull/6946), [#5319](https://github.com/morluto/rea/pull/5319), [#5699](https://github.com/morluto/rea/pull/5699). Thanks @earakely-scale, @gensokyo-dev, @kaoru0822-kitauji.
- **State-backed tools:** Render read filters, search, sorting and paging from state; apply confirmed write effects with broader state targets and recording-based write admission. [#5352](https://github.com/morluto/rea/pull/5352), [293832b](https://github.com/morluto/rea/commit/293832bafc9a054914ec514fe906dd4936c7a372), [#5800](https://github.com/morluto/rea/pull/5800), [#5787](https://github.com/morluto/rea/pull/5787), [#5600](https://github.com/morluto/rea/pull/5600), [5375ff0](https://github.com/morluto/rea/commit/5375ff0f9aadb4fd0d46333815aa0431e3df1010), [#6169](https://github.com/morluto/rea/pull/6169), [#6385](https://github.com/morluto/rea/pull/6385), [#6897](https://github.com/morluto/rea/pull/6897). Thanks @earakely-scale, @gensokyo-dev, @kaoru0822-kitauji.
- **State learning:** Model application-assigned values, preserve view-specific clock spellings, learn write clocks from scenario timing, derive fields, and learn creates across sorted arrays and referenced entities. [7ec9b6e](https://github.com/morluto/rea/commit/7ec9b6e56e1b3762285dca881db6d900a389ab9c), [#6136](https://github.com/morluto/rea/pull/6136), [957bcfa](https://github.com/morluto/rea/commit/957bcfa149c1a0593bb0aa2466cc56d1d4f62e7d), [#6138](https://github.com/morluto/rea/pull/6138), [#6967](https://github.com/morluto/rea/pull/6967), [#7025](https://github.com/morluto/rea/pull/7025), [#7034](https://github.com/morluto/rea/pull/7034). Thanks @earakely-scale.
- **Recorded writes:** Serve creates whose compatible read-backs add omitted fields or express timestamps at a different precision, and whole-object updates that regenerate observed slugs or modification times. Conflicting observations still withhold writes. State views and bundles carrying the new read-back data need REA 6.8.0 or later to serve. [#7080](https://github.com/morluto/rea/pull/7080). Thanks @earakely-scale.
- **Native investigations:** Page native inventory summaries, match functions across builds, export pseudocode to resumable directories, and select objdump disassembly by symbol. [#5378](https://github.com/morluto/rea/pull/5378), [#5390](https://github.com/morluto/rea/pull/5390), [#6170](https://github.com/morluto/rea/pull/6170), [#5171](https://github.com/morluto/rea/pull/5171), [#4249](https://github.com/morluto/rea/issues/4249), [#5343](https://github.com/morluto/rea/issues/5343), [#5159](https://github.com/morluto/rea/issues/5159). Thanks @coygeek, @CryptoJones, @gensokyo-dev, @kaoru0822-kitauji.
- **Engine workflows:** Bound a single Ghidra decompilation without closing its session, analyze GameCube/Wii DOL executables, and inspect static CUDA/HIP code objects. [#5662](https://github.com/morluto/rea/pull/5662), [#6240](https://github.com/morluto/rea/pull/6240), [#5813](https://github.com/morluto/rea/pull/5813), [#5340](https://github.com/morluto/rea/issues/5340), [#5345](https://github.com/morluto/rea/issues/5345). Thanks @arielfikru, @coygeek, @gensokyo-dev, @RishTheFish21.
- **PE/ELF:** Inspect export tables without an engine, PE imports/delay-loads, Authenticode certificates, TLS callbacks/load configuration, ELF notes, Linux kernel module metadata, and Zstandard section-name tables. [#6278](https://github.com/morluto/rea/pull/6278), [#6509](https://github.com/morluto/rea/pull/6509), [#4830](https://github.com/morluto/rea/pull/4830), [#7008](https://github.com/morluto/rea/pull/7008), [#4837](https://github.com/morluto/rea/pull/4837), [#7010](https://github.com/morluto/rea/pull/7010), [#6987](https://github.com/morluto/rea/pull/6987), [#4057](https://github.com/morluto/rea/issues/4057). Thanks @gensokyo-dev, @kaoru0822-kitauji, @mvanhorn, @Rinkia, @ShuaixinHuang.
- **Apple/native metadata:** Inspect IPS crash reports, decode Swift nominal declarations, and select universal Mach-O slices in Go/Rust metadata readers. [#6511](https://github.com/morluto/rea/pull/6511), [#6257](https://github.com/morluto/rea/pull/6257), [#6219](https://github.com/morluto/rea/pull/6219), [#5341](https://github.com/morluto/rea/issues/5341), [#4102](https://github.com/morluto/rea/issues/4102). Thanks @coygeek, @gensokyo-dev, @kaoru0822-kitauji, @mvanhorn, @Rinkia.
- **Packaged applications:** Triage desktop installation directories and inspect/extract Godot PCK, PyInstaller archives, and Node.js single-executable application blobs. [#5207](https://github.com/morluto/rea/pull/5207), [#3634](https://github.com/morluto/rea/pull/3634), [afa5da7](https://github.com/morluto/rea/commit/afa5da745e0b139e68029a96b776ae30e48ea2b2), [#2433](https://github.com/morluto/rea/pull/2433), [#7000](https://github.com/morluto/rea/pull/7000), [#4399](https://github.com/morluto/rea/issues/4399). Thanks @0xthearchitect, @coygeek, @gensokyo-dev, @mvanhorn.
- **Unity and managed code:** Inventory IL2CPP images/types/methods and metadata versions 24/27; read member names and literals, link native methods and generic instances, and export Ghidra seeds. Project managed call/field-access edges and page managed member summaries. [#3807](https://github.com/morluto/rea/pull/3807), [#5326](https://github.com/morluto/rea/pull/5326), [52d1a72](https://github.com/morluto/rea/commit/52d1a72af047a73b787b8935b032786a34966036), [#5327](https://github.com/morluto/rea/pull/5327), [#5785](https://github.com/morluto/rea/pull/5785), [#6260](https://github.com/morluto/rea/pull/6260), [#5167](https://github.com/morluto/rea/pull/5167), [#3784](https://github.com/morluto/rea/issues/3784), [#5112](https://github.com/morluto/rea/issues/5112), [#4056](https://github.com/morluto/rea/issues/4056), [#5148](https://github.com/morluto/rea/issues/5148). Thanks @8rulerstar, @alexlanghart, @elricfd, @gensokyo-dev, @jaelliot, @kaoru0822-kitauji, @Rinkia.
- **Android:** Inspect APK signing declarations and structured manifest components; report static-final DEX field values. [e93e3b1](https://github.com/morluto/rea/commit/e93e3b1e7d6e7e4f49c2de24b92452ec29e853f8), [#4158](https://github.com/morluto/rea/pull/4158), [#5025](https://github.com/morluto/rea/pull/5025), [#6981](https://github.com/morluto/rea/pull/6981), [#4537](https://github.com/morluto/rea/issues/4537), [#6397](https://github.com/morluto/rea/issues/6397). Thanks @Abelo9996, @BaaRai, @FerroLx, @gensokyo-dev, @sserrgo12.
- **Bytecode and firmware:** Inspect and query CPython pyc and BEAM facts, inspect flattened devicetrees, and attribute MMIO peripheral regions in native disassembly. [#4826](https://github.com/morluto/rea/pull/4826), [#6928](https://github.com/morluto/rea/pull/6928), [#4833](https://github.com/morluto/rea/pull/4833), [#6943](https://github.com/morluto/rea/pull/6943), [#7009](https://github.com/morluto/rea/pull/7009), [#5348](https://github.com/morluto/rea/pull/5348), [#6922](https://github.com/morluto/rea/issues/6922), [#6938](https://github.com/morluto/rea/issues/6938). Thanks @gensokyo-dev, @liziye627-design, @mvanhorn.
- **JavaScript:** Retain queryable static route inventories, link assignment values to writes, and accept source selections as a JSON array or file. [#6019](https://github.com/morluto/rea/pull/6019), [#6206](https://github.com/morluto/rea/pull/6206), [#5029](https://github.com/morluto/rea/pull/5029), [#4772](https://github.com/morluto/rea/issues/4772), [#6193](https://github.com/morluto/rea/issues/6193). Thanks @gensokyo-dev, @IvenKooLab, @jacobmalibiran, @JoshOsullivan-au, @kaoru0822-kitauji, @KJLavender.
- **Data inspection:** Decode selected protobuf/gRPC bodies, inspect GGUF/safetensors declarations, and produce byte-entropy profiles. [#5031](https://github.com/morluto/rea/pull/5031), [#5603](https://github.com/morluto/rea/pull/5603), [#2331](https://github.com/morluto/rea/pull/2331), [#4986](https://github.com/morluto/rea/issues/4986), [#3323](https://github.com/morluto/rea/issues/3323). Thanks @AayushJB03, @gensokyo-dev, @kaoru0822-kitauji, @KJLavender, @michaelkillgta, @mvanhorn.
- **CLI input/output:** Accept structured request documents on stdin and expose version/runtime output formats. Row-oriented JSONL exports use the migration above. [#7040](https://github.com/morluto/rea/pull/7040), [#5486](https://github.com/morluto/rea/issues/5486), [#6530](https://github.com/morluto/rea/pull/6530), [169512a](https://github.com/morluto/rea/commit/169512a35bb015ff209168fb8bc1c9b31a2c678b), [#5483](https://github.com/morluto/rea/issues/5483). Thanks @Abelo9996, @ahmed-husssain, @CassieFox23, @DeryFerd, @eco-null, @ezrabrilliant, @GamerDubz, @gensokyo-dev, @gongfpp, @hifzabuildsai, @jayykernel, @mhamzasakhi, @pablodiazjorge, @Plastic-time, @raidnouredden-ux, @SandstromPL, @ShuaixinHuang, @Sriram-PR, @XiaoBinGan.
- **MCP and setup:** Add opt-in Streamable HTTP and FreeBuff setup registration. FreeBuff support first appears in 6.8.0; installed native FreeBuff loading and skill discovery remain unverified. [#4955](https://github.com/morluto/rea/pull/4955), [#2736](https://github.com/morluto/rea/pull/2736), [#3243](https://github.com/morluto/rea/issues/3243). Thanks @0xLLVEL, @codebuff-team, @earakely-scale, @gensokyo-dev, @kaoru0822-kitauji.
- **Recovery controls:** Adjust per-call WASM/SQLite/firmware deadlines, MCP startup budgets, regex matching deadlines/worker heap, capture decoder heap, ASAR header admission, Apple dispatch input, and the bridge request ceiling. MCP runtime limit recovery reports actionable settings. [#5798](https://github.com/morluto/rea/pull/5798), [#5818](https://github.com/morluto/rea/pull/5818), [aa53c06](https://github.com/morluto/rea/commit/aa53c065387c58b4189d82c47f1f3445fc505e30), [#5863](https://github.com/morluto/rea/pull/5863), [#6304](https://github.com/morluto/rea/pull/6304), [#6267](https://github.com/morluto/rea/pull/6267), [#6301](https://github.com/morluto/rea/pull/6301), [#6299](https://github.com/morluto/rea/pull/6299), [#6209](https://github.com/morluto/rea/pull/6209), [#6233](https://github.com/morluto/rea/pull/6233), [#6376](https://github.com/morluto/rea/pull/6376), [#7049](https://github.com/morluto/rea/pull/7049), [#5797](https://github.com/morluto/rea/issues/5797), [#5812](https://github.com/morluto/rea/issues/5812), [#5851](https://github.com/morluto/rea/issues/5851), [#6176](https://github.com/morluto/rea/issues/6176), [#3917](https://github.com/morluto/rea/issues/3917). Thanks @gensokyo-dev, @jaychou813, @kaoru0822-kitauji.
- **APK output:** Set `string_tables_only` or CLI `--string-tables-only` to omit duplicate primary strings and avoid their output-capacity charge. [7c458f0](https://github.com/morluto/rea/commit/7c458f04b9155707c8ba406f8b455b10016f1b99), [#4990](https://github.com/morluto/rea/pull/4990), [#4982](https://github.com/morluto/rea/issues/4982). Thanks @gensokyo-dev, @kaoru0822-kitauji, @N0zoM1z0.
- **Retained analysis:** Reuse successful validation of authenticated immutable native/imported-JavaScript parents and captures. Query retained Go build identity, Rust dependencies, JavaScript source-to-bundle mappings, and native export facts without repeating full output. [8f7d12e](https://github.com/morluto/rea/commit/8f7d12e30d63f3d3b4cfe2a90336362841438f56), [#4962](https://github.com/morluto/rea/pull/4962), [#5349](https://github.com/morluto/rea/pull/5349), [#5524](https://github.com/morluto/rea/pull/5524), [#5815](https://github.com/morluto/rea/pull/5815), [#6128](https://github.com/morluto/rea/pull/6128), [#6907](https://github.com/morluto/rea/pull/6907), [#4810](https://github.com/morluto/rea/issues/4810), [#5499](https://github.com/morluto/rea/issues/5499), [#5802](https://github.com/morluto/rea/issues/5802), [#6112](https://github.com/morluto/rea/issues/6112), [#6900](https://github.com/morluto/rea/issues/6900). Thanks @gensokyo-dev, @kaoru0822-kitauji, @N0zoM1z0.
- **Compact results:** Use retained Frida/GDB/objdump summaries, omit redundant Ghidra raw results, and defer the analysis runtime during MCP catalog discovery. [#5661](https://github.com/morluto/rea/pull/5661), [#5614](https://github.com/morluto/rea/pull/5614), [#5355](https://github.com/morluto/rea/pull/5355), [#4424](https://github.com/morluto/rea/pull/4424), [#5640](https://github.com/morluto/rea/issues/5640), [#5584](https://github.com/morluto/rea/issues/5584), [#5337](https://github.com/morluto/rea/issues/5337). Thanks @coygeek, @gensokyo-dev, @kaoru0822-kitauji, @leeguooooo.
- **Analysis work:** Reuse Hopper literal-string records, JavaScript workers and captured prefix selections, Interface Builder validation and plist scalar schemas; bound stable reads to one snapshot buffer and avoid decoding omitted GGUF strings. [#5017](https://github.com/morluto/rea/pull/5017), [#5819](https://github.com/morluto/rea/pull/5819), [31de177](https://github.com/morluto/rea/commit/31de177404461d122761d8243abe4fd24564f4da), [#5885](https://github.com/morluto/rea/pull/5885), [85e38ac](https://github.com/morluto/rea/commit/85e38ac199dff15e8c43343d9170db7e0e46d284), [#6966](https://github.com/morluto/rea/pull/6966), [#5781](https://github.com/morluto/rea/pull/5781), [#5010](https://github.com/morluto/rea/issues/5010), [#5855](https://github.com/morluto/rea/issues/5855), [#6954](https://github.com/morluto/rea/issues/6954), [#5774](https://github.com/morluto/rea/issues/5774). Thanks @gensokyo-dev, @kaoru0822-kitauji.
- **Native scheduling:** Batch modern IDA callee lookups, schedule decompilation reads on demand, index NativeAOT type closure, and retain call-path ancestry once per visited node. [0c6fed9](https://github.com/morluto/rea/commit/0c6fed90b74c75a9fd23d1ec1b510a7274f85887), [06fe7ee](https://github.com/morluto/rea/commit/06fe7eecbc8c387414b4c1aa0d88ad6314f54f0c), [ce61680](https://github.com/morluto/rea/commit/ce61680c04c95a9cdfad5335632a99542af26d37), [5e4ec0f](https://github.com/morluto/rea/commit/5e4ec0fa1b678aa3bf20704ec9110224ba8c1676).
- **Selected processing:** Prepare CLI positional schemas only for the selected command, separate entropy reads from report resolution, prune typed-array reference escapes, index state-write cutoffs, decode only selected replay query values, and skip payload text during WAT framing. [315b234](https://github.com/morluto/rea/commit/315b23403f0819967878cee418c3f9cb4b1a69d9), [#6950](https://github.com/morluto/rea/pull/6950), [#5139](https://github.com/morluto/rea/pull/5139), [#5350](https://github.com/morluto/rea/pull/5350), [96ea32b](https://github.com/morluto/rea/commit/96ea32b7e4e28d3c9cd79a1de4b8e1ba3b4244e9), [70835d3](https://github.com/morluto/rea/commit/70835d3d5f030deadf606e1c79c70a60883e50c9), [#5766](https://github.com/morluto/rea/pull/5766), [#6947](https://github.com/morluto/rea/issues/6947), [#5760](https://github.com/morluto/rea/issues/5760). Thanks @galleonli, @gensokyo-dev, @kaoru0822-kitauji.

### Fixes

- **IPS report fields:** Preserve the recorded terminating process and PID, termination flags, parent PID, and build/platform metadata. [#7079](https://github.com/morluto/rea/pull/7079), [#7078](https://github.com/morluto/rea/issues/7078). Thanks @rodricksz4h5.
- **Ghidra language selection:** Accept stock language IDs containing `LEBE` or slash-separated processor names, and report conflicting DOL language overrides as configuration errors naming `REA_GHIDRA_LANGUAGE_ID`. [#7070](https://github.com/morluto/rea/pull/7070), [#7072](https://github.com/morluto/rea/issues/7072), [#7081](https://github.com/morluto/rea/pull/7081), [#7082](https://github.com/morluto/rea/issues/7082). Thanks @Adolanium.
- **Setup and Hopper:** Preserve the Linux embedding runtime, supported x86_64 host restriction, readiness-based provider choices, orderly demo-helper shutdown, and installed apt dependency versions. Keep cleanup and skill publication ownership through retries. [#5041](https://github.com/morluto/rea/pull/5041), [#3422](https://github.com/morluto/rea/pull/3422), [f5d1012](https://github.com/morluto/rea/commit/f5d1012fabfe99af82523c3078ce9d93eb3780c1), [#4966](https://github.com/morluto/rea/pull/4966), [#6974](https://github.com/morluto/rea/pull/6974), [211e353](https://github.com/morluto/rea/commit/211e3533b34f81ae0910ad4f53f2a3d3c8587d3e), [#6920](https://github.com/morluto/rea/pull/6920), [#5015](https://github.com/morluto/rea/issues/5015), [#3419](https://github.com/morluto/rea/issues/3419), [#4921](https://github.com/morluto/rea/issues/4921), [#6975](https://github.com/morluto/rea/issues/6975). Thanks @Abel-I-Akhigbe, @Adolanium, @DavidFB-creator, @DeryFerd, @gensokyo-dev, @kaoru0822-kitauji, @sx4im.
- **Client setup:** Treat empty APPDATA as unset, distinguish MSIX Claude Desktop process views, preserve aliased Hermes server tables, reuse client dialect/alias bindings, and materialize the pinned package-runner cache before the first start. [#5126](https://github.com/morluto/rea/pull/5126), [#4903](https://github.com/morluto/rea/pull/4903), [#3785](https://github.com/morluto/rea/pull/3785), [b7eeded](https://github.com/morluto/rea/commit/b7eededf5af5061a834f93f57f2c888acf870344), [#7032](https://github.com/morluto/rea/pull/7032), [#5104](https://github.com/morluto/rea/issues/5104), [#4278](https://github.com/morluto/rea/issues/4278), [#3320](https://github.com/morluto/rea/issues/3320), [#7027](https://github.com/morluto/rea/issues/7027). Thanks @CmsChase, @coygeek, @myso-kr, @pablodiazjorge, @vaidehi-snk, @wxj006007.
- **Target admission:** Preserve thin arm64_32 Mach-O support, distinguish JVM identity before FAT admission, validate FAT format/CPU identity, preserve original DOS header padding, and reject NULs in local objdump/rizin paths. [#5788](https://github.com/morluto/rea/pull/5788), [6843dbe](https://github.com/morluto/rea/commit/6843dbea9bce4709ee2e8bf46c38f0bbf640716b), [497037e](https://github.com/morluto/rea/commit/497037e6e3975cbb37cfd89ea0ad300faa2a4769), [#7013](https://github.com/morluto/rea/pull/7013), [#3600](https://github.com/morluto/rea/pull/3600), [#5713](https://github.com/morluto/rea/issues/5713), [#6510](https://github.com/morluto/rea/issues/6510). Thanks @coygeek, @dhruvac29, @kaoru0822-kitauji, @Lew1sWong, @qorvr.
- **Mach-O and dylibs:** Preserve container framing, facts when dyld rejects a missing UUID, verified-signature snapshot identity, unsigned diagnostics, absolute paths inside the selected root, legacy platform rules, lazy-load payloads, and reasons for rejecting present dylibs. [cf3288d](https://github.com/morluto/rea/commit/cf3288d8cf7a09685acf89103b36c32359be56fa), [2b263a7](https://github.com/morluto/rea/commit/2b263a7fe9e9d4c185c7d6af6b4e67b21a73af30), [eb7acc7](https://github.com/morluto/rea/commit/eb7acc70bf06f119e8639e30a78081d5ba82b0bf), [1502cfb](https://github.com/morluto/rea/commit/1502cfbc8ca0d1d1d86eebf334018dfb418bbac0), [90062c0](https://github.com/morluto/rea/commit/90062c092228dea9d33fadc0d7e1b968105b8b2c), [#5650](https://github.com/morluto/rea/pull/5650), [3b67b36](https://github.com/morluto/rea/commit/3b67b362aa2cd79eac5af57d0965e81a7d0b8c2b), [#5551](https://github.com/morluto/rea/issues/5551). Thanks @coygeek.
- **Native facts:** Admit direct dispatch-metadata providers; preserve record-local Objective-C omissions, snapshot profiles, class-import binding identity, stripped class labels, version-like names, and qualified Swift protocol identities. [50b6975](https://github.com/morluto/rea/commit/50b6975d861069e2c6cfa202780621449f863802), [9eec57b](https://github.com/morluto/rea/commit/9eec57b469087fe9bff3d29dcc02f47074159e91), [0ba4d6f](https://github.com/morluto/rea/commit/0ba4d6f43ad610dacc861a1548be1a5c4712cd61), [4d7de00](https://github.com/morluto/rea/commit/4d7de00d4cc9a95ec2b7a3123b04e01db2daafa0), [22c84ce](https://github.com/morluto/rea/commit/22c84ce64aa6c7601aa81af86d4117b5a4c2feac), [4852c83](https://github.com/morluto/rea/commit/4852c830af1e3b9df437235b7a8fa8970a6d1c59), [aa9043f](https://github.com/morluto/rea/commit/aa9043f6b61c453e4735795cfe6a559bf6b6cc16).
- **Apple resources:** Preserve independent plist scalars, processing instructions, nonstandard table widths, unsupported NIB connector coverage, and strict IPS JSON surrogate validation; classify Interface Builder objects by their declared superclass chains. [fd728f2](https://github.com/morluto/rea/commit/fd728f271e7de7bcfa63890b573715720d5f948c), [#5806](https://github.com/morluto/rea/pull/5806), [4526862](https://github.com/morluto/rea/commit/4526862728af01f1135714079c0d8a8c754eb364), [14cd78c](https://github.com/morluto/rea/commit/14cd78c3224edcf79fca152915077112f547b9ed), [#6990](https://github.com/morluto/rea/pull/6990), [#5805](https://github.com/morluto/rea/issues/5805), [#5228](https://github.com/morluto/rea/pull/5228), [#5218](https://github.com/morluto/rea/issues/5218). Thanks @coygeek, @DeryFerd, @kaoru0822-kitauji, @Mangolycheematcha, @mhamzasakhi, @Shreyash021104.
- **Archives and files:** Complete positional ZIP reads, preserve bounded ASAR signatures, report stable symlink loops as resolution failures, retain target applicability, and report unknown traversal coverage. Retain reported integrity contradictions for members present in only one compared artifact. [#4414](https://github.com/morluto/rea/pull/4414), [e8da7e1](https://github.com/morluto/rea/commit/e8da7e1edd075feec0e6beedec93d5645fed8125), [#5571](https://github.com/morluto/rea/pull/5571), [#5763](https://github.com/morluto/rea/pull/5763), [#5867](https://github.com/morluto/rea/pull/5867), [#5521](https://github.com/morluto/rea/issues/5521), [#5731](https://github.com/morluto/rea/issues/5731), [#5837](https://github.com/morluto/rea/issues/5837), [#7076](https://github.com/morluto/rea/pull/7076). Thanks @Afloat16, @coygeek, @jdotc1, @kaoru0822-kitauji, @WenyuChiou.
- **Extraction and file ownership:** Restrict destination-case recovery to owned collisions, retain physical-read failures through late cancellation/cleanup, preserve cleanup capabilities for retry, and retain independent firmware extraction failures. [932fbb7](https://github.com/morluto/rea/commit/932fbb7d84a9a995b9aee3c1be7da05a8c4d7bbb), [9499667](https://github.com/morluto/rea/commit/949966712e68d8857a50a165ecddf04c2d7e6d3b), [56679dd](https://github.com/morluto/rea/commit/56679dd2ae31dda58e181f8bf99775014f7bb82b), [b3c912a](https://github.com/morluto/rea/commit/b3c912ab79ad147a37b6cfbe1552a1a5eecec629), [7298bd0](https://github.com/morluto/rea/commit/7298bd08d134860b84b4073f6703021916a5a4c5).
- **Processes and cancellation:** Retain partial samples and shutdown gaps, unresolved descendants and caller abort reasons; bind cleanup errors to their owners, propagate comparison contradictions, and report no normal exit code for signalled targets. [ba866a2](https://github.com/morluto/rea/commit/ba866a26ecbe179a717e746cbc0d1605ae616ad5), [#5270](https://github.com/morluto/rea/pull/5270), [#6144](https://github.com/morluto/rea/pull/6144), [a721c42](https://github.com/morluto/rea/commit/a721c42c07dc674c32ab939627355b8a1bee97a5), [#6298](https://github.com/morluto/rea/pull/6298), [#6486](https://github.com/morluto/rea/pull/6486), [#5935](https://github.com/morluto/rea/issues/5935), [#5944](https://github.com/morluto/rea/issues/5944), [#6100](https://github.com/morluto/rea/issues/6100), [#6101](https://github.com/morluto/rea/issues/6101), [#6110](https://github.com/morluto/rea/issues/6110), [#6113](https://github.com/morluto/rea/issues/6113), [#6121](https://github.com/morluto/rea/issues/6121), [#6131](https://github.com/morluto/rea/issues/6131), [#6132](https://github.com/morluto/rea/issues/6132), [#6218](https://github.com/morluto/rea/issues/6218), [#6445](https://github.com/morluto/rea/issues/6445). Thanks @agorevski, @coygeek, @gongfpp, @kwakhyun, @mhamzasakhi.
- **Provider cleanup:** Preserve Windows native handles until close is confirmed, native/Inspector/Electron cleanup ownership, Kuna probe identity and cleanup, IDA registration configuration, and Hopper preparation ownership. [#5772](https://github.com/morluto/rea/pull/5772), [87ab054](https://github.com/morluto/rea/commit/87ab054ea384b3fcbae2998b1f94685edcd5f624), [ff78165](https://github.com/morluto/rea/commit/ff78165978de9dbcf9fa16c2acf74bf85a69dc44), [04ae07a](https://github.com/morluto/rea/commit/04ae07ab8c9ae1a6697b6ad15489bbde515da8b5), [dd0015a](https://github.com/morluto/rea/commit/dd0015aaf156c5701ef9598bcc6c885e6b8da803), [b231c28](https://github.com/morluto/rea/commit/b231c28cf64c2f799ada99343f8f21e0e6acb15e), [#4505](https://github.com/morluto/rea/issues/4505), [#5616](https://github.com/morluto/rea/issues/5616).
- **Provider diagnostics:** Give Ghidra restart recovery, stable Homebrew aliases, unsupported-host results for Linux-only integrations, correct IDA regex/readiness handling, and clear diagnostics when Windows refuses a verified native addon. [#5356](https://github.com/morluto/rea/pull/5356), [7c6142e](https://github.com/morluto/rea/commit/7c6142efdc19a42c148d0e8c96b69d18e63c7f87), [#5793](https://github.com/morluto/rea/pull/5793), [#4862](https://github.com/morluto/rea/pull/4862), [99ccfb6](https://github.com/morluto/rea/commit/99ccfb6e709ac4bc0afe176315280abde9ebcb9f), [#6832](https://github.com/morluto/rea/pull/6832), [#5730](https://github.com/morluto/rea/issues/5730), [#4860](https://github.com/morluto/rea/issues/4860), [#5723](https://github.com/morluto/rea/issues/5723). Thanks @coygeek, @dark13b, @gensokyo-dev, @jgt87, @jpmorris41488, @Lew1sWong.
- **MCP results:** Preserve protocol envelopes on oversized errors, enforce and advertise absolute Evidence paths, retain typed output-filter errors and selected JSON paths, and give client/provider timeout recovery. Compact advertisements now normalize reported enum and union shapes for strict gateway translation. [562dab0](https://github.com/morluto/rea/commit/562dab00c5cbf76a9b2695bad93792eccdc9a49d), [3cf6206](https://github.com/morluto/rea/commit/3cf6206614e65b5ebb6284a5709090dfb8f9aaee), [0e83d92](https://github.com/morluto/rea/commit/0e83d92c583ae36afe00b2c23dd2a0f1d025cbca), [4714c7e](https://github.com/morluto/rea/commit/4714c7eaa3d1d8b6a5df0aff586e844b9d9ab06d), [1bfa60a](https://github.com/morluto/rea/commit/1bfa60ac20e1a344bcf3132c08d15b6860b05c61), [#5608](https://github.com/morluto/rea/pull/5608), [#3806](https://github.com/morluto/rea/pull/3806), [#5598](https://github.com/morluto/rea/issues/5598), [#3800](https://github.com/morluto/rea/issues/3800). Thanks @gensokyo-dev, @Hahaa909, @wang1xiang.
- **Browser lifecycles:** Retain historical outcomes through cleanup, stop late navigation before session release, stop expired work, observe aborted fetch settlement, and mark later scenario actions skipped after failure or cancellation. [2e5171e](https://github.com/morluto/rea/commit/2e5171e391b83f8a467d0861fd452c1f78621fd8), [599fdac](https://github.com/morluto/rea/commit/599fdac029912f96c511f859660483405d2de26f), [b2fad36](https://github.com/morluto/rea/commit/b2fad362f2b37f81dc9a6f784f4521e4ca24d41e), [13a8640](https://github.com/morluto/rea/commit/13a864020414577006dce58d7fdaa877ddd0cb52), [#6023](https://github.com/morluto/rea/pull/6023), [#5943](https://github.com/morluto/rea/issues/5943). Thanks @coygeek, @kaoru0822-kitauji.
- **Browser comparisons:** Preserve frame identity, default origin scope, unknown body/shape coverage, correspondence and uncertainty, and independent retained-observation budgets. [#4040](https://github.com/morluto/rea/pull/4040), [#4413](https://github.com/morluto/rea/pull/4413), [#4476](https://github.com/morluto/rea/pull/4476), [a0c22ff](https://github.com/morluto/rea/commit/a0c22ff0125b8af7612db54d3708413e2bfecb25), [a0fcc60](https://github.com/morluto/rea/commit/a0fcc60d89eb0cc09b08181eb9f961acfd07d8e9), [#3878](https://github.com/morluto/rea/issues/3878), [#3910](https://github.com/morluto/rea/issues/3910), [#3941](https://github.com/morluto/rea/issues/3941), [#4385](https://github.com/morluto/rea/issues/4385), [#4477](https://github.com/morluto/rea/issues/4477). Thanks @Adolanium, @coygeek, @eco-null, @gensokyo-dev, @kaoru0822-kitauji, @XY-code1.
- **Electron observations:** Preserve listener callback ownership and count registrations by source callsite; block trash calls in the active hook, retain window handles through cancelled selection, and preserve cancellation during finalization. [dfe8378](https://github.com/morluto/rea/commit/dfe8378cf5a727e3d93d47a5986233175c6ef898), [5064007](https://github.com/morluto/rea/commit/506400748eb1d6c674f0cf51330073929c45f939), [816a9dc](https://github.com/morluto/rea/commit/816a9dc98886e6d824cd8ae88b68731b161d5dda), [1707d17](https://github.com/morluto/rea/commit/1707d171d750955bf6387e028e378183b360ffe3), [4e2a566](https://github.com/morluto/rea/commit/4e2a566d6c7e053ecbbee1b684311ed31ea163bf).
- **JavaScript source maps:** Keep unmapped and missing mappings unknown, preserve partial indexed-map facts and section paths, propagate preparation capability errors, and retain observed worker failures through cancellation. [a4dbb36](https://github.com/morluto/rea/commit/a4dbb36d8ea83e9f94dd289ac1a2d220d2c72c9b), [2b2e362](https://github.com/morluto/rea/commit/2b2e362a00fc5ba2f93fa6c62e2d8780072d1b4b), [498a667](https://github.com/morluto/rea/commit/498a667234b0140c1cfa43c819b35454ab11d14e), [#6149](https://github.com/morluto/rea/pull/6149), [#6214](https://github.com/morluto/rea/pull/6214), [f01dcca](https://github.com/morluto/rea/commit/f01dccab77f712fb4ac936d0a6e92a70d12f0789), [#6082](https://github.com/morluto/rea/issues/6082), [#6061](https://github.com/morluto/rea/issues/6061). Thanks @coygeek, @diyasharma05, @kaoru0822-kitauji.
- **JavaScript semantics:** Preserve overflowing timer uncertainty, unavailable-scope comparisons, directory-form URL/ESM path intent, and artifact confinement. Replaced globals lose built-in effects; erased imports no longer become runtime bindings. Treat a known truthy `fork()` `silent` option as piped stdio unless a string/array `stdio` override takes precedence; unresolved options stay dynamic. [#3456](https://github.com/morluto/rea/pull/3456), [8d198d6](https://github.com/morluto/rea/commit/8d198d6ec707402d75276f516e0090d71767b7e4), [#4646](https://github.com/morluto/rea/pull/4646), [#2700](https://github.com/morluto/rea/pull/2700), [#4565](https://github.com/morluto/rea/pull/4565), [#6994](https://github.com/morluto/rea/pull/6994), [#3400](https://github.com/morluto/rea/issues/3400), [#3882](https://github.com/morluto/rea/issues/3882), [#3367](https://github.com/morluto/rea/issues/3367), [#7083](https://github.com/morluto/rea/pull/7083), [#7084](https://github.com/morluto/rea/issues/7084). Thanks @Adolanium, @amyanger, @coygeek, @gensokyo-dev, @HawkForge, @rohitg00, @viniciusdsandrade.
- **JavaScript routes and imports:** Treat path data as route candidates, preserve route flag and lexical RPC identities, package-main trailing-slash selection, catch aliases, and factory parameter ownership. [#6360](https://github.com/morluto/rea/pull/6360), [38ecc02](https://github.com/morluto/rea/commit/38ecc0248e1993d25a2f7dd350024484cce797bb), [#4219](https://github.com/morluto/rea/pull/4219), [21097b1](https://github.com/morluto/rea/commit/21097b192b1ab94647e3446b1a2a4dd00e924d5e), [f774dc4](https://github.com/morluto/rea/commit/f774dc420b3befe2b8e68971b4116da2d62fc800), [#6349](https://github.com/morluto/rea/issues/6349), [#4189](https://github.com/morluto/rea/issues/4189). Thanks @coygeek, @hemv-857, @kaoru0822-kitauji, @Nikhi00718.
- **Managed/IL2CPP:** Preserve extension-only scope uncertainty and type discovery after member limits, nested names, ReadyToRun/declaration facts, selected type scope, valid shared-suffix strings, and truncated IL2CPP metadata prefixes. [#5674](https://github.com/morluto/rea/pull/5674), [#5312](https://github.com/morluto/rea/pull/5312), [87fa1b6](https://github.com/morluto/rea/commit/87fa1b613d2b6bda1722855a00f1390f27731b64), [bc2d494](https://github.com/morluto/rea/commit/bc2d494030efd1ccabaeaa0bd49226aa87c378a2), [1f0eb22](https://github.com/morluto/rea/commit/1f0eb228e50908ee2a2aaa72d329178ae1a2cdbd), [4c5fae5](https://github.com/morluto/rea/commit/4c5fae5179dd54c4a0d427cd2a115b9c887e3841), [b3aadaf](https://github.com/morluto/rea/commit/b3aadaf474e59b33e5ff465236008a67eccefb87), [#5467](https://github.com/morluto/rea/issues/5467), [#5146](https://github.com/morluto/rea/issues/5146). Thanks @coygeek, @eco-null, @elricfd, @umi008.
- **Format boundaries:** Preserve independent facts across malformed inputs in model, GPU, WASM, Rust, Android, and SQLite inspection; report optional metadata warnings without discarding core results. [eb41f35](https://github.com/morluto/rea/commit/eb41f358cf83d5626f09de68332f9718f9aa6482), [#5789](https://github.com/morluto/rea/pull/5789), [00a9e95](https://github.com/morluto/rea/commit/00a9e95de91a4bd4d2a41f8aee704a53fa575750), [fc63fe8](https://github.com/morluto/rea/commit/fc63fe8682654086261540dcf3c59afc36c7d58f), [39a91d4](https://github.com/morluto/rea/commit/39a91d4db96ca13224c25936330ea84fe78970e5), [6c6e2ad](https://github.com/morluto/rea/commit/6c6e2ad62b20f810b54f5a567e66fc55241514b2), [929a0a7](https://github.com/morluto/rea/commit/929a0a76c870d9991e015dde58308fd9df0280b8), [d137a4c](https://github.com/morluto/rea/commit/d137a4cdde0049de967f1d5cd429ed9e1f7d0a10), [ef475fc](https://github.com/morluto/rea/commit/ef475fcf8b0601c61052b7091568ba574546417d), [#5749](https://github.com/morluto/rea/issues/5749). Thanks @coygeek, @gensokyo-dev.
- **Capture decoding:** Preserve malformed protobuf trailer facts and wire/schema identity, HTTP/2 URI and UTF-8 failure facts, WebMCP property coverage, and offline capture availability without a browser provider. Report invalid record ordinals as selection errors with actual bounds where available, and trim surrounding SP/HTAB from gRPC-web trailer values while preserving internal whitespace. [9cf7a7c](https://github.com/morluto/rea/commit/9cf7a7cb0d3c72a1121fde280cb11bf911af8055), [b3c3b21](https://github.com/morluto/rea/commit/b3c3b21e43cab4e71b460d08829d8c6e4e9b9c21), [4cb1f1d](https://github.com/morluto/rea/commit/4cb1f1d820df4498ee464bcf72a5f47d40cf8dab), [51e5938](https://github.com/morluto/rea/commit/51e593877642ab42fb5bf25812f4a4110ee7ac26), [d23be5c](https://github.com/morluto/rea/commit/d23be5c0898c39c9f0c54e2e0b43ee746d92d316), [#6725](https://github.com/morluto/rea/pull/6725), [#3947](https://github.com/morluto/rea/issues/3947), [#7067](https://github.com/morluto/rea/pull/7067), [#7068](https://github.com/morluto/rea/issues/7068), [#7069](https://github.com/morluto/rea/pull/7069), [#7071](https://github.com/morluto/rea/issues/7071). Thanks @Adolanium, @coygeek, @Sriram-PR.
- **Evidence and errors:** Authenticate ledger Evidence before committing; preserve parent-schema diagnostics, canonical correction details and owned cleanup outcomes; identify the rejected function-Evidence side/kind. Fixed allowances now name their actual limits. [0407bbf](https://github.com/morluto/rea/commit/0407bbfbe65e8fa475e8bb0c78c30170e2c2f55e), [#6361](https://github.com/morluto/rea/pull/6361), [1629266](https://github.com/morluto/rea/commit/1629266e3c08c90fed6bba5383528af7986a12b7), [#6969](https://github.com/morluto/rea/pull/6969), [#5860](https://github.com/morluto/rea/pull/5860), [#6034](https://github.com/morluto/rea/issues/6034), [#5932](https://github.com/morluto/rea/issues/5932), [#5847](https://github.com/morluto/rea/issues/5847). Thanks @AyoubElleuch, @coygeek, @dhruvac29, @kaoru0822-kitauji.
- **ADB and firmware recovery:** Report an unparsed push checksum as unverified, normalize absent installer-package sentinels, describe extraction-relative Unblob links, and avoid recommending a budget increase at its fixed ceiling. [#6010](https://github.com/morluto/rea/pull/6010), [#4073](https://github.com/morluto/rea/pull/4073), [#4573](https://github.com/morluto/rea/pull/4573), [#6971](https://github.com/morluto/rea/pull/6971), [#5924](https://github.com/morluto/rea/issues/5924), [#4175](https://github.com/morluto/rea/issues/4175). Thanks @coygeek, @Ganesh2325, @kaoru0822-kitauji, @Rinkia, @XiaoBinGan, @yankikucuk.
- **CLI formatting:** Share Markdown report formatting, exclude inherited row values, and preserve arrays of empty objects as JSON. Render Markdown table headers and cells literally while keeping intraword underscores readable. [b784912](https://github.com/morluto/rea/commit/b784912811fd10ac9dc425696dc0e9af632afa34), [#6984](https://github.com/morluto/rea/pull/6984), [#7058](https://github.com/morluto/rea/pull/7058), [#7057](https://github.com/morluto/rea/issues/7057), [#7073](https://github.com/morluto/rea/pull/7073). Thanks @Plastic-time, @ShuaixinHuang, @viniciusdsandrade.
- **Format identity:** Preserve Python marshal scalar/decode limits, empty optional BEAM chunks, PE resource branch identities and certificate alignment, unsupported compressed ELF notes, and codec-framed GPU bundle extents. [0603223](https://github.com/morluto/rea/commit/06032237c6755e3dd5f9a8db732c89958b238cc7), [c46064c](https://github.com/morluto/rea/commit/c46064c3f6eaba121c5de7b17390bfdecdd132ef), [66671e8](https://github.com/morluto/rea/commit/66671e874888e98f7e2b27e68a7c6fb320bbb827), [03077d5](https://github.com/morluto/rea/commit/03077d54afc49613db4e38f70c506bc60f5223aa), [#6721](https://github.com/morluto/rea/pull/6721), [9fb8c11](https://github.com/morluto/rea/commit/9fb8c114a03ad60e57c11586967c6df845a3f97e), [f6a1e2c](https://github.com/morluto/rea/commit/f6a1e2c892dc23c7583c3d03af9edb01632ff5a5), [#6694](https://github.com/morluto/rea/issues/6694). Thanks @coygeek, @Deepak-Kambala.
- **WASM and APK metadata:** Preserve ambiguous WASM identity and partial facts, glue URL query/fragment text across line terminators, APK signer identity, and raw issuer identity when comparison rules are unknown. [af8f0ba](https://github.com/morluto/rea/commit/af8f0badf64fd3546392b6aa4625777904b2f051), [#6802](https://github.com/morluto/rea/pull/6802), [f783f0f](https://github.com/morluto/rea/commit/f783f0f1e82472cdddd4de2156d974f729e332a6), [115a78f](https://github.com/morluto/rea/commit/115a78fe241276c34917b496621954c5f29bfc15), [#6639](https://github.com/morluto/rea/issues/6639). Thanks @coygeek, @gensokyo-dev, @gongfpp.
- **Source identity:** Preserve Next route spelling, module grammar and loader request identity, directory package-main behavior, accessor effects, exact source targets, and resolver-discovery versus module-loading distinctions. [ddd7ac7](https://github.com/morluto/rea/commit/ddd7ac7b846b48191ead1f7dcd0e3bd735468fa8), [9974512](https://github.com/morluto/rea/commit/99745126009b15060d71c38809418858a07d5afa), [f2e5fd1](https://github.com/morluto/rea/commit/f2e5fd148a85fa737302dd194a33172c4561093e), [baf1678](https://github.com/morluto/rea/commit/baf16784af3592534687052431c145daef55cfd1), [6e324b2](https://github.com/morluto/rea/commit/6e324b224405f2befd953234f6dc210cf72ad50a), [75daf0c](https://github.com/morluto/rea/commit/75daf0c7df108f04ab41f34aec1a31d4a7ceb322), [f91b7f8](https://github.com/morluto/rea/commit/f91b7f8009c9af27a5e0148e3b07d20bfe3b7a2a).
- **Graphs and selected facts:** Preserve JavaScript graph omissions/version facts, Electron native-loader facts, web JSON identity/coverage, module-path selection, feature-trace qualifications, selected native paths, endpoint context, and mixed Swift demangler outcomes. [30db499](https://github.com/morluto/rea/commit/30db499db310f073d9bf3d3acfd77985e1cb7e2e), [5a7bddb](https://github.com/morluto/rea/commit/5a7bddb3aeb0345854e76b79d529aed1c40e2054), [79805f2](https://github.com/morluto/rea/commit/79805f244a1ec0850f3109929168a9c8ebb1b908), [f719dc4](https://github.com/morluto/rea/commit/f719dc46c51a55b3926eec9659d06e7dfb95132b), [7784fdb](https://github.com/morluto/rea/commit/7784fdbad78f8b384d513f0e7dae8e983cd48ef8), [76500f1](https://github.com/morluto/rea/commit/76500f12b54e07b1ea700a403b2593890d63b42a), [676d29f](https://github.com/morluto/rea/commit/676d29f9eef794cea668f5f09f0ff510c848a513), [edf7b3d](https://github.com/morluto/rea/commit/edf7b3d32c3248f221e27f7ce5a3d34e8590285b), [93de7bc](https://github.com/morluto/rea/commit/93de7bc7e324a761162a31625b838ba0d4e3824d).
- **Managed boundaries:** Honor native platform symbol lookup, consume resolved IL2CPP ELF declarations, and attribute malformed comparison inputs to the supplied argument. [64fa1db](https://github.com/morluto/rea/commit/64fa1db1309218283df19f3ee4dba61f5fbd2a67), [87745af](https://github.com/morluto/rea/commit/87745af52ab0ccd3a172c2534c516d41b0095035), [96ad94f](https://github.com/morluto/rea/commit/96ad94f69eda5d68c7335ff775b6927b1376fd2b).
- **Provider and worker recovery:** Preserve output loss after successful command exit, physical refusal diagnostics, bounded worker control framing, JavaScript worker-phase/budget attribution, admitted ambiguity choices, and selected EVM limiter availability. Scope objdump debug-link limitations to DWARF requests and keep process-capture preparation nonexecuting. [e639edf](https://github.com/morluto/rea/commit/e639edf6204c05285d96840478926592daf95876), [171b33b](https://github.com/morluto/rea/commit/171b33b2c4defc6cbea49545bedf4272b72d1ea2), [34563fc](https://github.com/morluto/rea/commit/34563fcc9bd92af30668820dcac5635e27181094), [3f9357b](https://github.com/morluto/rea/commit/3f9357b5990d166a38440f56f439452266650093), [cec8f1e](https://github.com/morluto/rea/commit/cec8f1e8f305d6332272457a6ee419d3c5fb6359), [a74d859](https://github.com/morluto/rea/commit/a74d859a19122fb8f1282b3632d320997b1caae0), [c284168](https://github.com/morluto/rea/commit/c284168c4b1cd214ce7f504d43da28528d82d603), [4fb936f](https://github.com/morluto/rea/commit/4fb936fe86bb7a07f94f819ae8510301f2ef69c9).
- **Setup and limits:** Retain unknown environment-budget facts, selected-skill/maintenance uncertainty, Hopper URL admission and bookmark verification, and listener failure recovery that matches the system cause. [a718037](https://github.com/morluto/rea/commit/a7180370332350bc0f998fbd643888221759570e), [d1fbebb](https://github.com/morluto/rea/commit/d1fbebb578538dc94fd5e376e6e1959218efa835), [60accad](https://github.com/morluto/rea/commit/60accad2de8f2862fe91901502fe26cc5390fb36), [fd7da77](https://github.com/morluto/rea/commit/fd7da77fc02dcfaf7d1bc9f2fb240d71cdd27c59), [0c440bf](https://github.com/morluto/rea/commit/0c440bfc07f3cb343e2e836d27cccaed539cfe9c).
- **State and Evidence:** Retain export tarball ownership and SQLite primary outcomes through cleanup retry, count emitted SQLite schema names across encodings, scope display refresh to matching snapshot bindings, and report retained-result validation failures consistently. Reconstruction uses one effective completion scope and kind-based labels when names are blank. [ab58edc](https://github.com/morluto/rea/commit/ab58edcdf50b4bd687900ee2dc362ecc5c3dce15), [1006714](https://github.com/morluto/rea/commit/100671427105791a5c5913a918b63a394f6bc83e), [a47788a](https://github.com/morluto/rea/commit/a47788a6a4abb067273f954275a9d0a269adf1e7), [8aa40e9](https://github.com/morluto/rea/commit/8aa40e9a61155cff8b6f3c138c601bf805b20653), [b8c1b45](https://github.com/morluto/rea/commit/b8c1b45316882beeab4a9de49381d94e131fab0f), [a35b933](https://github.com/morluto/rea/commit/a35b9335a0124674ee5e3abe8c075f1fff6b4fa6), [#6137](https://github.com/morluto/rea/pull/6137), [#6126](https://github.com/morluto/rea/issues/6126). Thanks @carlogiovannineri-rgb, @mohithhhh.
- **Capture coverage:** Name browser bundle budgets and deadline recovery, separate domain readiness from worker attribution, attribute rendered-frame omissions to their producing stage, share offline-capture host admission with discovery, preserve selected signal-file semantics, and retain short Flutter GNU build IDs. [#6036](https://github.com/morluto/rea/pull/6036), [ba78133](https://github.com/morluto/rea/commit/ba781330d6d28b22d15498e63c144fb40e086156), [5934387](https://github.com/morluto/rea/commit/5934387f4185129efe9dc8b7338d8bc3fa5b25bd), [ad629b2](https://github.com/morluto/rea/commit/ad629b2e31c3a9495b27179360b508fa021fe86a), [928ba76](https://github.com/morluto/rea/commit/928ba76882bfd216dde8ed79118789b2c3aad4f9), [678c4cf](https://github.com/morluto/rea/commit/678c4cfa68e2fee12f620075e12dc87d9b1195b0).
- **Additional boundary facts:** Retain parser format/query occurrence identity and independent malformed-input facts, unresolved nested Swift identifiers, and completed signing-capture coverage; describe crash documents without assuming a provider. [5f702dd](https://github.com/morluto/rea/commit/5f702dd6ccd9e8e505e224854b91678439c3b41f), [99d2d7a](https://github.com/morluto/rea/commit/99d2d7ad22bcbd780919760008aba6a88e7d1077), [90e433d](https://github.com/morluto/rea/commit/90e433df06b3f83417176b8db1b0a905f9df1d3a), [#5548](https://github.com/morluto/rea/pull/5548), [ee12d51](https://github.com/morluto/rea/commit/ee12d517a25d34853d40e31fc039c7d1576c60e1), [#5538](https://github.com/morluto/rea/issues/5538). Thanks @coygeek, @ShuaixinHuang.
- **Documentation:** Add the Romanian README. [#7026](https://github.com/morluto/rea/pull/7026). Thanks @An3treiu.

Full contribution record: [1740 commits and 497 merged PRs](https://github.com/morluto/rea/blob/rea-agents-6.8.0/docs/releases/6.8.0.contributions.json).

## [6.7.0](https://github.com/morluto/rea/compare/rea-agents-6.6.0...rea-agents-6.7.0) (2026-10-18)

### Highlights

- Client configuration edits follow the duplicate-member semantics used by MCP clients.

### Changes

- Includes the [6.6.0 changes and migration notes](https://github.com/morluto/rea/releases/tag/rea-agents-6.6.0). That version was tagged but was not published to npm.

### Fixes

- **Client configuration:** Setup edits the last repeated JSON/JSONC member, matching the value clients actually read. Setup and uninstall refuse a removal that would reactivate a shadowed duplicate, preserving the original configuration. ([#4957](https://github.com/morluto/rea/pull/4957), [morluto/rea#4952](https://github.com/morluto/rea/issues/4952)). Thanks @kaoru0822-kitauji, @xu91102.

Full contribution record: [4 commits and 1 merged PR](https://github.com/morluto/rea/blob/rea-agents-6.7.0/docs/releases/6.7.0.contributions.json).

## [6.6.0](https://github.com/morluto/rea/compare/rea-agents-6.5.0...rea-agents-6.6.0) (2026-10-18)

### Highlights

- Add Kuna as a caller-supplied static-analysis provider.
- Query selected JavaScript facts and multiple APK locale tables without repeating the underlying analysis.
- Extend Ghidra analysis to Windows ARM PE targets and explicit raw m68k images.
- Preserve completed Evidence, cancellation reasons and retryable cleanup across provider and CLI finalization.

### Changes

- **Kuna analysis:** Use a caller-installed Kuna for procedure listings, pseudocode, assembly, call relationships, exact-address xrefs and cached string searches. Project exports retain source spans and digests; repeated requests reuse completed work. Recorded real-provider coverage uses Kuna 1.833 on Linux; Windows, PE and universal Mach-O are unsupported. See [the provider guide](docs/kuna-provider.md). ([#3832](https://github.com/morluto/rea/pull/3832), [#3854](https://github.com/morluto/rea/pull/3854), [#4071](https://github.com/morluto/rea/pull/4071), [#4095](https://github.com/morluto/rea/pull/4095)). Thanks @gensokyo-dev, @kaoru0822-kitauji, @N0zoM1z0.
- **Retained JavaScript facts:** Query exact application paths, selected properties and filtered module references through `inspect_analysis_view`, with paging and complete row Evidence. These views reuse completed analysis and preserve source selection and unknown coverage. ([#4265](https://github.com/morluto/rea/pull/4265), [morluto/rea#4190](https://github.com/morluto/rea/issues/4190), [#4097](https://github.com/morluto/rea/pull/4097), [morluto/rea#4092](https://github.com/morluto/rea/issues/4092)). Thanks @kaoru0822-kitauji, @N0zoM1z0.
- **APK locale tables:** Request several resource locales in one decode with repeatable CLI `--locales` or MCP `locales`. Each table reports its status and coverage; existing single-locale fields remain available. ([#4804](https://github.com/morluto/rea/pull/4804), [morluto/rea#4777](https://github.com/morluto/rea/issues/4777)). Thanks @abhay-2108, @N0zoM1z0.
- **Windows ARM binaries:** Ghidra admits ARMNT/Thumb-2 and ARM64 PE applications and DLLs on the Windows x64 host lane. Recorded Ghidra 12.1.4 verification uses `WindowsResourceReference` disabled and raised startup budgets; default-analyzer completion, ARM64EC/ARM64X and Windows-on-Arm hosts remain unverified or unsupported. See [the exact scope](docs/providers/windows-ghidra-p0.md#native-authority-and-target-identity). ([#3965](https://github.com/morluto/rea/pull/3965), [morluto/rea#2186](https://github.com/morluto/rea/issues/2186)). Thanks @N0zoM1z0, @WestLabsAI.
- **Raw m68k images:** Analyze explicitly selected big-endian m68k raw binaries using Ghidra’s fixed 68000 profile and a caller-supplied aligned entry. Real CLI/MCP verification used Ghidra 12.1.4 on macOS arm64; Linux is unverified and Windows P0 does not admit m68k. See [mapping requirements](docs/providers/raw-binary.md). ([#4018](https://github.com/morluto/rea/pull/4018)). Thanks @icedac.
- **JADX deadlines:** Set `REA_JADX_OPERATION_TIMEOUT_MS` to extend APK loading and upstream operation deadlines together. Doctor reports the effective value and setup forwards an explicit selection. ([#4466](https://github.com/morluto/rea/pull/4466), [morluto/rea#3918](https://github.com/morluto/rea/issues/3918)). Thanks @jaychou813, @SandstromPL.
- **Electron window options:** Resolve stable local constant `BrowserWindow` options while retaining source provenance. Relevant writes and escapes keep the result unknown. ([#4400](https://github.com/morluto/rea/pull/4400), [morluto/rea#4366](https://github.com/morluto/rea/issues/4366)). Thanks @kaoru0822-kitauji, @N0zoM1z0.
- **Language editions:** Add the Greek website edition and Malayalam documentation, with Korean typography and translation corrections across the site. ([#3520](https://github.com/morluto/rea/pull/3520), [#4792](https://github.com/morluto/rea/pull/4792), [#3821](https://github.com/morluto/rea/pull/3821), [morluto/rea#3820](https://github.com/morluto/rea/issues/3820), [#3799](https://github.com/morluto/rea/pull/3799), [morluto/rea#3798](https://github.com/morluto/rea/issues/3798), [#4344](https://github.com/morluto/rea/pull/4344), [#3856](https://github.com/morluto/rea/pull/3856), [#4166](https://github.com/morluto/rea/pull/4166)). Thanks @gensokyo-dev, @hi2242, @kalayciburak, @kaoru0822-kitauji, @kraken-503, @kukinghan, @N0zoM1z0, @yeseong0412.

### Fixes

- **Cancellation and cleanup:** Keep completed observations, exact cancellation reasons and the original physical failure through finalization. Failed cleanup retains its process or file owner for retry; recovered resources disappear from pending-cleanup reports without replacing the original error. ([#4238](https://github.com/morluto/rea/pull/4238), [morluto/rea#4232](https://github.com/morluto/rea/issues/4232), [#4274](https://github.com/morluto/rea/pull/4274), [morluto/rea#3923](https://github.com/morluto/rea/issues/3923), [3e82366](https://github.com/morluto/rea/commit/3e8236639abffa39deb5d5e939ec8baf6aaf3ca3), [16924e2](https://github.com/morluto/rea/commit/16924e275e939d0543ba01493324959a9e1d731c), [bbfe6ed](https://github.com/morluto/rea/commit/bbfe6edd60290f9bfbec68c8a0bcf605d8bbf5b3), [1f23e97](https://github.com/morluto/rea/commit/1f23e977b50301e91f02a4a17c9f8d48bb7b60f3), [08fbeb8](https://github.com/morluto/rea/commit/08fbeb8bdab27118b6c57039aef7c0fa8b6463bc)). Thanks @coygeek.
- **Provider startup:** Join prerequisite probes and in-flight readiness work before shutdown, preserve typed timeout and JVM-memory failures, and retain startup diagnostics through cleanup. Ghidra recognizes keg-only Homebrew JDKs and names the setting responsible for a startup timeout. ([376eeca](https://github.com/morluto/rea/commit/376eeca770820b31f7f8d4c5fcc397315621643e), [ceeff5a](https://github.com/morluto/rea/commit/ceeff5a41788e47e5aee96a4baf191a6ce7fde4b), [3ad1032](https://github.com/morluto/rea/commit/3ad1032b11edea2dcb054e78f951cc43159ae83d), [964decd](https://github.com/morluto/rea/commit/964decd989acfa84c4bfc3295362c4c46877fc20), [3fa972a](https://github.com/morluto/rea/commit/3fa972af7c7cb6cf014ffc426bdf7130dc6f2fd2), [#4557](https://github.com/morluto/rea/pull/4557), [morluto/rea#4556](https://github.com/morluto/rea/issues/4556), [#4590](https://github.com/morluto/rea/pull/4590), [morluto/rea#4241](https://github.com/morluto/rea/issues/4241)). Thanks @DanielCvz1, @J0UH, @Rinkia, @RishTheFish21, @vadlachary2002.
- **Client configuration:** Preserve the selected launcher, destination file, caller timeout choices and unresolved configuration evidence. Setup/uninstall recovery stays bound to the exact published file, keeps current verified backups, and transfers failed cleanup ownership for retry. ([d0253c9](https://github.com/morluto/rea/commit/d0253c99d65afbbd12732a2fdaf711640574e17f), [7e4eed9](https://github.com/morluto/rea/commit/7e4eed9dd48485b6a7100300aa98401811c2deb9), [2fb5e20](https://github.com/morluto/rea/commit/2fb5e204a35723f6f843d56ca47b0db94d8fcc44), [8235210](https://github.com/morluto/rea/commit/823521085a28f825e7fee1929d852d420042d1f7), [d818c3d](https://github.com/morluto/rea/commit/d818c3d2639d3115edb8a5269a754101aea6c3bd), [19329e4](https://github.com/morluto/rea/commit/19329e43bb38ca9d64512d801b25abcb188d2512), [dadf909](https://github.com/morluto/rea/commit/dadf909dce2e8b3d055541de69b4118d21276316), [333e0ab](https://github.com/morluto/rea/commit/333e0ab0dfc126a9915907d5079ed6195190e38e), [c15c206](https://github.com/morluto/rea/commit/c15c2062ad815cc9a3222ccfaeb7ef53cacd8b72)). Thanks @Adolanium.
- **Configuration formats:** Read signed 64-bit TOML integers without rounding, handle large TOML documents without argument-spread failures, preserve JSONC trivia and Hermes YAML scalar text, and reject NUL bytes in registration environment values. ([#4937](https://github.com/morluto/rea/pull/4937), [morluto/rea#4917](https://github.com/morluto/rea/issues/4917), [c43bc0b](https://github.com/morluto/rea/commit/c43bc0bf66a4e245a0cafa40def0d0207bcbd73c), [4fd28fc](https://github.com/morluto/rea/commit/4fd28fc9e0c4f8358147af38c72ab9e814f52d61), [#3568](https://github.com/morluto/rea/pull/3568), [#4335](https://github.com/morluto/rea/pull/4335)). Thanks @alfredo1491, @gensokyo-dev, @kaoru0822-kitauji, @N0zoM1z0, @ShuaixinHuang, @xu91102.
- **Claude Code configuration:** Setup, doctor and uninstall now accept only the strict JSON format Claude Code reads, including a leading UTF-8 BOM. Comments and trailing commas are refused before backup or writing; clients that support JSONC retain their existing behavior. ([#4944](https://github.com/morluto/rea/pull/4944), [morluto/rea#4940](https://github.com/morluto/rea/issues/4940)). Thanks @kaoru0822-kitauji, @xu91102.
- **CLI output and dispatch:** Accept `--flag=value` and spaced global output values, keep array positions in filtered JSON, validate integer tokens before coercion, and exit quietly when the output reader closes. Cancellation remains effective through command finalization; app bundles and static native inspections select the intended workflow. ([#3811](https://github.com/morluto/rea/pull/3811), [#4823](https://github.com/morluto/rea/pull/4823), [2ae4e16](https://github.com/morluto/rea/commit/2ae4e1608f290c95ff7cff28c4d16a79b301d03d), [8d82579](https://github.com/morluto/rea/commit/8d8257928bbe8d43fedffc4db5fca26c8108820f), [#3781](https://github.com/morluto/rea/pull/3781), [279c590](https://github.com/morluto/rea/commit/279c590ef6bb737d4a48ea696a0ae5eb30010b3d), [#3511](https://github.com/morluto/rea/pull/3511), [morluto/rea#3321](https://github.com/morluto/rea/issues/3321), [f31b231](https://github.com/morluto/rea/commit/f31b231a92a61be6bd1800b16be0b3210ae82944)). Thanks @arjunprabhulal, @coygeek, @kaoru0822-kitauji, @ShuaixinHuang, @Sriram-PR, @Tapraj-Pathak.
- **Updates:** Route `--update` through the verified updater and bound retained package-manager diagnostics. ([4f7b5fb](https://github.com/morluto/rea/commit/4f7b5fb6023ce2ec449561782d09e3c7e5ac7c7b), [01cdbbd](https://github.com/morluto/rea/commit/01cdbbdc556262c47d04a5b3391dd9c17946d3fc)).
- **MCP contracts:** Advertise self-contained tool inputs while preserving tuple, array, Boolean and nested-JSON constraints across schema profiles. Schema-reference handling no longer rewrites literal metadata; catalog identity includes the output-schema profile. ([5e30969](https://github.com/morluto/rea/commit/5e30969cc5f1255d44ec7a1f1ca8dbac0af5e7c4), [10aa74d](https://github.com/morluto/rea/commit/10aa74dfedc3ae776f50d1fa1eb83b64ae82d3d6), [204b9f3](https://github.com/morluto/rea/commit/204b9f3ac140a993c3e458bb0e117de31818ab29), [b3389a5](https://github.com/morluto/rea/commit/b3389a5b0834265fe7a40391be315d810a53a97e), [a2e3016](https://github.com/morluto/rea/commit/a2e30168a046f3b79319eb7fbaf807b802104199), [ba98130](https://github.com/morluto/rea/commit/ba98130049fa40ade66b03611ff70c7ddc011a1d), [c5fb86d](https://github.com/morluto/rea/commit/c5fb86d1948af0a287a581b29b2b1d554743c607)). Thanks @akushonkamen, @HarsH-1877, @kaoru0822-kitauji, @xingzihai.
- **Session ordering:** Keep snapshot admission ahead of later calls on the same connection, retain shutdown signals until cleanup succeeds, and preserve inspection authority through investigation publication. ([#3661](https://github.com/morluto/rea/pull/3661), [morluto/rea#3334](https://github.com/morluto/rea/issues/3334), [8873b39](https://github.com/morluto/rea/commit/8873b39770e89eae22b7693bc492d7e423b22bea), [663d07f](https://github.com/morluto/rea/commit/663d07f02cd62c99d81c59391d2c6d745c875335)). Thanks @coygeek, @rudycelekli, @Swatantra-66.
- **JavaScript exports and resolution:** Retain CommonJS exports created with `Object.defineProperty` and track export receiver lifetimes. Resolve scoped packages, package `main`, JSON requires and `.mts`/`.cts` imports using the owning loader; overwritten `require` bindings and erased type-only imports no longer create false runtime links. ([#4725](https://github.com/morluto/rea/pull/4725), [morluto/rea#4724](https://github.com/morluto/rea/issues/4724), [#3567](https://github.com/morluto/rea/pull/3567), [morluto/rea#3541](https://github.com/morluto/rea/issues/3541), [#4838](https://github.com/morluto/rea/pull/4838), [morluto/rea#4632](https://github.com/morluto/rea/issues/4632), [#3844](https://github.com/morluto/rea/pull/3844), [morluto/rea#3383](https://github.com/morluto/rea/issues/3383), [#4164](https://github.com/morluto/rea/pull/4164), [morluto/rea#3915](https://github.com/morluto/rea/issues/3915), [#4223](https://github.com/morluto/rea/pull/4223), [#3801](https://github.com/morluto/rea/pull/3801), [morluto/rea#3393](https://github.com/morluto/rea/issues/3393), [#4165](https://github.com/morluto/rea/pull/4165), [morluto/rea#3932](https://github.com/morluto/rea/issues/3932)). Thanks @Abishek0070, @coygeek, @JNTMTMTM, @kaoru0822-kitauji, @prasad2512, @rodricksz4h5, @xu91102.
- **JavaScript value flow:** Preserve values captured before later assignments, guarded factory fallthrough and nested destructuring. Track exact property keys and setter writes; direct `eval`, compound assignments and incoming callbacks preserve unresolved effects instead of inventing certainty. ([#4196](https://github.com/morluto/rea/pull/4196), [morluto/rea#3881](https://github.com/morluto/rea/issues/3881), [#4341](https://github.com/morluto/rea/pull/4341), [morluto/rea#3963](https://github.com/morluto/rea/issues/3963), [bfb7ed0](https://github.com/morluto/rea/commit/bfb7ed0bd43edc605e00fc52c6e21e735b285904), [#3480](https://github.com/morluto/rea/pull/3480), [#3831](https://github.com/morluto/rea/pull/3831), [morluto/rea#3312](https://github.com/morluto/rea/issues/3312), [9ac76d3](https://github.com/morluto/rea/commit/9ac76d3d9486856d25395b413d7ac5ffa744cad0), [#4342](https://github.com/morluto/rea/pull/4342), [morluto/rea#4206](https://github.com/morluto/rea/issues/4206), [#4243](https://github.com/morluto/rea/pull/4243), [morluto/rea#3880](https://github.com/morluto/rea/issues/3880)). Thanks @coygeek, @kaoru0822-kitauji, @maxazure, @N0zoM1z0, @ShuaixinHuang.
- **JavaScript relationships:** Distinguish `Map` reads from network endpoints, associate response endpoints only with writes that reach the read, and preserve child-process receiver ownership and effective stdio choices. Version comparisons keep relocation and unknown relationships distinct from application changes. ([fbfdb6a](https://github.com/morluto/rea/commit/fbfdb6abe9d663be0be146a15a489e33ccba0f68), [#4759](https://github.com/morluto/rea/pull/4759), [morluto/rea#4606](https://github.com/morluto/rea/issues/4606), [#3819](https://github.com/morluto/rea/pull/3819), [morluto/rea#3362](https://github.com/morluto/rea/issues/3362), [#4336](https://github.com/morluto/rea/pull/4336), [morluto/rea#3355](https://github.com/morluto/rea/issues/3355), [556504e](https://github.com/morluto/rea/commit/556504edcbb0f8cd9eaf81a91b18ff891b8f5457), [4d980d0](https://github.com/morluto/rea/commit/4d980d017622d3175d86aaf3b0dcfbdf4ca3d091)). Thanks @Abdooo2235, @coygeek, @kaoru0822-kitauji, @Xinglan233.
- **JavaScript source admission:** Parse JavaScript with its own grammar, refuse FIFO recovery inputs without blocking, and report oversized or resource-skipped files with their actual capacity and coverage state. Malformed runtime events stay excluded rather than becoming policy-filtered facts. ([#3782](https://github.com/morluto/rea/pull/3782), [morluto/rea#3780](https://github.com/morluto/rea/issues/3780), [#3788](https://github.com/morluto/rea/pull/3788), [morluto/rea#3332](https://github.com/morluto/rea/issues/3332), [#4757](https://github.com/morluto/rea/pull/4757), [morluto/rea#4629](https://github.com/morluto/rea/issues/4629), [#3852](https://github.com/morluto/rea/pull/3852), [morluto/rea#3670](https://github.com/morluto/rea/issues/3670), [#4755](https://github.com/morluto/rea/pull/4755), [morluto/rea#4685](https://github.com/morluto/rea/issues/4685)). Thanks @andresaragon, @coygeek, @kaoru0822-kitauji, @sx4im.
- **Browser capture:** Bound CDP handshakes and command responses, preserve malformed inventory uncertainty and partial cleanup diagnostics, and report cancellation after content reads and final cleanup. Accessibility comparisons require observed coverage; attached emulation teardown limits remain explicit. ([#3555](https://github.com/morluto/rea/pull/3555), [morluto/rea#3553](https://github.com/morluto/rea/issues/3553), [#3901](https://github.com/morluto/rea/pull/3901), [morluto/rea#3379](https://github.com/morluto/rea/issues/3379), [4cc044b](https://github.com/morluto/rea/commit/4cc044be68f813e96907e6cedcf422d0a3170de3), [#4406](https://github.com/morluto/rea/pull/4406), [morluto/rea#4403](https://github.com/morluto/rea/issues/4403), [#2893](https://github.com/morluto/rea/pull/2893), [0123d59](https://github.com/morluto/rea/commit/0123d5976828bfe621bd51daa4cf39fee48a1349), [2ff0867](https://github.com/morluto/rea/commit/2ff086796ad7b8f60397956750584e170dbe2910)). Thanks @coygeek, @dakjdakd, @kaoru0822-kitauji, @maxazure, @N0zoM1z0, @YunzhouLi-hub.
- **Browser page facts:** Preserve URL path bytes when removing credentials, repeated document `Link` headers and complete COOP/COEP structured items. WebMCP discovery reads the actual schema properties and exact receiver path. ([#4731](https://github.com/morluto/rea/pull/4731), [df2fc25](https://github.com/morluto/rea/commit/df2fc251e318a1255309dba232f9f73c700777b6), [c360cfc](https://github.com/morluto/rea/commit/c360cfcd6d7901514b16dd6113eba2e0b0fdf422), [ebd5a82](https://github.com/morluto/rea/commit/ebd5a82c439f6deb3a06062225ce009eb03257cf), [38f92d1](https://github.com/morluto/rea/commit/38f92d108e3148cdf47e4ffbfe3de8a76e795d51)). Thanks @Abdooo2235, @geekwolf, @ShuaixinHuang.
- **Electron runtime capture:** Keep native IPC listener and one-shot dispatch behavior, block synchronous shell effects during capture, refuse active scenarios when the inspect fuse is disabled, and preserve fuse/transport cleanup ownership. ([#4389](https://github.com/morluto/rea/pull/4389), [morluto/rea#4390](https://github.com/morluto/rea/issues/4390), [#4605](https://github.com/morluto/rea/pull/4605), [morluto/rea#4593](https://github.com/morluto/rea/issues/4593), [#4562](https://github.com/morluto/rea/pull/4562), [morluto/rea#4393](https://github.com/morluto/rea/issues/4393), [#3605](https://github.com/morluto/rea/pull/3605), [morluto/rea#3453](https://github.com/morluto/rea/issues/3453), [f9de413](https://github.com/morluto/rea/commit/f9de41371f7536e2e22ce6e43c9314fa2f238a30), [e7df00e](https://github.com/morluto/rea/commit/e7df00e80777757b329bbe8aba6d421d8892b9d5)). Thanks @Adolanium, @gensokyo-dev, @gkobayashi0, @HarsH-1877, @kaoru0822-kitauji, @keeponlight, @N0zoM1z0, @Nitin13-git, @xu91102.
- **APK resource accuracy:** Retain completed tables and decode facts after interrupted or failed reads. Derive locale limits from resource configuration fields, disclose unselectable qualified tables, distinguish document failures from omitted entries, and bind Evidence to the decoded snapshot. ([34a88d6](https://github.com/morluto/rea/commit/34a88d6c1674710953e2c94bd0a17332cd69ca6f), [f5fcf52](https://github.com/morluto/rea/commit/f5fcf5216ffb3a266b8c00f6d9a0943051084ab5), [6385ef4](https://github.com/morluto/rea/commit/6385ef4355d7a794b3154ee38529cbddee583336), [98886ad](https://github.com/morluto/rea/commit/98886adddfcbd7b4f4236b3a9825f91878c3cb11), [dc2e811](https://github.com/morluto/rea/commit/dc2e8117b60c4481372ed89b077e6c1cf81ee653), [#4771](https://github.com/morluto/rea/pull/4771), [morluto/rea#4768](https://github.com/morluto/rea/issues/4768)). Thanks @abhay-2108, @gensokyo-dev, @Iyanuoluwa007, @kaoru0822-kitauji, @N0zoM1z0.
- **Apktool guidance:** Retain the observed version and disclose the matching platform/release advisory windows without treating a version string as proof of decoder safety. Missing prerequisites and decode refusals identify the selected APK or launcher. ([d38f099](https://github.com/morluto/rea/commit/d38f099692394ec90c582f9f0a14b036b421b160), [63696d2](https://github.com/morluto/rea/commit/63696d277328f556c971d1fc9f81ae83128d468b), [cc038da](https://github.com/morluto/rea/commit/cc038da218cada68c87700477aba3db4739791ff)). Thanks @GovinduSasanka, @peter-research.
- **Android method bodies:** Recover original bytecode bodies when Java source is omitted while preserving genuine native/abstract body absence and primary failures during retryable cleanup. ([63c65a2](https://github.com/morluto/rea/commit/63c65a22430a4bbc0c1807a0298edb867775001f), [742b6f5](https://github.com/morluto/rea/commit/742b6f587f3c4ef1b8212e7376d6f3a305b194dc), [9fa6d2b](https://github.com/morluto/rea/commit/9fa6d2b254cc390665974efb52463386a029e9fc)). Thanks @balkan16, @Chessing234.
- **ADB observations and transfers:** Preserve display-scoped focus, distinguish missing declarations from absent focus, retain numeric physical density and mark unknown permission coverage partial. Transfers use consumed snapshot identity and refuse unknown destination existence; uninstall requests explicitly select user zero. ([7086768](https://github.com/morluto/rea/commit/7086768a27242a15daa93486aefbaacc3c891e78), [3d028db](https://github.com/morluto/rea/commit/3d028dbc74a465f6f8df1813a931fbb5362e7dc3), [#4074](https://github.com/morluto/rea/pull/4074), [morluto/rea#3942](https://github.com/morluto/rea/issues/3942), [#4663](https://github.com/morluto/rea/pull/4663), [#4665](https://github.com/morluto/rea/pull/4665), [1342127](https://github.com/morluto/rea/commit/1342127e91d4db8b4113a7a4e85be909bc96e1db), [61e6880](https://github.com/morluto/rea/commit/61e688070f48016b6d178cd04c02fcc2f33e19ad), [be0b2d1](https://github.com/morluto/rea/commit/be0b2d138c46bb951fc3c8ee57ef7b0d57fed312)). Thanks @coygeek, @gongfpp, @Tapraj-Pathak, @yankikucuk.
- **Apple metadata:** Preserve exact plist/keyed-archive integers, negative zero, non-finite real identity and dictionary keys. Reject malformed XML before value decoding, retain undecodable dates as unknown and report unsupported OpenStep entries explicitly. ([#4324](https://github.com/morluto/rea/pull/4324), [morluto/rea#4292](https://github.com/morluto/rea/issues/4292), [2cf9c28](https://github.com/morluto/rea/commit/2cf9c28f27261b7e64af2ba7ecb4e23ea7714aee), [#4839](https://github.com/morluto/rea/pull/4839), [morluto/rea#4834](https://github.com/morluto/rea/issues/4834), [f2b7bbb](https://github.com/morluto/rea/commit/f2b7bbb31279a820f4cf32d439570f8e5381d010), [6c98708](https://github.com/morluto/rea/commit/6c98708793c23615de8053b2cd14d9f164b960c5), [78cf610](https://github.com/morluto/rea/commit/78cf6100f33ad2412c0a3d60b83f8a44a43fbbb5), [c7e9e09](https://github.com/morluto/rea/commit/c7e9e096d3e2444e4c251123b8e914e9c0941f4e), [#3793](https://github.com/morluto/rea/pull/3793), [#4105](https://github.com/morluto/rea/pull/4105), [morluto/rea#3892](https://github.com/morluto/rea/issues/3892)). Thanks @coygeek, @kaoru0822-kitauji, @mertkayacs, @pablodiazjorge, @pollychen-lab, @xu91102.
- **Apple application structure:** Derive bundle components and launchd domains from their owning directories, retain unavailable components, and select only exact `Assets.car` names as asset catalogs. Interface Builder keeps unresolved classes and counts hierarchy records beyond the returned object page. ([149a0fc](https://github.com/morluto/rea/commit/149a0fc06c3c67ee45624e6da14dfb0754473758), [5d6029e](https://github.com/morluto/rea/commit/5d6029ea62a65ec34fd739ee40223c77c6fdb63b), [c192c58](https://github.com/morluto/rea/commit/c192c58815ddeaf5cf30159e7082c742c0bc36b7), [#4094](https://github.com/morluto/rea/pull/4094), [morluto/rea#3914](https://github.com/morluto/rea/issues/3914), [#4118](https://github.com/morluto/rea/pull/4118), [morluto/rea#3958](https://github.com/morluto/rea/issues/3958), [#4162](https://github.com/morluto/rea/pull/4162), [morluto/rea#3950](https://github.com/morluto/rea/issues/3950)). Thanks @coygeek, @kaoru0822-kitauji.
- **Native names and layout:** Keep valid Objective-C records beside malformed neighbors, preserve leading U+FEFF and repeated load-command fields, and select exact arm64e.x1 slices. PE resource ownership and NativeAOT reads stay within declared image/header ranges. ([#3833](https://github.com/morluto/rea/pull/3833), [morluto/rea#3336](https://github.com/morluto/rea/issues/3336), [#4549](https://github.com/morluto/rea/pull/4549), [morluto/rea#4540](https://github.com/morluto/rea/issues/4540), [morluto/rea#4541](https://github.com/morluto/rea/issues/4541), [#4730](https://github.com/morluto/rea/pull/4730), [#4048](https://github.com/morluto/rea/pull/4048), [morluto/rea#4008](https://github.com/morluto/rea/issues/4008), [#3500](https://github.com/morluto/rea/pull/3500), [morluto/rea#3389](https://github.com/morluto/rea/issues/3389), [#4463](https://github.com/morluto/rea/pull/4463), [morluto/rea#4373](https://github.com/morluto/rea/issues/4373), [morluto/rea#4455](https://github.com/morluto/rea/issues/4455), [3fc0075](https://github.com/morluto/rea/commit/3fc007534bb2104d662b43cc712281f9d1d6a7d3), [4a076f3](https://github.com/morluto/rea/commit/4a076f368c62bdfb19415accad342e03a38d1005)). Thanks @coygeek, @Iyanuoluwa007, @jayinvers, @kaoru0822-kitauji, @kevinjosh10, @maxazure, @ShuaixinHuang.
- **Native analysis providers:** Keep Ghidra byte matches within examined coverage, retain PE PDB/function-boundary limitations and preserve configured MIPS choices. Attached IDA refuses universal Mach-O rather than silently choosing a slice; request timeout identity and captured output survive adapter handling. ([#4531](https://github.com/morluto/rea/pull/4531), [#2933](https://github.com/morluto/rea/pull/2933), [morluto/rea#2259](https://github.com/morluto/rea/issues/2259), [01a1b3f](https://github.com/morluto/rea/commit/01a1b3fda6a7dacd24a0b10619d41d12153080d4), [50dd9fc](https://github.com/morluto/rea/commit/50dd9fcad1efb47cb404192c30bdf190dcdaca58), [#4765](https://github.com/morluto/rea/pull/4765), [morluto/rea#3871](https://github.com/morluto/rea/issues/3871), [c0cfccb](https://github.com/morluto/rea/commit/c0cfccb45fe43e7eeff18e56c64caa5b121988f9)). Thanks @BeLit-Development-2, @coygeek, @kaoru0822-kitauji, @N0zoM1z0, @ShuaixinHuang.
- **Recorded crashes:** Prevent GDB from discovering an executable named by an untrusted core, reject core mapping paths that escape the isolated sysroot, and preserve pwntools worker ownership across launcher exec. Completed decode facts and cancellation reasons remain available through failed final cleanup. ([5bf4fff](https://github.com/morluto/rea/commit/5bf4fffc1b835130ddb16f96db9ce13b639591db), [b33c0df](https://github.com/morluto/rea/commit/b33c0df02e93fabca00a44f2de625b1a63637ee9), [#4435](https://github.com/morluto/rea/pull/4435), [morluto/rea#4011](https://github.com/morluto/rea/issues/4011)). Thanks @coygeek, @N0zoM1z0.
- **Cutter and Rizin:** Read Cutter’s active document from core configuration and attribute its host version correctly. Keep interrupted Rizin frames and output whitespace before completion markers, with exact command and cleanup failure attribution. ([#4507](https://github.com/morluto/rea/pull/4507), [morluto/rea#4497](https://github.com/morluto/rea/issues/4497), [#4514](https://github.com/morluto/rea/pull/4514), [morluto/rea#4498](https://github.com/morluto/rea/issues/4498), [#4459](https://github.com/morluto/rea/pull/4459), [morluto/rea#4015](https://github.com/morluto/rea/issues/4015), [d5fc7e6](https://github.com/morluto/rea/commit/d5fc7e6ebf9af050081fc4c6e18b9079cfaa5cdc), [199396f](https://github.com/morluto/rea/commit/199396f61c8f61da326d059606a992304a760147)). Thanks @coygeek, @N0zoM1z0, @Xander-AJ.
- **Windows cleanup:** Retain unpublished runtimes after failed removal, handle read-only attributes and sharing conflicts, preserve primary snapshot failures and honor caller environment overrides. ([f78d137](https://github.com/morluto/rea/commit/f78d137b42741a0ed5fb8ac161286f9a50220c4d), [d69acc3](https://github.com/morluto/rea/commit/d69acc3455c33f90a2fc4381db43d38b6af50622), [0679a79](https://github.com/morluto/rea/commit/0679a7972b4f2b02eee6a86a44f50f4c2967d3cb), [5f9ac2c](https://github.com/morluto/rea/commit/5f9ac2c98a6fe11988c41afb737df9b6d5c3a1b3), [1bbf4bd](https://github.com/morluto/rea/commit/1bbf4bd16ca134cdb2187eaf29291cae90d14a57)). Thanks @DeryFerd.
- **Managed metadata:** Compare nominal signatures and declaring identities across builds, preserve empty names without display substitutions, verify ABI-prefixed Mach-O exports exactly, and charge cached metadata once. Metadata errors report artifact file offsets; mixed-mode assemblies retain their actual boundary classification. ([#3059](https://github.com/morluto/rea/pull/3059), [#3079](https://github.com/morluto/rea/pull/3079), [#3853](https://github.com/morluto/rea/pull/3853), [morluto/rea#3352](https://github.com/morluto/rea/issues/3352), [#3974](https://github.com/morluto/rea/pull/3974), [morluto/rea#3961](https://github.com/morluto/rea/issues/3961), [#3491](https://github.com/morluto/rea/pull/3491), [morluto/rea#3449](https://github.com/morluto/rea/issues/3449), [#4418](https://github.com/morluto/rea/pull/4418), [morluto/rea#4372](https://github.com/morluto/rea/issues/4372), [#3516](https://github.com/morluto/rea/pull/3516), [morluto/rea#3366](https://github.com/morluto/rea/issues/3366)). Thanks @8rulerstar, @coygeek, @duckhunt113, @Hahaa909, @JayOfTheKeyboard, @kaoru0822-kitauji, @keeponlight, @N0zoM1z0, @tomyrms.
- **Archive and filesystem identity:** Reject colliding extraction paths before writing, classify ZIP offsets beyond EOF as malformed, normalize ZIP current-directory prefixes once, and preserve symlink and unreadable-path provenance. A directory named `*.map` is no longer mistaken for a source-map file. ([862a0b2](https://github.com/morluto/rea/commit/862a0b2631785492f8dc20c8acd396646c545fd1), [c209dcb](https://github.com/morluto/rea/commit/c209dcb209118069f123e789949eeba1ef78853e), [6b1c36e](https://github.com/morluto/rea/commit/6b1c36e336eeacbb7159b211e687b4b84f99b9f5), [25c2222](https://github.com/morluto/rea/commit/25c22222abe7a681491bdb4d7316250fdcf32973), [d6e4fe4](https://github.com/morluto/rea/commit/d6e4fe4a4dd8914ec3db50d2a7fc3d0802649262), [#4131](https://github.com/morluto/rea/pull/4131), [morluto/rea#3909](https://github.com/morluto/rea/issues/3909)). Thanks @Adkid-Zephyr, @coygeek, @jackie-cqz, @kaoru0822-kitauji, @maxazure, @XY-code1.
- **Evidence and reconstruction:** Authenticate all retained inventory substeps, preserve source-attributed caveats in composed workflows, and require comparable cited Evidence before declaring reconstruction coverage or readiness. Missing Evidence and residual replay uncertainty stay explicit. ([9ac91e0](https://github.com/morluto/rea/commit/9ac91e0c1e13e91cd21341635ad5be89b0e8642d), [c4608a2](https://github.com/morluto/rea/commit/c4608a29620ea3e7bb8259b47357b942fe4e4709), [#4075](https://github.com/morluto/rea/pull/4075), [morluto/rea#3357](https://github.com/morluto/rea/issues/3357), [#3526](https://github.com/morluto/rea/pull/3526), [morluto/rea#3363](https://github.com/morluto/rea/issues/3363), [153017d](https://github.com/morluto/rea/commit/153017d750322188c1a112b2284c1b8065c67320)). Thanks @coygeek, @gensokyo-dev, @kaoru0822-kitauji, @N0zoM1z0, @rudycelekli.
- **Offline data:** Preserve exact UTC packet-capture instants, SQLite column identity and snapshot admission failures, and cooked WASM directive literals. Cleanup cancellation retains completed EVM/WASM observations rather than losing them. ([796faa0](https://github.com/morluto/rea/commit/796faa0e4e6bf745bcdc33acef65af8ccfc3622d), [748ac7f](https://github.com/morluto/rea/commit/748ac7f0df340f0d0569eca2e803a59cd51ffdbd), [bc51d0e](https://github.com/morluto/rea/commit/bc51d0ea5df7dcee1fcc42dfae3ab0c62c9cca5e), [4f87f02](https://github.com/morluto/rea/commit/4f87f02bb19bf77349a683a5bcb2da2d1da427d0), [d694aef](https://github.com/morluto/rea/commit/d694aef227e90164e6654ea9e5ce6a854d099404), [321cacb](https://github.com/morluto/rea/commit/321cacb84a020f447e1110df5c58fa71d99b7bf1)). Thanks @himamaheswarreddy, @mertkayacs, @rollroyces, @viniciusdsandrade.
- **Kuna recovery:** Share concurrent single-function requests and cache repeats, validate warm exports once, stream string inventories beyond the former fixed buffer ceiling, and keep unproven processes in their run slots until close confirms release. Failure messages distinguish final buffer refusals from configurable deadlines. ([#4045](https://github.com/morluto/rea/pull/4045), [#4169](https://github.com/morluto/rea/pull/4169), [#4049](https://github.com/morluto/rea/pull/4049), [#4318](https://github.com/morluto/rea/pull/4318), [#4052](https://github.com/morluto/rea/pull/4052), [#4098](https://github.com/morluto/rea/pull/4098), [#4343](https://github.com/morluto/rea/pull/4343)). Thanks @kaoru0822-kitauji.
- **Flutter snapshots:** Check symbol-table ranges against loadable segments and retain completed inspection facts when cancellation occurs during snapshot cleanup. ([#3859](https://github.com/morluto/rea/pull/3859), [morluto/rea#3346](https://github.com/morluto/rea/issues/3346), [#4766](https://github.com/morluto/rea/pull/4766), [morluto/rea#4717](https://github.com/morluto/rea/issues/4717), [#4762](https://github.com/morluto/rea/pull/4762), [morluto/rea#4640](https://github.com/morluto/rea/issues/4640)). Thanks @coygeek, @kaoru0822-kitauji.
- **Native metadata recovery:** Keep unknown Objective-C category classes, empty protocol names, undecoded Swift aliases and unfinished property types explicit instead of discarding neighboring valid records. Preserve unnamed segment identity and exclude a dylib’s own install name from dependencies. ([#4093](https://github.com/morluto/rea/pull/4093), [morluto/rea#4012](https://github.com/morluto/rea/issues/4012), [#4078](https://github.com/morluto/rea/pull/4078), [morluto/rea#3873](https://github.com/morluto/rea/issues/3873), [#4085](https://github.com/morluto/rea/pull/4085), [morluto/rea#3934](https://github.com/morluto/rea/issues/3934), [#3825](https://github.com/morluto/rea/pull/3825), [morluto/rea#3345](https://github.com/morluto/rea/issues/3345), [#4051](https://github.com/morluto/rea/pull/4051), [morluto/rea#3875](https://github.com/morluto/rea/issues/3875), [#4050](https://github.com/morluto/rea/pull/4050), [morluto/rea#3872](https://github.com/morluto/rea/issues/3872)). Thanks @coygeek, @kaoru0822-kitauji.
- **Document selection:** Preserve explicitly selected plist paths and bundle defaults, and only use document fallback after confirming its applicability. Finalization keeps completed selection facts and cancellation outcomes. ([e6c4877](https://github.com/morluto/rea/commit/e6c487799bb64f559e66b69be1863e6ec5187548), [#3774](https://github.com/morluto/rea/pull/3774), [9df559b](https://github.com/morluto/rea/commit/9df559b7e712298a761ff26e9caae8d659b7e54b)). Thanks @kaoru0822-kitauji.
- **Capture and comparison accuracy:** Admit schema-valid HAR numeric values while retaining exact-publication limits, preserve empty URL path segments, and keep unrelated process traces and unnamed reference endpoints distinct or unknown. ([#3159](https://github.com/morluto/rea/pull/3159), [morluto/rea#3145](https://github.com/morluto/rea/issues/3145), [#3792](https://github.com/morluto/rea/pull/3792), [morluto/rea#3307](https://github.com/morluto/rea/issues/3307), [#4178](https://github.com/morluto/rea/pull/4178), [morluto/rea#3931](https://github.com/morluto/rea/issues/3931), [#3809](https://github.com/morluto/rea/pull/3809), [morluto/rea#3388](https://github.com/morluto/rea/issues/3388)). Thanks @coygeek, @gensokyo-dev, @kaoru0822-kitauji, @N0zoM1z0, @pablodiazjorge, @xu91102.
- **Evidence publication:** Recheck staged output identity after its final write, classify missing review Evidence and duplicate ledger entries as caller input, and preserve the selected freshness requirement in comparison parameters. ([#4764](https://github.com/morluto/rea/pull/4764), [morluto/rea#4613](https://github.com/morluto/rea/issues/4613), [#4452](https://github.com/morluto/rea/pull/4452), [morluto/rea#4444](https://github.com/morluto/rea/issues/4444), [#4065](https://github.com/morluto/rea/pull/4065), [morluto/rea#4000](https://github.com/morluto/rea/issues/4000)). Thanks @amyanger, @coygeek, @kaoru0822-kitauji, @Rinkia, @Swatantra-66.

### ⚠ BREAKING CHANGES

- **Saved Evidence:** Evidence and analysis snapshots now require explicit nullable `relationship_coverage` in their identity commitments. Earlier records whose digest omitted null coverage are incompatible even when the serialized field is explicitly null. Artifact inventories require scoped coverage and explicit `integrity_contradictions`; obsolete `coverage_status` and prose-based coverage inference are removed. Regenerate old Evidence/snapshots and inventory observations with this release: saved files are not migrated and omitted facts are not filled with guessed defaults. ([db8128d](https://github.com/morluto/rea/commit/db8128dc0d1c4f731f3d19877fa00d25cf17f657), [0405c9d](https://github.com/morluto/rea/commit/0405c9d361de6d904dfa16cc0b6d8350407f2c9b), [a9588be](https://github.com/morluto/rea/commit/a9588be4ebdd20eeda975cb63ffcdb1cd868b340)).
- **Browser capture results:** Consumers must retain resolved capture limits, event families and omission facts. Set desired budgets through the supported capture options; omitted caller inputs still select defaults, but stored observations must report the resolved values. Admitted content reads queue behind bounded concurrency. ([57a23f0](https://github.com/morluto/rea/commit/57a23f0a2da0fdc3835e203718ded8acea5a34e6)).
- **Android version codes:** `inspect_adb_package.version_code` is a decimal string rather than a JSON number. Read it as a string, or use `BigInt` for numeric comparison. ([#3485](https://github.com/morluto/rea/pull/3485), [morluto/rea#3368](https://github.com/morluto/rea/issues/3368), [7666a48](https://github.com/morluto/rea/commit/7666a482b69dc7cabdbac3bbaf89a43e32300192)). Thanks @coygeek, @kaoru0822-kitauji.
- **Native UI failures:** Failed or cancelled native UI scenarios now return typed errors with the collected report in `partial_observation`. Handle the error path and read that report instead of expecting a successful result containing failed steps. ([d909919](https://github.com/morluto/rea/commit/d9099190ab3a819bd3a9fd62a8714cef398016d5)).
- **Provider status:** `binary_session` candidate availability can be unknown during owner finalization. Preserve that state rather than treating it as unavailable; internal consumers must await the asynchronous session status API. ([150e996](https://github.com/morluto/rea/commit/150e996a86f2bec4982ba87f37bf502a8d5e8214)).
- **Swift symbol locations:** `swift_symbols` entries may have a null `address` when the provider supplies no location. Handle unknown addresses; optional `evidence.reported_address` retains the original provider value. ([8116dc0](https://github.com/morluto/rea/commit/8116dc06512b4609d8db63cebc9f2ff8cb964151)).
- **Linux Hopper admission:** Older builds previously admitted by a fixed allowlist need retained publisher-signed package evidence or an approved update to the current public demo. Update explicit `HOPPER_LAUNCHER_PATH` selections when migrating; the live feed offers only its current release. The official RPM metadata mismatch remains unresolved and is refused. ([#3590](https://github.com/morluto/rea/pull/3590), [morluto/rea#3577](https://github.com/morluto/rea/issues/3577), [70cd4cb](https://github.com/morluto/rea/commit/70cd4cbfb849b61f05d97d2690372a9782831426)). Thanks @gensokyo-dev, @kaoru0822-kitauji, @N0zoM1z0.

Full contribution record: [571 commits and 236 merged PRs](https://github.com/morluto/rea/blob/rea-agents-6.6.0/docs/releases/6.6.0.contributions.json).

## [6.5.0](https://github.com/morluto/rea/compare/rea-agents-6.4.0...rea-agents-6.5.0) (2026-10-13)

Provider prerequisites and recorded verification scope are listed in [the testing guide](docs/development/testing.md).

### Highlights

- Analyze selected JavaScript files and recover cross-bundle relationships without expanding the selected source scope.
- Read compact summaries and page retained Evidence across binary, managed, Android, Dart, WASM and network workflows.
- Inspect SQLite snapshots, packet and signal recordings, WebAssembly, Rust dependency metadata and Electron fuses offline.
- Keep completed Evidence and partial observations available when analysis or cleanup fails.

### Changes

- **JavaScript source selection:** analyze exact application paths without expanding imports into the selected scope. Unselected files retain identity and explicit unknown coverage; summary delivery remains separate from source selection. ([#1944](https://github.com/morluto/rea/pull/1944), [issue morluto/rea#1848](https://github.com/morluto/rea/issues/1848)). Thanks @kaoru0822-kitauji, @N0zoM1z0.
- **Code-split recovery:** recover related bundles from multiple selected inputs, retaining per-file provenance and downstream cross-chunk imports. Recorded CLI/MCP coverage is Linux x64 with Wakaru 1.14.0 and source-owned esbuild/webpack fixtures; other hosts, releases and arbitrary application equivalence remain unverified. ([#1686](https://github.com/morluto/rea/pull/1686), [issue morluto/rea#1605](https://github.com/morluto/rea/issues/1605)). Thanks @JingHao-Leon, @pionxzh.
- **Package imports:** resolve exact package import aliases using the selected loader and package ancestry, rather than guessing sibling files. ([#1862](https://github.com/morluto/rea/pull/1862), [issue morluto/rea#1838](https://github.com/morluto/rea/issues/1838)). Thanks @AWUQAQ, @mvanhorn.
- **Retained analysis views:** opt into compact inventory/WASM, managed metadata, Android manifest, Dart AOT, Mach-O and EVM summaries, then page retained Evidence without rerunning analysis. Summary delivery preserves the complete recorded result and its original coverage. ([#2122](https://github.com/morluto/rea/pull/2122), [#2193](https://github.com/morluto/rea/pull/2193), [#2413](https://github.com/morluto/rea/pull/2413), [#2438](https://github.com/morluto/rea/pull/2438), [#2455](https://github.com/morluto/rea/pull/2455), [#2634](https://github.com/morluto/rea/pull/2634), [#2308](https://github.com/morluto/rea/pull/2308), [9a18251](https://github.com/morluto/rea/commit/9a18251426f891e6a24856b715ef8002ab8b9610)). Thanks @kaoru0822-kitauji, @N0zoM1z0.
- **Managed assemblies:** Select declaring types when inspecting members, decode inspected `ldstr` literals with independent coverage, and page retained member summaries. Call and field targets expose `target_declaring_type` and `field_declaring_type`, including supported generic method targets; unresolved metadata remains unknown. ([#1706](https://github.com/morluto/rea/pull/1706), [#2125](https://github.com/morluto/rea/pull/2125), [issue morluto/rea#2121](https://github.com/morluto/rea/issues/2121), [#2162](https://github.com/morluto/rea/pull/2162), [issue morluto/rea#2158](https://github.com/morluto/rea/issues/2158), [#3061](https://github.com/morluto/rea/pull/3061), [issue morluto/rea#3010](https://github.com/morluto/rea/issues/3010), [#2163](https://github.com/morluto/rea/pull/2163), [issue morluto/rea#2160](https://github.com/morluto/rea/issues/2160)). Thanks @kaoru0822-kitauji, @N0zoM1z0, @Nelglor, @skoodster.
- **Packet captures:** inspect saved packets with bounded TShark output, compact capture summaries and retained pages; discover installed protocol/field definitions. Recorded real-engine coverage uses Linux and Wireshark 4.6.6; native Windows/macOS and Bun behavior remain unverified. ([#2318](https://github.com/morluto/rea/pull/2318), [#2340](https://github.com/morluto/rea/pull/2340), [#2496](https://github.com/morluto/rea/pull/2496)). Thanks @3QL, @N0zoM1z0, @Olorinm.
- **Recorded signals:** decode existing recordings and discover installed decoders/options through caller-supplied sigrok-cli 0.7.2. This is Linux-only and requires util-linux `prlimit`; it acquires no hardware samples. ([#2339](https://github.com/morluto/rea/pull/2339), [#2487](https://github.com/morluto/rea/pull/2487)). Thanks @N0zoM1z0, @Olorinm.
- **Web captures:** derive an inferred method/origin/path-template API surface from retained HAR data including observed query-parameter names while retaining unknowns; query values, headers and bodies remain excluded. ([#1891](https://github.com/morluto/rea/pull/1891), [#2982](https://github.com/morluto/rea/pull/2982), [issue morluto/rea#2913](https://github.com/morluto/rea/issues/2913)). Thanks @mvanhorn, @wunianze666-netizen, @zhangguiping-xydt.
- **QUIC captures:** inspect retained aioquic 1.5.0 JSON qlog 0.3 objects and page traces/streams/observations. Other qlog layouts remain unsupported; overlap and loss declarations do not prove retransmission or network loss. ([#2277](https://github.com/morluto/rea/pull/2277)). Thanks @LuisTaffelli, @N0zoM1z0.
- **Fiddler captures:** inspect native SAZ archives with retained HTTP provenance and bounded decoding. Recorded producer coverage is the pinned public encoding corpus; current Fiddler Everywhere variants and Bun-native execution remain unverified. ([#2409](https://github.com/morluto/rea/pull/2409)). Thanks @N0zoM1z0, @zahhak.
- **SQLite snapshots:** inspect an explicitly selected offline database with table/column selection and bounded Evidence. This operation requires Node 24.x >=24.15 or 26+ with `DatabaseSync.limits`; supported Node 22 and earlier 24 runtimes cannot use it. A live database/WAL copy does not establish an atomic snapshot. ([#2271](https://github.com/morluto/rea/pull/2271)). Thanks @N0zoM1z0, @Y0UW1SH.
- **WASM artifacts:** Inspect local modules with bring-your-own WABT 1.0.42 without executing them. Compare imports/exports from two complete core-module inspection Evidence records without requiring an active WABT installation; unsupported signatures and duplicate identities remain unknown, and comparisons do not establish runtime compatibility. Recorded real-tool inspection coverage is macOS arm64. ([#1533](https://github.com/morluto/rea/pull/1533), [issue morluto/rea#884](https://github.com/morluto/rea/issues/884), [#2464](https://github.com/morluto/rea/pull/2464), [issue morluto/rea#2356](https://github.com/morluto/rea/issues/2356)). Thanks @matbrgz, @N0zoM1z0, @thangldw.
- **Go binaries:** inspect embedded build metadata, including file-backed unmapped Mach-O debug segments. ([#1363](https://github.com/morluto/rea/pull/1363), [7fb097d](https://github.com/morluto/rea/commit/7fb097d72c9931dd5dfae481ad2b9d3bb6029f15)). Thanks @Y0UW1SH.
- **Flutter APKs:** identify snapshot/engine builds and inspect AOT structure without an external engine. Recorded real APK coverage uses the documented Flutter Gallery fixture; macOS/Windows and complete pool semantics remain unverified, and pool coverage stays partial. ([#1582](https://github.com/morluto/rea/pull/1582)). Thanks @3QL.
- **HarmonyOS packages:** inventory HAP/HSP/App Pack structures without executing code. The recorded real workflow covers one pinned HAP through repository-built CLI/MCP; installed-package and real HSP/App Pack coverage remain unverified. ([#1447](https://github.com/morluto/rea/pull/1447)). Thanks @BaaRai.
- **Ghidra raw inputs and references:** compatible Linux/macOS Ghidra profiles accept caller-selected raw architecture/entry information and expose typed incoming references at exact addresses. Windows Ghidra P0 admits the raw NMOS 6502 profile described below; other raw targets and the incoming-reference facet remain outside Windows P0. ([#1868](https://github.com/morluto/rea/pull/1868), [issue morluto/rea#1836](https://github.com/morluto/rea/issues/1836), [#1715](https://github.com/morluto/rea/pull/1715), [issue morluto/rea#1245](https://github.com/morluto/rea/issues/1245)). Thanks @bugstan, @casesolved-co-uk, @mvanhorn, @N0zoM1z0.
- **Ghidra MIPS:** Add bounded MIPS32r2/o32 relocatable objects, soft-float integer-register storage, admitted MIPS16 shared ELF, and a narrowly admitted recordless legacy MIPS32 executable profile. The latter pins an endian-matched 32-bit language and records inferred o32 as an analysis assumption. Admission follows each documented ABI/flag/relocation boundary. ([#1949](https://github.com/morluto/rea/pull/1949), [issue morluto/rea#1937](https://github.com/morluto/rea/issues/1937), [#1950](https://github.com/morluto/rea/pull/1950), [issue morluto/rea#1938](https://github.com/morluto/rea/issues/1938), [#1991](https://github.com/morluto/rea/pull/1991), [issue morluto/rea#1851](https://github.com/morluto/rea/issues/1851), [#1898](https://github.com/morluto/rea/pull/1898), [issue morluto/rea#1620](https://github.com/morluto/rea/issues/1620)). Thanks @AurelioB, @BaaRai, @bqw371, @kaoru0822-kitauji, @N0zoM1z0.
- **Ghidra RISC-V:** admit little-endian RV32/RV64 `ET_EXEC` ELF declaring the supported double-float ABI. Relocatable/shared, big-endian and other ABI profiles remain refused; see [the profile and recorded lane](docs/providers/ghidra-riscv.md). ([#2151](https://github.com/morluto/rea/pull/2151)). Thanks @NIU-123370.
- **PSP static ELF profile:** the Ghidra profile is Linux x64, bounded little-endian ELF32 `ET_EXEC` with the documented PSP/ABI declarations and a compatible caller-installed Allegrex extension. PRX, shared/relocatable images, PBP/ISO/CSO and runtime emulation are outside scope. Historical extension experiments are separate from public-provider verification; real public Ghidra PSP coverage remains unverified. ([#1599](https://github.com/morluto/rea/pull/1599)). Thanks @jaelliot.
- **Ghidra analysis settings:** apply validated analyzer overrides before analysis while retaining the selected analysis profile. ([#1913](https://github.com/morluto/rea/pull/1913)). Thanks @akushonkamen, @kaoru0822-kitauji, @N0zoM1z0.
- **Attached native IDA MCP:** add an optional native bridge alongside existing legacy/headless profiles. Recorded native runs use Linux IDA Free 9.4 with a navigation correction and Windows IDA Pro 9.3 with a loopback-listener change; stock native switching, native macOS and Windows IDA Free remain unverified. Attached databases remain read-only and are never saved or closed. ([#1544](https://github.com/morluto/rea/pull/1544)). Thanks @imissapixel, @N0zoM1z0.
- **Frida instrumentation:** add explicit local/remote target selection, caller-supplied scripts and retained messages, with script-read/input diagnostics and bounded message eviction. Recorded real coverage is the Linux local Node marker workflow; macOS, Windows and remote devices/servers remain unverified. Instrumentation executes foreign code and is destructive, not read-only. ([#1359](https://github.com/morluto/rea/pull/1359), [#2211](https://github.com/morluto/rea/pull/2211), [issue morluto/rea#2209](https://github.com/morluto/rea/issues/2209), [#2217](https://github.com/morluto/rea/pull/2217), [issue morluto/rea#2213](https://github.com/morluto/rea/issues/2213), [#2628](https://github.com/morluto/rea/pull/2628)). Thanks @dandgabr, @kaoru0822-kitauji, @N0zoM1z0.
- **Client setup:** register Qoder, Trae, ZCode, DeepSeek Harness, Kimi Code, Factory Droid and WorkBuddy through the existing scoped setup flow. DeepSeek is included from 6.5.0; the historical npm 6.4 check did not cover it. Live Trae and DeepSeek API integration remain unverified. ([#1564](https://github.com/morluto/rea/pull/1564), [#1572](https://github.com/morluto/rea/pull/1572), [#1573](https://github.com/morluto/rea/pull/1573), [#1929](https://github.com/morluto/rea/pull/1929), [issue morluto/rea#1839](https://github.com/morluto/rea/issues/1839), [#2744](https://github.com/morluto/rea/pull/2744), [#2309](https://github.com/morluto/rea/pull/2309), [#3041](https://github.com/morluto/rea/pull/3041), [issue morluto/rea#3040](https://github.com/morluto/rea/issues/3040)). Thanks @0xRafie, @BaaRai, @cainiao1992, @IvenKooLab, @whoishaha, @ysntony.
- **Website:** Add maintained language editions, persistent/system-aware themes, keyboard styling and nested Evidence indentation, plus the reverse-engineering models essay. A simpler home page and beginner journey connect platform prerequisites, client/provider setup and a supplied first investigation. ([#1779](https://github.com/morluto/rea/pull/1779), [issue morluto/rea#1022](https://github.com/morluto/rea/issues/1022), [#1699](https://github.com/morluto/rea/pull/1699), [#1714](https://github.com/morluto/rea/pull/1714), [#1894](https://github.com/morluto/rea/pull/1894), [#2250](https://github.com/morluto/rea/pull/2250), [#2432](https://github.com/morluto/rea/pull/2432), [#2732](https://github.com/morluto/rea/pull/2732), [#3274](https://github.com/morluto/rea/pull/3274)). Thanks @CassieFox23, @kaoru0822-kitauji, @N0zoM1z0.

- **Rust dependency metadata:** Inspect embedded cargo-auditable package/dependency records in ELF, PE and thin Mach-O without executing the file. Missing metadata and inferred compiler hashes retain explicit limitations; universal Mach-O requires a selected thin slice. ([#2456](https://github.com/morluto/rea/pull/2456)). Thanks @mvanhorn.
- **Electron fuses:** Read packaged fuse bytes and per-slice runtime implications without launching or modifying the app. Missing, truncated and unknown wires remain explicit; fuse observations do not prove other Inspector-enablement paths. ([#2399](https://github.com/morluto/rea/pull/2399)). Thanks @kaoru0822-kitauji, @mvanhorn, @N0zoM1z0.
- **Ghidra PowerPC:** Admit bounded ELF32 big-endian `ET_EXEC` PowerPC with an explicit language profile on supported Linux/macOS hosts. PPC64, DOL and other variants remain outside this lane; see [the profile and verification prerequisites](docs/ghidra-ppc.md). ([#1747](https://github.com/morluto/rea/pull/1747)). Thanks @arielfikru.

- **Reference-source summaries:** Use CLI `import-reference-source --detail summary` for compact manifest, count, state and path-outline output. The complete graph remains available and is still the default; hidden outline entries retain separate coverage counts. ([#2768](https://github.com/morluto/rea/pull/2768), [issue morluto/rea#2442](https://github.com/morluto/rea/issues/2442)). Thanks @matbrgz, @To3akaRin.

- **Recorded AArch64 crashes:** Decode 34 ABI register values per thread from supported Linux ELF64 little-endian core notes using the documented caller-provided Python dependencies. These are recorded facts, not proof of current process or library identity. ([#2505](https://github.com/morluto/rea/pull/2505), [issue morluto/rea#2353](https://github.com/morluto/rea/issues/2353)). Thanks @matbrgz, @NIU-123370.

- **Ghidra byte search:** Search initialized analyzed memory using wildcards, bit masks, address bounds and paged results. Unloaded, overlay and uninitialized blocks retain skipped coverage; this is not a raw-file search. ([#2341](https://github.com/morluto/rea/pull/2341)). Thanks @mvanhorn.

- **Raw NMOS 6502 images:** Analyze explicitly selected headerless images with Ghidra, including Windows P0, using a caller-selected entry and source mapping within the 16-bit address space. Cartridge parsing, reset-vector inference and 65C02/65816 are outside this profile. ([#2079](https://github.com/morluto/rea/pull/2079)). Thanks @Zhong-fan.

- **Swift String observations:** Ghidra function dossiers derive supported AArch64 Swift String literals from constant-register pairs at recognized use sites, retaining instruction/register provenance and explicit omissions. This is a bounded derivation, not a complete string inventory. ([#2049](https://github.com/morluto/rea/pull/2049), [issue morluto/rea#2030](https://github.com/morluto/rea/issues/2030)). Thanks @thefolahan.

- **Headless IDA procedure lookup:** Resolve addresses to canonical containing-procedure entries and identify the session’s admitted program document in the modern headless profile. Incomplete surveys remain errors; attached profiles do not advertise this containment capability. ([#2374](https://github.com/morluto/rea/pull/2374), [issue morluto/rea#2335](https://github.com/morluto/rea/issues/2335)). Thanks @nikolay-dementiev.

- **Passive browser attachment:** Six existing passive browser tools accept an explicit-port loopback browser WebSocket endpoint when HTTP target discovery is unavailable. Existing consent and target/origin checks remain required; this does not launch a browser or enable runtime instrumentation. ([#2346](https://github.com/morluto/rea/pull/2346)). Thanks @all-black-493.

- **Android DEX references:** Retain exact method descriptors and individual direct-invoke observations with source method, DEX entry, opcode and code-unit offset. These are static references; unavailable instruction facts remain separate from method-level usage totals. ([#2439](https://github.com/morluto/rea/pull/2439)). Thanks @LcokHcak.

- **Offline EVM metadata:** Retain bounded, lossless facts from plausible terminal Solidity CBOR root-map candidates. Candidates do not prove Solidity origin or source/compiler identity, and linked metadata is not fetched. ([#2790](https://github.com/morluto/rea/pull/2790)). Thanks @matbrgz.

### Fixes

- **JavaScript loader and export identity:** Respect import/require conditions and unavailable package metadata, keep export links separate from writes, and resolve default identifier exports to the value captured at the export statement. ([7e5cffa](https://github.com/morluto/rea/commit/7e5cffa2ae9dfc9afaeca0715110d4dd41c0dcdd), [322506d](https://github.com/morluto/rea/commit/322506d0c0d39d3cd1e2e1c285c2cc23cfa73ee7), [81f7638](https://github.com/morluto/rea/commit/81f763820319a762f003cf95651ed14ce9326a4c), [dae1e55](https://github.com/morluto/rea/commit/dae1e55381f0d6cfee7f2082d5d27b938e55704c)). Thanks @paoValle, @VarunGore36, @xu91102.
- **JavaScript traces:** Retain nested bridge calls and surviving early-return predicates. Honor node-ID match options, match route seeds against source values, and keep ambiguous runtime candidates unknown. ([0351328](https://github.com/morluto/rea/commit/0351328e54ce70ea3f2814482e76b132774aff48), [5031099](https://github.com/morluto/rea/commit/503109995f9dcf8a955585d39a344fc846d2f59e), [44c9d29](https://github.com/morluto/rea/commit/44c9d2924d5b95d7a86595e8d7b7cf4fd4f0f6ac), [5e79d46](https://github.com/morluto/rea/commit/5e79d468e5864204cbe79a7ca2898541cee5e012)). Thanks @jpdefo.
- **Browser comparison coverage:** Compare only known redirect response fields and retain network-selection recovery guidance alongside independent event changes. Missing response facts do not prove equality or a change. ([2b60e09](https://github.com/morluto/rea/commit/2b60e097f281f7708c69f1f7ba9263694547bcc0)).
- **Evidence comparison and ledger input:** Report display-only bundle differences as unchanged while retaining digests, and classify noncanonical bundle records as invalid caller input. ([030c477](https://github.com/morluto/rea/commit/030c47732833c9cedcc31db1309eb3a1ca2c62e8), [3a34ad3](https://github.com/morluto/rea/commit/3a34ad37bdb7b8debba0f6515ba85b80141f2716)).
- **Capture and admission cleanup:** Keep deleted-file observations and original bytes when a parent becomes a file, preserve unrelated I/O failures during cancellation, and require explicit pre-launch proof before releasing an unknown LLDB target owner. LLDB failure controls used simulated boundaries. ([e67c364](https://github.com/morluto/rea/commit/e67c3642c8920a2a9c0e231ee2f16f50b245df31), [2daeff4](https://github.com/morluto/rea/commit/2daeff4b243e1cd137c591ca394e18a1c05c8bbc), [45b6a7f](https://github.com/morluto/rea/commit/45b6a7fe8f51a89951aaa823ffa627f6f5453a33)). Thanks @SII-YDD, @xu91102.
- **Client configuration:** Validate MCP output-schema profiles before setup writes, ignore untrusted Gemini workspace settings before parsing them, and identify installed skills independently of marker-only client roots. ([0930e94](https://github.com/morluto/rea/commit/0930e94e077ab7fb4d695f62785919a8a25c2e21), [aade9bb](https://github.com/morluto/rea/commit/aade9bbcb79aa8504ab6921b25f8ab082aba78e7), [ba33c70](https://github.com/morluto/rea/commit/ba33c706d26b63e43308be50c0249c72cff62cc6)). Thanks @CmsChase, @paoValle, @sx4im.
- **Host tool discovery:** Share macOS Hopper launcher discovery across setup and runtime, preserve explicit paths, and report validated ADB and Apktool availability. ([7582f0d](https://github.com/morluto/rea/commit/7582f0dff29ae0e80c97b885ddd386ac61a92570), [e5deb83](https://github.com/morluto/rea/commit/e5deb832cb09bb524877d0df40f49d5b5bb7dea4)). Thanks @Chessing234, @kaoru0822-kitauji, @viniciusdsandrade.
- **SAZ encoding validation:** Reject invalid XML bytes, unsupported encodings and declarations that contradict the archive bytes, including records outside the selected request. ([1250aae](https://github.com/morluto/rea/commit/1250aaedd8b4d1e471d8a382f76418bde65c05d2)).
- **Managed member matching:** Keep malformed TypeDef list ownership unknown, distinguish constants during structural method matching, and accept legacy small exception-section sizes. ([3f6b575](https://github.com/morluto/rea/commit/3f6b5755b3e699bd9373641acffe0f2c5d2ab094), [ee5cfbe](https://github.com/morluto/rea/commit/ee5cfbe05cd309a88003c711721e67a3bee36554)).
- **Bounded diagnostics:** Bound SDK validation messages and terminal normalization before allocation while retaining diagnostics and explicit unknown final output sizes. ([7fb0a0c](https://github.com/morluto/rea/commit/7fb0a0cc577f7c9033a2674d877d8242b5864556), [1d826f3](https://github.com/morluto/rea/commit/1d826f304f032acfe69dad3ff824b300aacaeb43)). Thanks @CRYPTONIKAV.

- **Windows artifact classification:** identify `.exe`, `.com`, `.bat` and `.cmd` artifacts as launchable host executables. ([#1823](https://github.com/morluto/rea/pull/1823), [#1824](https://github.com/morluto/rea/pull/1824), [issue morluto/rea#1819](https://github.com/morluto/rea/issues/1819)). Thanks @dollarsmoney, @JasonBuildAI, @kaoru0822-kitauji.

- **CLI/MCP delivery:** defer command-specific startup work, bundle runtime entries, retain field/input correction details across output formats and preserve shared optional-provider lifetime. MCP selectors, paging continuation and retained partial-error references remain explicit; session liveness/provider-attribution corrections retain their controlled-provider verification limits. ([#1691](https://github.com/morluto/rea/pull/1691), [issue morluto/rea#1685](https://github.com/morluto/rea/issues/1685), [#1705](https://github.com/morluto/rea/pull/1705), [issue morluto/rea#1695](https://github.com/morluto/rea/issues/1695), [#1755](https://github.com/morluto/rea/pull/1755), [issue morluto/rea#1746](https://github.com/morluto/rea/issues/1746), [#1773](https://github.com/morluto/rea/pull/1773), [issue morluto/rea#1771](https://github.com/morluto/rea/issues/1771), [#1780](https://github.com/morluto/rea/pull/1780), [#1814](https://github.com/morluto/rea/pull/1814), [#1910](https://github.com/morluto/rea/pull/1910), [issue morluto/rea#1849](https://github.com/morluto/rea/issues/1849), [#1996](https://github.com/morluto/rea/pull/1996), [#2140](https://github.com/morluto/rea/pull/2140), [issue morluto/rea#2135](https://github.com/morluto/rea/issues/2135), [#2205](https://github.com/morluto/rea/pull/2205), [issue morluto/rea#2195](https://github.com/morluto/rea/issues/2195), [#2230](https://github.com/morluto/rea/pull/2230), [issue morluto/rea#2180](https://github.com/morluto/rea/issues/2180), [#2294](https://github.com/morluto/rea/pull/2294), [#2482](https://github.com/morluto/rea/pull/2482), [a82d14e](https://github.com/morluto/rea/commit/a82d14e4db4dca989ffa2e7dbe78fd43551da256), [a4dd4e8](https://github.com/morluto/rea/commit/a4dd4e8e8700ce350e1a0c612ebd61b91ca5e585), [48c352b](https://github.com/morluto/rea/commit/48c352b6bfa34c820a530272cd36600158c37b1e), [07b36c1](https://github.com/morluto/rea/commit/07b36c148946f46b99a4ce04e55726e97d0ee03a), [570c40c](https://github.com/morluto/rea/commit/570c40cde55d31e455ef9bc484b7b908658ded58), [8fc2043](https://github.com/morluto/rea/commit/8fc2043eb8bcedbf34dce064f977e455438635d6), [7fc0b5e](https://github.com/morluto/rea/commit/7fc0b5ec9c2532bbf789d7783b7a0cab6fc054d8)). Thanks @369Apps, @chqcjq, @cold-atom, @coygeek, @JackOdegard, @kaoru0822-kitauji, @N0zoM1z0, @sx4im.
- **Evidence import/replay:** import bundles across session transitions while authenticating selected target and file identities, preserve literal keys, metadata/mutation intent and relationship coverage, and honor cancellation before session mutation. Reuse authenticated snapshots and comparisons within their owned lifetime; reject malformed/non-object snapshots and unsupported metadata without disguising uncertainty. ([#1694](https://github.com/morluto/rea/pull/1694), [#1716](https://github.com/morluto/rea/pull/1716), [issue morluto/rea#1680](https://github.com/morluto/rea/issues/1680), [#1721](https://github.com/morluto/rea/pull/1721), [issue morluto/rea#1718](https://github.com/morluto/rea/issues/1718), [#1733](https://github.com/morluto/rea/pull/1733), [issue morluto/rea#1723](https://github.com/morluto/rea/issues/1723), [issue morluto/rea#1724](https://github.com/morluto/rea/issues/1724), [#1776](https://github.com/morluto/rea/pull/1776), [#1873](https://github.com/morluto/rea/pull/1873), [#2001](https://github.com/morluto/rea/pull/2001), [#2013](https://github.com/morluto/rea/pull/2013), [issue morluto/rea#2009](https://github.com/morluto/rea/issues/2009), [#2083](https://github.com/morluto/rea/pull/2083), [#2303](https://github.com/morluto/rea/pull/2303), [#2685](https://github.com/morluto/rea/pull/2685), [issue morluto/rea#2675](https://github.com/morluto/rea/issues/2675), [c002b89](https://github.com/morluto/rea/commit/c002b89e2d8130a3c07e25e5fd604876be18c703), [9c85114](https://github.com/morluto/rea/commit/9c8511409c0706f9979c2b68dd56aaaf9f21e191), [aada0ca](https://github.com/morluto/rea/commit/aada0ca8126bf14c60750a4ccd4a79667770a1e4), [4a4d36f](https://github.com/morluto/rea/commit/4a4d36f881861bbab3c734b0dd459f805766caec), [1c64fe3](https://github.com/morluto/rea/commit/1c64fe3eff48679c6880f42d2f0a4af46686ade7), [6fb3a34](https://github.com/morluto/rea/commit/6fb3a345fe952b8e8f59221aec993acc37ccbf31), [3bcc68c](https://github.com/morluto/rea/commit/3bcc68c037e9415c78093cb286069c1fcca6a2f8), [6bae774](https://github.com/morluto/rea/commit/6bae774328724403255590aa2ddad4d7a2aa727f), [e997085](https://github.com/morluto/rea/commit/e9970855ba16ba711816ac30212c5ca17ae085cd), [d1dcebc](https://github.com/morluto/rea/commit/d1dcebce2c0820469ed63e33497a14258971b710), [b123b2e](https://github.com/morluto/rea/commit/b123b2e51cc7d6d2157525664be2df88fb1ba3bd), [049132a](https://github.com/morluto/rea/commit/049132ab43fa962d31774f2b258c15a71217148b), [042dcaa](https://github.com/morluto/rea/commit/042dcaa1ee66f1b8668f08b193f38ab01bceaacb), [acf75e6](https://github.com/morluto/rea/commit/acf75e6700ace28bb1db25e54e56673ac15e0ed3), [1f7f808](https://github.com/morluto/rea/commit/1f7f808c4f3bb5eca6b13bcc71d5cceb2ace6614), [26bffb9](https://github.com/morluto/rea/commit/26bffb94bf80355c35e22a98a8fc629c6210307e)). Thanks @coygeek, @DeryFerd, @jiangjiang248, @kaoru0822-kitauji, @khanukov, @N0zoM1z0, @NIU-123370, @rohitg00, @sx4im.
- **Ghidra setup and analysis:** preserve launcher/JVM diagnostics, Java-property and extension identity, stale-client recovery, UTF-8 bridge output and pending-startup progress. File-offset decompilation is Ghidra-specific; recorded coverage is Linux x64 with Ghidra 12.1.4. Startup/progress/compiler failure paths that use simulations remain unverified with a real engine. ([#1698](https://github.com/morluto/rea/pull/1698), [#1877](https://github.com/morluto/rea/pull/1877), [#1931](https://github.com/morluto/rea/pull/1931), [#2011](https://github.com/morluto/rea/pull/2011), [issue morluto/rea#1992](https://github.com/morluto/rea/issues/1992), [#2014](https://github.com/morluto/rea/pull/2014), [#2101](https://github.com/morluto/rea/pull/2101), [issue morluto/rea#2078](https://github.com/morluto/rea/issues/2078), [#2206](https://github.com/morluto/rea/pull/2206), [issue morluto/rea#2204](https://github.com/morluto/rea/issues/2204), [2187e16](https://github.com/morluto/rea/commit/2187e16f149a7a7b512a4cb45d5f468cc04091fe), [b953f96](https://github.com/morluto/rea/commit/b953f96c0aae27e1876c317a8f7db1d6f292b8ff)). Thanks @EDMND-SRC, @Ha1baraA11, @kaoru0822-kitauji, @lovecontroing, @lyly-bonbon, @N0zoM1z0, @nosmile99, @Petru101, @sx4im, @Zhong-fan.
- **Process and cleanup ownership:** retain private runtime/file owners and detailed incomplete-cleanup observations, bound trace cycles/order state, preserve caller paths, and use monotonic time for budgets while retaining wall dates. Windows affinity/admission ([#2202](https://github.com/morluto/rea/pull/2202), [issue morluto/rea#2181](https://github.com/morluto/rea/issues/2181)) and Bun memory-enforcement paths retain their recorded native-versus-controlled-fixture limits; these fixes are not a general process-ownership guarantee. ([#1700](https://github.com/morluto/rea/pull/1700), [issue morluto/rea#1697](https://github.com/morluto/rea/issues/1697), [#1730](https://github.com/morluto/rea/pull/1730), [#1756](https://github.com/morluto/rea/pull/1756), [issue morluto/rea#1753](https://github.com/morluto/rea/issues/1753), [#1760](https://github.com/morluto/rea/pull/1760), [issue morluto/rea#1757](https://github.com/morluto/rea/issues/1757), [#1826](https://github.com/morluto/rea/pull/1826), [#1907](https://github.com/morluto/rea/pull/1907), [issue morluto/rea#1856](https://github.com/morluto/rea/issues/1856), [#1999](https://github.com/morluto/rea/pull/1999), [issue morluto/rea#1993](https://github.com/morluto/rea/issues/1993), [#2232](https://github.com/morluto/rea/pull/2232), [issue morluto/rea#2170](https://github.com/morluto/rea/issues/2170), [#2252](https://github.com/morluto/rea/pull/2252), [issue morluto/rea#2218](https://github.com/morluto/rea/issues/2218), [#2467](https://github.com/morluto/rea/pull/2467), [issue morluto/rea#2257](https://github.com/morluto/rea/issues/2257), [#2468](https://github.com/morluto/rea/pull/2468), [#2488](https://github.com/morluto/rea/pull/2488), [09b6828](https://github.com/morluto/rea/commit/09b68285166bef2b7633402c8adf7eb25823b47e), [7285e15](https://github.com/morluto/rea/commit/7285e15839a4fecf9940683699b781a60ccc4775), [b5ededd](https://github.com/morluto/rea/commit/b5ededd0f9c28d0f696a205103066928117368ee), [d8c76b6](https://github.com/morluto/rea/commit/d8c76b629639bda4405afa9ae2f7676b694f2f10), [98d8470](https://github.com/morluto/rea/commit/98d8470d36cfbf7cd25820a4ed430aebae20c0c5), [c22111e](https://github.com/morluto/rea/commit/c22111eca2c4bc84a084f12711f405b3e7422a40), [cecc6ec](https://github.com/morluto/rea/commit/cecc6ecbffe84689a173d1634f342e046b0c8ceb), [10935b7](https://github.com/morluto/rea/commit/10935b7b1136accab2a43b308ab380749da0f7ae), [63e796d](https://github.com/morluto/rea/commit/63e796d50ea323ae8dcfef80f86c8154bb106790), [d9e9fb2](https://github.com/morluto/rea/commit/d9e9fb2273543caab4eb21d896c33d462ada6971), [9049dba](https://github.com/morluto/rea/commit/9049dbaf0c3df32357419f9899965df2b611f493), [ed881c6](https://github.com/morluto/rea/commit/ed881c6d2ef6a8adba0c2a241ebc9ab4603b7868)). Thanks @Ashen00001, @charan-rathore, @coygeek, @EDMND-SRC, @JasonBuildAI, @jimpablo, @kaoru0822-kitauji, @N0zoM1z0, @NIU-123370, @Rinkia, @rudycelekli, @sx4im, @xeropresence, @XiaoBinGan, @xthunder0, @hzh666kevin-hue.
- **Native image identity:** preserve universal Mach-O containers and selected slice/subtype identity, chained fixup locations and library ordinals, exact signing text, PE resource capacity and ELF/header framing. Mach-O summary selection and independent slice commands avoid unnecessary delivery/work. Controlled routing/parser fixtures do not establish every installed-provider path. ([#1703](https://github.com/morluto/rea/pull/1703), [issue morluto/rea#1702](https://github.com/morluto/rea/issues/1702), [#1708](https://github.com/morluto/rea/pull/1708), [#1709](https://github.com/morluto/rea/pull/1709), [#1713](https://github.com/morluto/rea/pull/1713), [#1772](https://github.com/morluto/rea/pull/1772), [issue morluto/rea#1765](https://github.com/morluto/rea/issues/1765), [#1784](https://github.com/morluto/rea/pull/1784), [issue morluto/rea#1775](https://github.com/morluto/rea/issues/1775), [#1982](https://github.com/morluto/rea/pull/1982), [#1995](https://github.com/morluto/rea/pull/1995), [issue morluto/rea#1990](https://github.com/morluto/rea/issues/1990), [#2040](https://github.com/morluto/rea/pull/2040), [#2107](https://github.com/morluto/rea/pull/2107), [#2161](https://github.com/morluto/rea/pull/2161), [issue morluto/rea#2105](https://github.com/morluto/rea/issues/2105), [#2248](https://github.com/morluto/rea/pull/2248), [issue morluto/rea#2176](https://github.com/morluto/rea/issues/2176), [#2281](https://github.com/morluto/rea/pull/2281), [issue morluto/rea#2274](https://github.com/morluto/rea/issues/2274), [#2292](https://github.com/morluto/rea/pull/2292), [#2466](https://github.com/morluto/rea/pull/2466), [#2506](https://github.com/morluto/rea/pull/2506), [#2733](https://github.com/morluto/rea/pull/2733), [issue morluto/rea#2661](https://github.com/morluto/rea/issues/2661), [f598bab](https://github.com/morluto/rea/commit/f598bab488e38c378d69346fa3c106f9e18529ed), [108b5f9](https://github.com/morluto/rea/commit/108b5f94254281639badd25b1f448cca35dc89a2), [f1924cf](https://github.com/morluto/rea/commit/f1924cf9c1910d5d29d11e7bf634b51af8d738cf), [8bd5ba2](https://github.com/morluto/rea/commit/8bd5ba2d234cbd9a5bb9dd5daeaa191c3a1cad24), [b38429c](https://github.com/morluto/rea/commit/b38429cb6a0de8f4bb5ae01633e24abe2d7cde46), [8d4d631](https://github.com/morluto/rea/commit/8d4d631606c701aac150cf009d3b80ae4a7ae7d5), [ac57c88](https://github.com/morluto/rea/commit/ac57c88efe64c3125850b54d3d833227e6b8ec51), [dc038d1](https://github.com/morluto/rea/commit/dc038d16bba9046afd28970de9c47f6259a43524), [34a4bb6](https://github.com/morluto/rea/commit/34a4bb6508006fa113463ef20ed799a2994e9ee8), [ebc22d9](https://github.com/morluto/rea/commit/ebc22d99d62225505c0a84f6e39823ba4ef2f829), [c02fb0e](https://github.com/morluto/rea/commit/c02fb0ea8055f98def2b12ad557aed0faefd3639)). Thanks @1NormalGuy, @Aliciawque, @baron, @coygeek, @dhl84, @hemanthrayuduu, @JasonBuildAI, @kaoru0822-kitauji, @N0zoM1z0, @thangldw, @viniciusdsandrade, @XiaoBinGan, @Zburgers.
- **Archive and artifact provenance:** keep physical ZIP occurrence identity, exact signatures/names and partial inventory coverage; bound decompression and reject malformed keys/integers. Directory/ASAR/DMG reads retain ownership through cleanup and publication cancellation. Duplicate ZIP names remain explicitly ambiguous where the public projection cannot represent them; synthetic archive/cleanup cases do not prove every real Unblob or DMG failure path. ([#1726](https://github.com/morluto/rea/pull/1726), [issue morluto/rea#1725](https://github.com/morluto/rea/issues/1725), [#1854](https://github.com/morluto/rea/pull/1854), [issue morluto/rea#1844](https://github.com/morluto/rea/issues/1844), [#1865](https://github.com/morluto/rea/pull/1865), [issue morluto/rea#1860](https://github.com/morluto/rea/issues/1860), [#2069](https://github.com/morluto/rea/pull/2069), [#2106](https://github.com/morluto/rea/pull/2106), [#2144](https://github.com/morluto/rea/pull/2144), [#2365](https://github.com/morluto/rea/pull/2365), [#2493](https://github.com/morluto/rea/pull/2493), [918713a](https://github.com/morluto/rea/commit/918713af376e307ecf24d75e6a0dd9d1b544545b), [eb97da3](https://github.com/morluto/rea/commit/eb97da33881e3d1472d97a7d788ee35944fb6b07), [2260887](https://github.com/morluto/rea/commit/2260887f2092be6a3d9c79509e4ae4a3e52fce7f), [74d7da6](https://github.com/morluto/rea/commit/74d7da6ced0f869936ee0316b00616931b088066), [ed485a3](https://github.com/morluto/rea/commit/ed485a3dc8cc3a4baf8cabe01acb7aa0490b73b3), [921bb95](https://github.com/morluto/rea/commit/921bb9575505065f6cfd57b14d97d80d0f238546), [d8ceb3f](https://github.com/morluto/rea/commit/d8ceb3f276a65c181b146f68c0729ff4b6f9fa61), [9435c7a](https://github.com/morluto/rea/commit/9435c7aae279ba184937c0dfeb713fd574ba3f29), [bb54082](https://github.com/morluto/rea/commit/bb540826d65316c164d2de8ba4ef10f81a8ad073), [a73a55f](https://github.com/morluto/rea/commit/a73a55f53cc2b2e5b7618effe6ecb5cee6e0cee2), [3c57e1a](https://github.com/morluto/rea/commit/3c57e1a8b21b379fca55032d177078e1d8426e64), [ec0b081](https://github.com/morluto/rea/commit/ec0b081371f118e6e5e042fbef3479359c672ddb), [e7882b3](https://github.com/morluto/rea/commit/e7882b34f4ac4a26f903c5f49264acc2c19bb562), [b955b82](https://github.com/morluto/rea/commit/b955b825fc002a4bb408f2910b78768c566c2cd1)). Thanks @1052326311, @1NormalGuy, @baron, @Bortlesboat, @Chaoqi31, @DeryFerd, @kaoru0822-kitauji, @N0zoM1z0, @XiaoBinGan.
- **Setup/uninstall recovery:** preserve unrelated YAML text, caller-selected roots, symlinked data and existing recovery snapshots; explain malformed configuration shapes and retain failed rollback/cleanup owners. Show terminal dry-run plans and each selected skill location. Bunx registration and fault-injected recovery cases remain simulated rather than live-client verification. ([#1731](https://github.com/morluto/rea/pull/1731), [#1754](https://github.com/morluto/rea/pull/1754), [#1821](https://github.com/morluto/rea/pull/1821), [issue morluto/rea#1816](https://github.com/morluto/rea/issues/1816), [#1983](https://github.com/morluto/rea/pull/1983), [#2118](https://github.com/morluto/rea/pull/2118), [issue morluto/rea#2111](https://github.com/morluto/rea/issues/2111), [#2154](https://github.com/morluto/rea/pull/2154), [issue morluto/rea#2152](https://github.com/morluto/rea/issues/2152), [#2157](https://github.com/morluto/rea/pull/2157), [#2182](https://github.com/morluto/rea/pull/2182), [issue morluto/rea#2159](https://github.com/morluto/rea/issues/2159), [#2481](https://github.com/morluto/rea/pull/2481), [bb50813](https://github.com/morluto/rea/commit/bb508134efbba392a404b651d6ec05be8b7eac1e), [c240768](https://github.com/morluto/rea/commit/c2407689cb04df082e8db0b6afa8f8d022f6bcd1), [dcfc5d4](https://github.com/morluto/rea/commit/dcfc5d403ac997c2b08bee4753e57a1a4a8a8538), [21eff3b](https://github.com/morluto/rea/commit/21eff3bae10f58711a35ad44f86e9f96f9bb4790), [94153f1](https://github.com/morluto/rea/commit/94153f1c757e07a6d092e00903aa8b125d4a0afa), [2397137](https://github.com/morluto/rea/commit/23971376158e7815edcbe6c04a8df7c9504650dc), [c339f9e](https://github.com/morluto/rea/commit/c339f9ebe7bd1f30608d6ccb7175da523dd3c485), [f6775a3](https://github.com/morluto/rea/commit/f6775a36694a6a9c620f4248638e8056a6cbcb66)). Thanks @BeqaKs, @Jax367, @kaoru0822-kitauji, @NIU-123370, @shoyann, @viniciusdsandrade, @xeropresence, @zaydiscold.
- **Bun updates:** locate global installations before changing directories and reuse parsed client activation during maintenance. The update flow is covered with package-manager/filesystem simulations; a real Bun global installation update remains unverified. ([#1735](https://github.com/morluto/rea/pull/1735), [e90acae](https://github.com/morluto/rea/commit/e90acaea674f5f7f9f17ea472104afdc1422ada6), [b045df1](https://github.com/morluto/rea/commit/b045df100e1489e08a36d6ff04cea7feecf1332c)). Thanks @xeropresence.
- **JavaScript relationships:** preserve loader-specific package/TypeScript/CommonJS boundaries, exact file-URL and source-map identity, Electron intrinsic receivers/IPC guards and chunk metadata. Index repeated lookups and retain completed facts through resource limits and cancellation. Real Electron integration, Bun worker integration and failure-path cleanup remain unverified where the recorded lanes use fixtures. ([#1740](https://github.com/morluto/rea/pull/1740), [#1759](https://github.com/morluto/rea/pull/1759), [issue morluto/rea#1748](https://github.com/morluto/rea/issues/1748), [#1762](https://github.com/morluto/rea/pull/1762), [issue morluto/rea#1761](https://github.com/morluto/rea/issues/1761), [#1767](https://github.com/morluto/rea/pull/1767), [#1788](https://github.com/morluto/rea/pull/1788), [issue morluto/rea#1781](https://github.com/morluto/rea/issues/1781), [issue morluto/rea#1782](https://github.com/morluto/rea/issues/1782), [#1789](https://github.com/morluto/rea/pull/1789), [#1799](https://github.com/morluto/rea/pull/1799), [issue morluto/rea#1793](https://github.com/morluto/rea/issues/1793), [#1827](https://github.com/morluto/rea/pull/1827), [issue morluto/rea#1802](https://github.com/morluto/rea/issues/1802), [#1833](https://github.com/morluto/rea/pull/1833), [issue morluto/rea#1831](https://github.com/morluto/rea/issues/1831), [#1857](https://github.com/morluto/rea/pull/1857), [issue morluto/rea#1842](https://github.com/morluto/rea/issues/1842), [#1871](https://github.com/morluto/rea/pull/1871), [#1874](https://github.com/morluto/rea/pull/1874), [#1905](https://github.com/morluto/rea/pull/1905), [#1912](https://github.com/morluto/rea/pull/1912), [issue morluto/rea#1909](https://github.com/morluto/rea/issues/1909), [#1915](https://github.com/morluto/rea/pull/1915), [issue morluto/rea#1911](https://github.com/morluto/rea/issues/1911), [#1916](https://github.com/morluto/rea/pull/1916), [#1921](https://github.com/morluto/rea/pull/1921), [#1934](https://github.com/morluto/rea/pull/1934), [#1939](https://github.com/morluto/rea/pull/1939), [issue morluto/rea#1881](https://github.com/morluto/rea/issues/1881), [issue morluto/rea#1882](https://github.com/morluto/rea/issues/1882), [issue morluto/rea#1883](https://github.com/morluto/rea/issues/1883), [#1941](https://github.com/morluto/rea/pull/1941), [#2062](https://github.com/morluto/rea/pull/2062), [issue morluto/rea#2058](https://github.com/morluto/rea/issues/2058), [#2104](https://github.com/morluto/rea/pull/2104), [#2422](https://github.com/morluto/rea/pull/2422), [#2475](https://github.com/morluto/rea/pull/2475), [#2737](https://github.com/morluto/rea/pull/2737), [issue morluto/rea#2663](https://github.com/morluto/rea/issues/2663), [d3088c3](https://github.com/morluto/rea/commit/d3088c3795f6c37cb3b6aec0bb0c371dd0640ee8), [1dfb933](https://github.com/morluto/rea/commit/1dfb933e47db0156cf1cb61f28715b81e740c57b), [f8513a4](https://github.com/morluto/rea/commit/f8513a42dc44451a621127f06edde5d38bc93f69), [b8fab74](https://github.com/morluto/rea/commit/b8fab7429771bb17a7ca0297661de3c9935212af), [42b0ed1](https://github.com/morluto/rea/commit/42b0ed126df7d5b908ac369715378d5e519051b7), [c0904b4](https://github.com/morluto/rea/commit/c0904b4c1aabfccf2f0ab12f44960a0a1fbbbfae), [9f67e44](https://github.com/morluto/rea/commit/9f67e44e5d451d705bae9a579ad9802d5c9f097c), [e4532b5](https://github.com/morluto/rea/commit/e4532b537663026c3e5b784380eecd009c959a36), [1c37914](https://github.com/morluto/rea/commit/1c37914306b3ff257d7a0360f11c9bf2a3f2cac7), [5ab0cbb](https://github.com/morluto/rea/commit/5ab0cbb48ea5a4f11542eac44479b9af48f1dabd), [b7169c8](https://github.com/morluto/rea/commit/b7169c8b747cbc032913b31f008a3b81c77b6219), [f43fc02](https://github.com/morluto/rea/commit/f43fc0247527aebb8efc7d9db04276fe2d489323), [3ae826c](https://github.com/morluto/rea/commit/3ae826ceba6f25b08bce50bcb51001209bc16b57), [1b95302](https://github.com/morluto/rea/commit/1b953021eadf4cac09e20be388d79536903633b3), [eaa9616](https://github.com/morluto/rea/commit/eaa961658578522cecfbba7c7be1acf1c64da65a), [c923fb0](https://github.com/morluto/rea/commit/c923fb0dc9462e302b84a15770131ff899f89455), [c7a890d](https://github.com/morluto/rea/commit/c7a890d12987d9b2d496119c1fbf1a88c0fc298e)). Thanks @Aurantium-47, @baron, @chqcjq, @coygeek, @cyanseek, @fengdwx, @flitzrrr, @immanuwell, @kaoru0822-kitauji, @N0zoM1z0, @Nelglor, @ranmori, @rudycelekli, @shoyann, @xu91102.
- **Browser observations:** preserve effective source-map URLs, empty query/fragment identity, response-body provenance, service-worker policies and explicit uncertainty for malformed events. Bound discovery lifetimes and retain cleanup ownership. Interrupt/retry/failure cases validated with controlled CDP/session fixtures do not establish those paths in real Chromium. ([#1742](https://github.com/morluto/rea/pull/1742), [issue morluto/rea#1729](https://github.com/morluto/rea/issues/1729), [#1829](https://github.com/morluto/rea/pull/1829), [#2074](https://github.com/morluto/rea/pull/2074), [#2099](https://github.com/morluto/rea/pull/2099), [#2239](https://github.com/morluto/rea/pull/2239), [issue morluto/rea#2169](https://github.com/morluto/rea/issues/2169), [#2477](https://github.com/morluto/rea/pull/2477), [486b567](https://github.com/morluto/rea/commit/486b56724c4eaba50719177bcb9eae84d6907297), [a82e37c](https://github.com/morluto/rea/commit/a82e37c8065cc200a0ca3e14e7c4f85e4e468580), [a8d4984](https://github.com/morluto/rea/commit/a8d4984404b611e60b88bc42289c0ba07eee4578), [966f7cc](https://github.com/morluto/rea/commit/966f7cc84b4a8bb0043641cb64d7a7aaf8715e05), [221c856](https://github.com/morluto/rea/commit/221c85648108e9846d9920b0964dafa7f108d581), [951b095](https://github.com/morluto/rea/commit/951b095e11adf9faa9c4a27e212260060aa6b095), [f09bb8a](https://github.com/morluto/rea/commit/f09bb8a99773f79c7306b8799c86f856fe2c0d4b), [6bd2b28](https://github.com/morluto/rea/commit/6bd2b28161411f70ed5dc72e42c2736a1aab758b)). Thanks @1052326311, @chAng-L19, @chqcjq, @coygeek, @evenafterallisaid, @fisforfaheem, @itsF4LCON, @N0zoM1z0, @shayanxcyber.
- **Managed metadata/CIL:** preserve ExportedType and pointer-table ownership, generic/array/function-pointer/modifier signatures, ReadyToRun host identity, metadata ExtraData and signed zero. Charge retained facts and decoded instruction counts instead of broad decoding bounds; malformed layouts remain caller input errors. ([#1743](https://github.com/morluto/rea/pull/1743), [issue morluto/rea#1736](https://github.com/morluto/rea/issues/1736), [#1768](https://github.com/morluto/rea/pull/1768), [#1822](https://github.com/morluto/rea/pull/1822), [issue morluto/rea#1801](https://github.com/morluto/rea/issues/1801), [#1828](https://github.com/morluto/rea/pull/1828), [issue morluto/rea#1812](https://github.com/morluto/rea/issues/1812), [#1835](https://github.com/morluto/rea/pull/1835), [issue morluto/rea#1832](https://github.com/morluto/rea/issues/1832), [#1886](https://github.com/morluto/rea/pull/1886), [#1893](https://github.com/morluto/rea/pull/1893), [#1897](https://github.com/morluto/rea/pull/1897), [issue morluto/rea#1878](https://github.com/morluto/rea/issues/1878), [#1943](https://github.com/morluto/rea/pull/1943), [issue morluto/rea#1940](https://github.com/morluto/rea/issues/1940), [#1985](https://github.com/morluto/rea/pull/1985), [#2194](https://github.com/morluto/rea/pull/2194), [issue morluto/rea#2191](https://github.com/morluto/rea/issues/2191), [#2437](https://github.com/morluto/rea/pull/2437), [52e76c5](https://github.com/morluto/rea/commit/52e76c5d39b58d1685bb5e22bd40d19524dfa2cb)). Thanks @ac1982, @chqcjq, @fisHarly0, @flitzrrr, @JasonBuildAI, @JayOfTheKeyboard, @jhuang-tw, @kaoru0822-kitauji, @N0zoM1z0, @Nelglor.
- **Hopper failure ownership:** preserve startup/process outcomes, retain cleanup leases across one-shot failures, wait for late bridges, and stop owned Linux demo children when their REA owner exits. Denied/crashed/late-bridge/queued-request failure paths use simulated process or bridge fixtures; they are not fresh installed-Hopper verification. ([#1763](https://github.com/morluto/rea/pull/1763), [issue morluto/rea#1751](https://github.com/morluto/rea/issues/1751), [#1817](https://github.com/morluto/rea/pull/1817), [#1866](https://github.com/morluto/rea/pull/1866), [#1927](https://github.com/morluto/rea/pull/1927), [#2474](https://github.com/morluto/rea/pull/2474), [#2499](https://github.com/morluto/rea/pull/2499), [issue morluto/rea#2459](https://github.com/morluto/rea/issues/2459)). Thanks @coygeek, @Joshwong1908, @kaoru0822-kitauji, @N0zoM1z0, @rudycelekli.
- **IDA session boundaries:** retain non-x86 call coverage and unresolved-procedure uncertainty, and bound private universal-Mach-O inputs to the exact selected slice. Transient headless busy recovery was exercised on macOS arm64 IDA Pro 9.1; Linux headless, attached GUI navigation and worker-reaped cleanup paths retain their documented verification gaps. ([#1764](https://github.com/morluto/rea/pull/1764), [issue morluto/rea#1712](https://github.com/morluto/rea/issues/1712), [#1778](https://github.com/morluto/rea/pull/1778), [issue morluto/rea#1766](https://github.com/morluto/rea/issues/1766), [#1785](https://github.com/morluto/rea/pull/1785), [issue morluto/rea#1769](https://github.com/morluto/rea/issues/1769), [#1906](https://github.com/morluto/rea/pull/1906), [issue morluto/rea#1794](https://github.com/morluto/rea/issues/1794), [#2201](https://github.com/morluto/rea/pull/2201), [issue morluto/rea#2139](https://github.com/morluto/rea/issues/2139), [#2291](https://github.com/morluto/rea/pull/2291), [issue morluto/rea#2285](https://github.com/morluto/rea/issues/2285), [#2324](https://github.com/morluto/rea/pull/2324), [12fa8fd](https://github.com/morluto/rea/commit/12fa8fd9f986dbd4ff58165c3ec71a46dc8a8a3b)). Thanks @akushonkamen, @coygeek, @kaoru0822-kitauji, @N0zoM1z0, @nikolay-dementiev, @zecaro.
- **Input and capability diagnostics:** identify invalid paths, format refusals, missing host tools and non-retryable errors without losing caller selections or retryable capability facts. Foreign execution/device mutation annotations remain destructive, analysis-target text is untrusted, and output ordering follows code points rather than host locale. ([#1770](https://github.com/morluto/rea/pull/1770), [#1867](https://github.com/morluto/rea/pull/1867), [#1869](https://github.com/morluto/rea/pull/1869), [issue morluto/rea#1855](https://github.com/morluto/rea/issues/1855), [#1872](https://github.com/morluto/rea/pull/1872), [#1879](https://github.com/morluto/rea/pull/1879), [issue morluto/rea#1853](https://github.com/morluto/rea/issues/1853), [#1899](https://github.com/morluto/rea/pull/1899), [#1902](https://github.com/morluto/rea/pull/1902), [#1904](https://github.com/morluto/rea/pull/1904), [#1908](https://github.com/morluto/rea/pull/1908), [#1925](https://github.com/morluto/rea/pull/1925), [#1987](https://github.com/morluto/rea/pull/1987), [issue morluto/rea#1979](https://github.com/morluto/rea/issues/1979), [#2004](https://github.com/morluto/rea/pull/2004), [issue morluto/rea#2002](https://github.com/morluto/rea/issues/2002), [#2026](https://github.com/morluto/rea/pull/2026), [#2091](https://github.com/morluto/rea/pull/2091), [#2133](https://github.com/morluto/rea/pull/2133), [issue morluto/rea#2129](https://github.com/morluto/rea/issues/2129), [#2145](https://github.com/morluto/rea/pull/2145), [issue morluto/rea#2143](https://github.com/morluto/rea/issues/2143), [#2472](https://github.com/morluto/rea/pull/2472), [#2478](https://github.com/morluto/rea/pull/2478), [issue morluto/rea#2454](https://github.com/morluto/rea/issues/2454), [#2494](https://github.com/morluto/rea/pull/2494), [#2507](https://github.com/morluto/rea/pull/2507), [#2509](https://github.com/morluto/rea/pull/2509), [#2708](https://github.com/morluto/rea/pull/2708), [3d83135](https://github.com/morluto/rea/commit/3d8313598785359c424d7305f503cb69fc8639a6), [c9fed50](https://github.com/morluto/rea/commit/c9fed50691ae014890e91a72534773d2fb58ce44), [8b18171](https://github.com/morluto/rea/commit/8b181716aca2cb467be499cba226abfb5ae19141), [7a2cd1e](https://github.com/morluto/rea/commit/7a2cd1ea0a63e8c44166860b7ee9c7a1aa43492b)). Thanks @astralyx0129, @CassieFox23, @DeryFerd, @dollarsmoney, @fisforfaheem, @flitzrrr, @Ha1baraA11, @jimpablo, @kaoru0822-kitauji, @larinyo, @N0zoM1z0, @rudycelekli, @SII-YDD, @viniciusdsandrade, @XiaoBinGan.
- **Android analysis:** retain decoded values, duplicate-class inventories and executable static initializers, reject malformed JADX UTF-8, and keep inline search provenance. Apktool accepts `--no-strings` and explains host requirements. Windows batch-launcher selection also resolves PATH/PATHEXT before choosing its launch mode. Recorded Apktool coverage is Linux/OpenJDK, and changed JADX/batch failure paths do not establish native Windows behavior. ([#1777](https://github.com/morluto/rea/pull/1777), [issue morluto/rea#1774](https://github.com/morluto/rea/issues/1774), [#1876](https://github.com/morluto/rea/pull/1876), [issue morluto/rea#1846](https://github.com/morluto/rea/issues/1846), [#1890](https://github.com/morluto/rea/pull/1890), [issue morluto/rea#1850](https://github.com/morluto/rea/issues/1850), [#1946](https://github.com/morluto/rea/pull/1946), [issue morluto/rea#1945](https://github.com/morluto/rea/issues/1945), [#2707](https://github.com/morluto/rea/pull/2707), [issue morluto/rea#2672](https://github.com/morluto/rea/issues/2672), [0677468](https://github.com/morluto/rea/commit/0677468877465c8dfbe25c72f142a7b5bc8a3212), [fe8d0bd](https://github.com/morluto/rea/commit/fe8d0bdd36fe12bc0836468d1a702a34fbdc219b), [#2802](https://github.com/morluto/rea/pull/2802)). Thanks @akushonkamen, @coygeek, @HeadmasterEggy, @kaoru0822-kitauji, @N0zoM1z0, @psipher.
- **ADB acquisition:** preserve device paths and directory identity, prevent host destination collisions/overwrites, count UTF-8 logcat bytes and restricted permissions, and evaluate the complete Activity Manager start report. Launch attempts, status, activity and raw failure output remain observations; real-device timeout/mixed-report and Android 8 directory-read paths remain unverified beyond the documented fixtures. ([#1962](https://github.com/morluto/rea/pull/1962), [#2212](https://github.com/morluto/rea/pull/2212), [issue morluto/rea#2175](https://github.com/morluto/rea/issues/2175), [#2221](https://github.com/morluto/rea/pull/2221), [issue morluto/rea#2220](https://github.com/morluto/rea/issues/2220), [#2359](https://github.com/morluto/rea/pull/2359), [c42232f](https://github.com/morluto/rea/commit/c42232f566d55fe7191763649755148c768eef9f), [55b6148](https://github.com/morluto/rea/commit/55b61485e9f7568b69597eef8696ff6abfe53cfd), [3bdc873](https://github.com/morluto/rea/commit/3bdc8730bd98e073522bcb8ba86527be402c0cbe), [c89972c](https://github.com/morluto/rea/commit/c89972c8777d0114566fe76a060849a18bdd2659), [e1cd292](https://github.com/morluto/rea/commit/e1cd292aa6e8f5f13441d408c66126782c8dbb0d)). Thanks @coygeek, @dakjdakd, @DeryFerd, @huiq777, @sx4im.
- **WASM names and diagnostics:** preserve debug/custom-section names including NUL and leading BOM, accept unpadded WABT section rows, and avoid irrelevant tool-remediation advice on unrelated runtime-root failures. ([#1963](https://github.com/morluto/rea/pull/1963), [issue morluto/rea#1956](https://github.com/morluto/rea/issues/1956), [#1967](https://github.com/morluto/rea/pull/1967), [#1981](https://github.com/morluto/rea/pull/1981), [#2084](https://github.com/morluto/rea/pull/2084), [#2102](https://github.com/morluto/rea/pull/2102)). Thanks @1052326311, @bugstan, @N0zoM1z0, @sathariels, @STiFLeR7, @viniciusdsandrade.

- **Source-map and path handling:** retain source-map entries when embedded-content counts differ or an optional `sourceMappingURL` is used, and keep `file:` URLs out of operator-relative path resolution. ([#2873](https://github.com/morluto/rea/pull/2873), [#2886](https://github.com/morluto/rea/pull/2886), [#2882](https://github.com/morluto/rea/pull/2882), [issue morluto/rea#2821](https://github.com/morluto/rea/issues/2821), [issue morluto/rea#2883](https://github.com/morluto/rea/issues/2883), [issue morluto/rea#2577](https://github.com/morluto/rea/issues/2577)). Thanks @JFSAS, @rileygramlich, @shoyann, @shubhamahuja9999, @coygeek.
- **Native metadata:** accept declared facts in native dispatch inventories and share native verification input diagnostics. ([#2906](https://github.com/morluto/rea/pull/2906), [#2901](https://github.com/morluto/rea/pull/2901), [issue morluto/rea#2564](https://github.com/morluto/rea/issues/2564), [issue morluto/rea#2621](https://github.com/morluto/rea/issues/2621)). Thanks @ShitK, @coygeek.

### ⚠ BREAKING CHANGES

- **Runtime attachment state:** `attached` may be `null` in JavaScript, browser and Electron discovery/inspection results. Treat null as unknown; do not coerce it to false. ([e55ef72](https://github.com/morluto/rea/commit/e55ef7213515ba204c3d88a4487b4ee6a2773b06)).
- **Source maps:** original-source and mapping rows preserve a null source name when unavailable. Handle null explicitly instead of expecting an invented unknown-source string; new index fields remain optional when reading older Evidence. ([ee50ed1](https://github.com/morluto/rea/commit/ee50ed121e38cc6e1a2ff0dc8b789f15f71c5402)).
- **Streamed filtered JSON:** `--filter-output` now emits JSON `null` instead of `{}` when the selected value is null; consumers must distinguish a present null from a missing selection. Use `--full-output` when an object envelope is required. ([#2333](https://github.com/morluto/rea/pull/2333)). Thanks @Jackmeson1.
- **Call graphs:** `get_call_graph.normalized_result` is now `{ graph, limitations }`; read traversal-depth groups under `graph` and retain relationship-specific caveats. Contract/fixture validation does not establish new Ghidra or IDA engine coverage. ([5dfb9d0](https://github.com/morluto/rea/commit/5dfb9d050c2cc44a61b183dae765bef4d22a53b7)).
- **MCP discovery:** `binary_session` no longer repeats `server_identity.catalog.tools`. Use the connected server tool list, grouped `tool_availability` and provider capabilities; see [MCP contracts](docs/reference/mcp-contracts.md). Origin: [6395e8d](https://github.com/morluto/rea/commit/6395e8d3007d5ee453477460e7ee1c51cff76be0). ([#1988](https://github.com/morluto/rea/pull/1988)). Thanks @kaoru0822-kitauji, @N0zoM1z0.

- **Provider admission:** MIPS targets with unresolved GNU ABI attributes are refused. Supply supported ABI declarations. Saved Hopper databases on macOS are unavailable because the launcher cannot run the analysis bridge when opening a database; select an executable target instead. Database support requires a script-capable database launch route. ([d4bd65c](https://github.com/morluto/rea/commit/d4bd65c53c0254d0195cc7ab8da163dcadfd3b9b)).
- **Segment extents:** `binary_overview` segment length may be null when Hopper coordinates cannot establish a finite extent in one address space. Preserve unknown rather than converting it to zero or a saturated value. ([36db19c](https://github.com/morluto/rea/commit/36db19c59)).
- **Invocation identity:** `server.command_path` may be null, and registration/setup statuses or doctor classifications may be unknown. Preserve these states and establish the actual invocation before treating a registration as aligned. ([187f113](https://github.com/morluto/rea/commit/187f113f7)). Thanks @hemv-857, @qorvr.
- **ADB installation:** the optional `replace` input is unchanged. Results now require `replace_requested` to record the requested `adb install -r` mode; `replaced` is nullable because prior device package state was not observed. Update result readers to accept null instead of treating reinstall intent as proof of replacement. ([864314a](https://github.com/morluto/rea/commit/864314ac857924a7e6e65bfb37e8dc720fcc21e7)).
- **Managed/native verification:** unresolved P/Invoke results may retain `matched_native` and candidate facts when module identity is unknown. Interpret `status`, `basis` and `limitations`; `module-identity-unknown` does not verify correspondence, and unresolved no longer implies empty observations. ([3f6b575](https://github.com/morluto/rea/commit/3f6b5755b3e699bd9373641acffe0f2c5d2ab094)).

Full contribution record: [893 commits and 529 merged PRs](https://github.com/morluto/rea/blob/rea-agents-6.5.0/docs/releases/6.5.0.contributions.json).


## [6.4.0](https://github.com/morluto/rea/compare/rea-agents-6.3.0...rea-agents-6.4.0) (2026-10-11)

### Highlights

- Android: added device inspection, split-APK acquisition, logs, screenshots, file transfers and explicit app lifecycle actions through ADB, plus manifest and localized-string decoding with Apktool. ([#1552](https://github.com/morluto/rea/pull/1552), [#1556](https://github.com/morluto/rea/pull/1556)) Thanks @3QL.
- JEB: browse project units and decompile selected items through a caller-started local JEB MCP server. ([#1536](https://github.com/morluto/rea/pull/1536)) Thanks @3QL.
- Large analyses: discover retained Evidence without loading every payload, and inspect JavaScript graphs, binary layouts and function dossiers through summaries and selected views. ([#1682](https://github.com/morluto/rea/pull/1682), [#1568](https://github.com/morluto/rea/pull/1568), [#1570](https://github.com/morluto/rea/pull/1570), [#1345](https://github.com/morluto/rea/pull/1345), [#1507](https://github.com/morluto/rea/pull/1507), [#1247](https://github.com/morluto/rea/issues/1247)) Thanks @jhuang-tw, @kaoru0822-kitauji, @N0zoM1z0.
- JavaScript: isolate source analysis in an owned process with configurable heap and timeout limits; retain completed facts and explicit unknowns when analysis runs out of resources. ([#1651](https://github.com/morluto/rea/pull/1651), [#1563](https://github.com/morluto/rea/issues/1563), [#1565](https://github.com/morluto/rea/issues/1565)) Thanks @N0zoM1z0, @peter-research.
- Ghidra: configure import language/compiler specifications and seed functions, code and labels before auto-analysis. ([#1667](https://github.com/morluto/rea/pull/1667)) Thanks @sqmagellan.
- RPC discovery: recognize supported tRPC calls, HTTP-link URLs and named GraphQL operations in JavaScript applications and web bundles. ([#1670](https://github.com/morluto/rea/pull/1670)) Thanks @pompiliodonatoapp.

### Changes

- Added Ghidra support for Windows PE DLLs and bounded MIPS ELF analysis, including carved MIPS inputs with incomplete section tables. Windows P0 remains read-only. ([#1303](https://github.com/morluto/rea/pull/1303), [#1362](https://github.com/morluto/rea/pull/1362), [#1629](https://github.com/morluto/rea/pull/1629), [#1290](https://github.com/morluto/rea/issues/1290), [#718](https://github.com/morluto/rea/issues/718), [#1619](https://github.com/morluto/rea/issues/1619)) Thanks @bqw371, @jaelliot, @kvalls, @N0zoM1z0.
- Enabled `set_address_name` and `set_addresses_names` for Ghidra sessions with mutation authority, including namespace-aware data labels and per-address batch results. ([#1635](https://github.com/morluto/rea/pull/1635), [#1634](https://github.com/morluto/rea/issues/1634)) Thanks @giri256.
- Recovered additional signed AArch64 relative jump-table patterns. ([#1592](https://github.com/morluto/rea/pull/1592)) Thanks @RishTheFish21.
- Added PE resource inspection and read-only NativeAOT metadata parsing for supported x64 PE32+/.NET 8 RTR 9.1 inputs. The NativeAOT parser’s Windows-host Ghidra workflow remains unverified on a real Windows host. ([#1482](https://github.com/morluto/rea/pull/1482), [76d8f68](https://github.com/morluto/rea/commit/76d8f68cb918dfb43869f2b649a0b6c0c1cf266d), [#1254](https://github.com/morluto/rea/issues/1254)) Thanks @N0zoM1z0, @thangldw.
- Added Pi, Hermes and Qwen Code setup, including Hermes active-profile support. ([#1376](https://github.com/morluto/rea/pull/1376), [#1403](https://github.com/morluto/rea/pull/1403), [#1415](https://github.com/morluto/rea/pull/1415), [#1409](https://github.com/morluto/rea/issues/1409)) Thanks @rasatpetabit, @yiliang114, @zaydiscold.
- Added `REA_MCP_INPUT_SCHEMA_PROFILE=compact` for size-capped MCP clients such as Kimi/Moonshot, while retaining canonical runtime validation. ([#1514](https://github.com/morluto/rea/pull/1514), [#1580](https://github.com/morluto/rea/pull/1580), [#1484](https://github.com/morluto/rea/issues/1484), [#1581](https://github.com/morluto/rea/issues/1581)) Thanks @haythemsellami, @N0zoM1z0.
- Added live process-capture progress and optional `finalization_ms` to capture shutdown output before timeout escalation; cancellation remains immediate. ([#1483](https://github.com/morluto/rea/pull/1483), [#1583](https://github.com/morluto/rea/pull/1583), [#1252](https://github.com/morluto/rea/issues/1252), [#1253](https://github.com/morluto/rea/issues/1253), [modelcontextprotocol/typescript-sdk#2997](https://github.com/modelcontextprotocol/typescript-sdk/issues/2997)) Thanks @N0zoM1z0, @nikolay-dementiev, @sathariels.
- Improved Codex onboarding and recovery from observed client, PATH and provider blockers. ([#1613](https://github.com/morluto/rea/pull/1613)) Thanks @N0zoM1z0.
- Reduced redirected JSON and terminal output size, and deferred heavy imports until their commands need them. ([#1413](https://github.com/morluto/rea/pull/1413), [#1450](https://github.com/morluto/rea/pull/1450), [#1439](https://github.com/morluto/rea/pull/1439), [21dbcf7](https://github.com/morluto/rea/commit/21dbcf7a1458219989ad291e44ce7d017378b727)) Thanks @kaoru0822-kitauji.

### Fixes

- Electron analysis: follow renamed and default-imported APIs and optional calls, ignore overwritten identities and media preload attributes, and resolve packaged `app.asar` pages and unpacked companions. ([#1391](https://github.com/morluto/rea/pull/1391), [#1393](https://github.com/morluto/rea/pull/1393), [#1400](https://github.com/morluto/rea/pull/1400), [#1664](https://github.com/morluto/rea/pull/1664), [#1673](https://github.com/morluto/rea/pull/1673)) Thanks @kaoru0822-kitauji, @marnixpluim, @N0zoM1z0, @suninrain086.
- JavaScript data flow: preserve returned/yielded reference uncertainty, invalidate property-stored aliases correctly, and retain bundled-module runtime scope. ([#1437](https://github.com/morluto/rea/pull/1437), [#1445](https://github.com/morluto/rea/pull/1445), [#1471](https://github.com/morluto/rea/pull/1471), [#1577](https://github.com/morluto/rea/pull/1577), [#1428](https://github.com/morluto/rea/issues/1428), [#1442](https://github.com/morluto/rea/issues/1442), [#1449](https://github.com/morluto/rea/issues/1449), [#1576](https://github.com/morluto/rea/issues/1576)) Thanks @CassieFox23, @dakjdakd, @N0zoM1z0.
- JavaScript packages: resolve exact exports subpaths, preserve trailing-slash directory requests and exact CommonJS keys, and respect shadowed `require` bindings. ([#1424](https://github.com/morluto/rea/pull/1424), [#1615](https://github.com/morluto/rea/pull/1615), [5485483](https://github.com/morluto/rea/commit/5485483f7da2f6cb66441bb784aaf2a1a5f8731a), [8b2f851](https://github.com/morluto/rea/commit/8b2f8514c50e469c3add8ce9ba7ebebef888b14f), [f998fcb](https://github.com/morluto/rea/commit/f998fcb1cca9994c3589fb70d6e0127fc215f76f), [1e51c73](https://github.com/morluto/rea/commit/1e51c732bbf08191688d6526bf58ab2650b601e3), [#1365](https://github.com/morluto/rea/issues/1365)) Thanks @akshitkhokhani, @AWUQAQ, @immanuwell, @rudycelekli.
- Large JavaScript inputs: handle oversized inline source maps, deep returns and reassignment loops; avoid argument expansion limits and yield during large analysis passes. ([#1386](https://github.com/morluto/rea/pull/1386), [#1368](https://github.com/morluto/rea/pull/1368), [#1390](https://github.com/morluto/rea/pull/1390), [#1539](https://github.com/morluto/rea/pull/1539), [#1525](https://github.com/morluto/rea/pull/1525), [#1542](https://github.com/morluto/rea/pull/1542), [#1545](https://github.com/morluto/rea/pull/1545), [#1557](https://github.com/morluto/rea/pull/1557), [#1380](https://github.com/morluto/rea/issues/1380), [#1401](https://github.com/morluto/rea/issues/1401), [#1538](https://github.com/morluto/rea/issues/1538), [#1462](https://github.com/morluto/rea/issues/1462)) Thanks @cold-atom, @KadirJeager, @kaoru0822-kitauji, @marnixpluim, @N0zoM1z0, @rudycelekli.
- JavaScript receivers: expand escaped methods once, index returned-object targets, and avoid replaying earlier writes or duplicating retained graph allocations. ([#1517](https://github.com/morluto/rea/pull/1517), [#1537](https://github.com/morluto/rea/pull/1537), [#1444](https://github.com/morluto/rea/pull/1444), [#1601](https://github.com/morluto/rea/pull/1601), [#1495](https://github.com/morluto/rea/issues/1495)) Thanks @CassieFox23, @geekwolf, @kaoru0822-kitauji, @N0zoM1z0, @zeynelacikgoez.
- Browser captures: retain WebSocket URLs, empty connections and frame order; compare only common known payload coverage and preserve incomplete WebMCP replay coverage. ([db4e360](https://github.com/morluto/rea/commit/db4e3608465486466591b594cf77037ac150c988), [aa257ea](https://github.com/morluto/rea/commit/aa257ea4b16f2d2a35c12df63359d650b48b1154), [e52c0a7](https://github.com/morluto/rea/commit/e52c0a72c59c740315e89149881a27ce4d89a11c))
- Browser scenarios: seed storage in the correct partition, normalize loopback attach identities, retain declared-secret redaction and require verified lineage before Windows Electron signals. ([#1604](https://github.com/morluto/rea/pull/1604), [#1590](https://github.com/morluto/rea/pull/1590), [#1588](https://github.com/morluto/rea/pull/1588), [8b4c3de](https://github.com/morluto/rea/commit/8b4c3de3b3a3b580adec266f94f29ccedf1da228), [#1497](https://github.com/morluto/rea/issues/1497), [#1591](https://github.com/morluto/rea/issues/1591), [#1589](https://github.com/morluto/rea/issues/1589)) Thanks @Adolanium, @akushonkamen, @dakjdakd.
- Added Termux Android browser-scenario support. ([#1655](https://github.com/morluto/rea/pull/1655)) Thanks @tyloryang.
- Web inputs: accept BOM-prefixed HAR, preserve the first duplicate DOM attribute and resolve SVG/XLink URLs in HTML and XHTML. ([#1509](https://github.com/morluto/rea/pull/1509), [#1516](https://github.com/morluto/rea/pull/1516), [#1602](https://github.com/morluto/rea/pull/1602), [#1683](https://github.com/morluto/rea/pull/1683), [#1496](https://github.com/morluto/rea/issues/1496), [#1586](https://github.com/morluto/rea/issues/1586)) Thanks @CassieFox23, @kaoru0822-kitauji, @sathariels, @taljeri.
- Screenshot comparisons: validate PNG chunks, distinguish corruption from unsupported encodings and bound comparison memory. ([4e4b15b](https://github.com/morluto/rea/commit/4e4b15b8250b29e176d4191c9610a3931b693474), [b3e977e](https://github.com/morluto/rea/commit/b3e977e6d073ab1783cece8581279f87fc360411)) Thanks @rudycelekli.
- Archives: preserve case-distinct names, report collisions at their diverging segment, detect nested formats from bytes and reject Windows alternate-stream extraction paths. ([#1480](https://github.com/morluto/rea/pull/1480), [#1505](https://github.com/morluto/rea/pull/1505), [#1553](https://github.com/morluto/rea/pull/1553), [573598c](https://github.com/morluto/rea/commit/573598c6324698cc48ceafd24ed3864670e08d00), [#1470](https://github.com/morluto/rea/issues/1470), [#1491](https://github.com/morluto/rea/issues/1491)) Thanks @CassieFox23, @kaoru0822-kitauji.
- Cleanup: retain failed readers, ASAR handles, output trees and provider workers for retry without discarding completed output or partial observations. ([ffe0574](https://github.com/morluto/rea/commit/ffe0574e17b9d973860371083cb1a351be912131), [de0d341](https://github.com/morluto/rea/commit/de0d341524dc68250a45b41eb7e49fcecc1e32a9), [3f8c51e](https://github.com/morluto/rea/commit/3f8c51e9b506d88fc41aded7b1a22b9a09037c26), [d1235fa](https://github.com/morluto/rea/commit/d1235fadc901e1fb9ab3149d53063306c8545414), [026126e](https://github.com/morluto/rea/commit/026126eafe741e5a8b857433587fd615cdd44c19))
- Providers: canonicalize IDA workspace roots before identity checks, respect IDA cancellation, serialize JEB acquisition and correct Ghidra no-return/imported-symbol recovery. ([#1481](https://github.com/morluto/rea/pull/1481), [#1419](https://github.com/morluto/rea/pull/1419), [5f30ea6](https://github.com/morluto/rea/commit/5f30ea6ff2dd89aab7af6da6e8dfa5e508ed459b), [f88c990](https://github.com/morluto/rea/commit/f88c99021b88ce67e513025901f57478d8107d0c), [49e6f00](https://github.com/morluto/rea/commit/49e6f00ed08b225abf9ddb7c762553607fdab115)) Thanks @AS9929, @JonahSimon, @Y0UW1SH.
- Binary metadata: respect PE/.NET section extents, bound binary-plist expansion, scope keyed-archive traversal and decode app `Info.plist` files without `plutil`. ([#1678](https://github.com/morluto/rea/pull/1678), [#1515](https://github.com/morluto/rea/pull/1515), [#1378](https://github.com/morluto/rea/pull/1378), [#1476](https://github.com/morluto/rea/pull/1476), [975dff2](https://github.com/morluto/rea/commit/975dff2e25b14b634e14dd5e0db1537d0ca9815b), [76296c5](https://github.com/morluto/rea/commit/76296c5a3868ba3b54be6ed3896719283d6de5f8)) Thanks @jayhemnani9910, @kaoru0822-kitauji, @rudycelekli.
- Windows runtimes: preserve drive-root paths when creating private provider directories. ([ee46323](https://github.com/morluto/rea/commit/ee46323b493994902b04824a7dc8aae2a8117903))
- Compatibility: load Windows native controls under Node-API hosts with renamed executables, preserve dylib directory requirements, support Wakaru 1.x and reject directory-valued Hopper launchers. ([#1531](https://github.com/morluto/rea/pull/1531), [#1623](https://github.com/morluto/rea/pull/1623), [#1540](https://github.com/morluto/rea/pull/1540), [#1426](https://github.com/morluto/rea/pull/1426)) Thanks @evenafterallisaid, @Fazmin, @pionxzh, @xeropresence.
- Reference imports: normalize internal symlink lookup consistently, preserve exact paths and exclusion provenance, report root access failures and reject FIFO replacements without blocking. ([#1535](https://github.com/morluto/rea/pull/1535), [2ca3ad2](https://github.com/morluto/rea/commit/2ca3ad238608adfca80a7ff1aaadea6e59a58225), [6636045](https://github.com/morluto/rea/commit/6636045c9c5b472bba51afee9d434394861e93a4), [3967cfa](https://github.com/morluto/rea/commit/3967cfa43e786c65a57e89c265343983d19ef9d0), [f1c58cc](https://github.com/morluto/rea/commit/f1c58cc53fbd83b968e11b3e2eccebca51299c54)) Thanks @anujsingh-cse.
- Setup: honor active configuration and skill roots, preserve configured MCP environments, validate Hermes/OMP profiles before writing, recognize Omarchy and retain recovery backups. ([#1504](https://github.com/morluto/rea/pull/1504), [#1607](https://github.com/morluto/rea/pull/1607), [#1528](https://github.com/morluto/rea/pull/1528), [#1562](https://github.com/morluto/rea/pull/1562), [#1662](https://github.com/morluto/rea/pull/1662), [a011485](https://github.com/morluto/rea/commit/a01148553e2a37c72ae78405418ab648876a96a6), [#1606](https://github.com/morluto/rea/issues/1606), [#1521](https://github.com/morluto/rea/issues/1521), [#1561](https://github.com/morluto/rea/issues/1561)) Thanks @Adkid-Zephyr, @CassieFox23, @LuisTaffelli, @N0zoM1z0, @peter-research.
- Process capture: retain descendant lineage after launcher exit, preserve identity uncertainty before signaling and release terminals after observation failures. ([80896a1](https://github.com/morluto/rea/commit/80896a1d64b216ef893907249cd4252f86215d49), [c916850](https://github.com/morluto/rea/commit/c9168508527302ac57bc86385ccf0d824697b5dc)) Thanks @Y0UW1SH.
- CLI/MCP errors: accept JSON files for web comparisons, preserve native option help and union correction details, remove invalid aliases and validate doctor against its discovered output contract. ([#1397](https://github.com/morluto/rea/pull/1397), [#1395](https://github.com/morluto/rea/pull/1395), [#1425](https://github.com/morluto/rea/pull/1425), [#1461](https://github.com/morluto/rea/pull/1461), [8b4c96e](https://github.com/morluto/rea/commit/8b4c96e6c6b3ed6806e4cd72b556b5db6114304a), [#1421](https://github.com/morluto/rea/issues/1421), [#1454](https://github.com/morluto/rea/issues/1454)) Thanks @Fazmin, @kaoru0822-kitauji, @N0zoM1z0.

### ⚠ BREAKING CHANGES

- WebSocket results: use `network.websocket_connections` instead of `network.websocket_events`. Connections contain `request_id`, `url` and `events`; allow `payload_bytes: null` when size is unknown. No legacy alias remains. ([db4e360](https://github.com/morluto/rea/commit/db4e3608465486466591b594cf77037ac150c988))
- Direct resource APIs: pass a caller-owned `ArtifactResourceScope` to inventory/extraction, JavaScript analysis, reference imports and web exports; retain it through cleanup/shutdown. For `readJavaScriptArtifactFiles`, scope is argument three and abort signal is argument four. Keep each root inventory source’s single cleanup owner. Use `OwnedFileHandle` owners, injected ASAR `fd`/`read` handles instead of `createReadStream`, VCS `Result` values, and `WebScriptExportError`’s options object. CLI/MCP inputs for the scoped operations are unchanged. ([ffe0574](https://github.com/morluto/rea/commit/ffe0574e17b9d973860371083cb1a351be912131), [53e7fad](https://github.com/morluto/rea/commit/53e7fadbd078422ba3d55b5499a70d237c5f4908), [684199b](https://github.com/morluto/rea/commit/684199ba0be7822266d57ddb8a40e95f087fdc42), [be75ed5](https://github.com/morluto/rea/commit/be75ed5e4b4bfb146af497f8fa5d172a1ea19462), [be6272f](https://github.com/morluto/rea/commit/be6272f26115bd8e94f2ab0df4cf092004587a18), [e0e49e9](https://github.com/morluto/rea/commit/e0e49e9dd53d9d1f1d2330b23f7f880dc1c81774), [95a77b6](https://github.com/morluto/rea/commit/95a77b6e25420b3879bd0e32bdbb14d452b38776))
- Saved reference graphs: exclusions require their matching `pattern` and distinguish `project-ignored` from `default-ignored`. Re-import graphs missing that provenance. ([6585293](https://github.com/morluto/rea/commit/6585293c562853b95c3a70df02c12ad8cc17afc4))
- Terminal captures: keep initial and resized buffers within 1,000,000 cells using `columns × (rows + scrollback)`; oversized scenarios are rejected before launch. ([f9ea9a9](https://github.com/morluto/rea/commit/f9ea9a9268c854d31048da9f8a50cfa37703fe5a))
- Optional agent-verification reports: accept schema version 4, nullable `expectedFirstTool` and `targetClarificationPassed`. Production CLI/MCP contracts are unchanged. ([#1613](https://github.com/morluto/rea/pull/1613))
- Capture comparisons: recapture both sides with matching `literal-replacements-v1` semantics when custom normalization patterns are used. Legacy unversioned pattern captures remain readable but cannot be compared with new pattern captures; captures without patterns are unaffected. ([#1456](https://github.com/morluto/rea/pull/1456), [2b6f14f](https://github.com/morluto/rea/commit/2b6f14f528297cf12c776c960af0859f5cfbefbf)) Thanks @Madhavan006, @N0zoM1z0.
- Artifact graph edges: read child artifact IDs and paths from the occurrence selected by `occurrence_id`, not edge fields `child_artifact_id`/`logical_path`. Earlier inventory Evidence no longer validates against the new commitment. ([#1493](https://github.com/morluto/rea/pull/1493)) Thanks @kaoru0822-kitauji.
- Semantic graph schema: nodes and relations no longer include `identifier_strategy`, and relation IDs no longer hash it. Earlier Evidence no longer validates against this schema. ([#1474](https://github.com/morluto/rea/pull/1474)) Thanks @kaoru0822-kitauji.
- Semantic identities: select IDs from the parent graph; read exact event names from `event_name`, endpoints from `endpoint` and literal values from `properties.value`. New analyses use digest-based IDs for long/reserved event and endpoint names and `value-sha256` literal role keys, with shorter labels; string literal labels now read `string literal`. Previously stored graphs retain their original IDs and remain valid workflow inputs. ([#1427](https://github.com/morluto/rea/pull/1427), [#1423](https://github.com/morluto/rea/pull/1423), [#1407](https://github.com/morluto/rea/pull/1407)) Thanks @N0zoM1z0.

### Contributors

- Thanks also to @BaaRai, @commit-regrets, @coygeek, @Franky100-pig, @inii-sayaa, @jopemachine, @JosephDemarest, @keemsisi, @Totopo27 for contributions included in this release.

Full contribution record: [336 commits and 163 merged PRs](https://github.com/morluto/rea/blob/rea-agents-6.4.0/docs/releases/6.4.0.contributions.json).

## [6.3.0](https://github.com/morluto/rea/compare/rea-agents-6.2.0...rea-agents-6.3.0) (2026-10-09)


### ⚠ BREAKING CHANGES

* **captures:** Historical captures without current producer accounting or transaction identity, and web diffs missing accessibility or storage dimensions, are rejected. Preserve original captures and recapture with the current producer; update comparison consumers to include every dimension rather than synthesizing missing observations. See the [process capture guide](docs/guides/runtime/process-capture.md) and [browser scenario contract](docs/guides/web/browser-scenario-contract.md). ([3283a45](https://github.com/morluto/rea/commit/3283a45d09457c79e3adadb50a48620926d4bc5b))
* **browser:** JSON shape paths now contain typed property and array-element segments. WebMCP input_schema_shape is replaced by input_schema and input_schema_sha256, retaining declared examples and defaults.
* **process:** Filesystem digest omission entries now require system_code; budget and changed-file omissions use null, and unavailable-file omissions preserve the operating-system error code.
* **contracts:** Provider analysis outputs must explicitly supply metadata previously repaired with defaults; unsupported nullable facets must be reported as null.
* **javascript:** Semantic graph facts now store evidence context IDs and locations. Graph and semantic trace results require an inline evidence_contexts table.
* **contracts:** source-map URLs now live in target observations selected by declared_url_sha256, and doctor skill identity no longer emits installed_catalog_digest. Use the documented observation join and identity.skill.state instead.
* **javascript:** remove the never-incremented truncated_scopes statistic from JavaScript application analysis results and schemas.
* **native:** Objective-C attribute tokens now contain only name and value. Properties report nullable atomicity and readonly facts; class flags, ivar counts, and method requirement flags are nullable when unobserved.

### Features

* **setup:** register OMP during setup ([#1301](https://github.com/morluto/rea/pull/1301)) ([8b4c359](https://github.com/morluto/rea/commit/8b4c3591358ee59297d8298ede1b63d08459d817))
* **javascript:** record Electron integrity mismatches ([7915ee5](https://github.com/morluto/rea/commit/7915ee51781878ed67e094259924b6e6f3093b3f))


### Bug Fixes

* **inspector:** retain observations after capture failures ([dea3498](https://github.com/morluto/rea/commit/dea3498b2b8d919606eefc4fd62f6ebcbbe5ed30))
* **artifacts:** bind ASAR interpretation to owned snapshots ([d79317c](https://github.com/morluto/rea/commit/d79317cda0bbe8240eb7e25b0a5de90dcffca5fa))
* **artifacts:** infer legacy Mach-O simulator platforms ([5aa2002](https://github.com/morluto/rea/commit/5aa200285ab066e48b37b716495936e6e2a963fd))
* **artifacts:** preserve archive facts and Unicode path identity ([5751f5c](https://github.com/morluto/rea/commit/5751f5caac86c770123ae739a4e4101a72b0989c))
* **artifacts:** reject incomplete inventoried extraction ([5e8fb53](https://github.com/morluto/rea/commit/5e8fb531e255a4a04fc053c54096f66d5c84cde3))
* **artifacts:** retain DMG ownership through uncertain attachment ([a27794c](https://github.com/morluto/rea/commit/a27794c246b3f11d7f92ae7f6d276718190ab731))
* **artifacts:** validate only active extraction entries ([cfb12e4](https://github.com/morluto/rea/commit/cfb12e47dc241f057be93a00892f7d7361d6119d))
* **browser:** follow only HTTP redirect statuses for source maps ([82bbe74](https://github.com/morluto/rea/commit/82bbe743336244d398e67512659ea6943d43a4a4))
* **browser:** preserve payload shapes and WebMCP declarations ([4951a89](https://github.com/morluto/rea/commit/4951a897c53bb6882300c5d7a9660a3f43e374f5))
* **browser:** release attached viewport overrides without resizing the external page ([f6cfbfc](https://github.com/morluto/rea/commit/f6cfbfcc554ff24173dd7ad5333e8e26ab9c962d))
* **browser:** retain attached scenario emulation until cleanup ([a0523b3](https://github.com/morluto/rea/commit/a0523b375eb3147f1d2d1e7eb10a2f4546f5d0fc))
* **browser:** retain malformed redirect diagnostics ([617cd84](https://github.com/morluto/rea/commit/617cd84d27d100e7cc3cd4b5721dea4a996c9775))
* **browser:** serialize attached scenarios through cleanup settlement ([cfce91d](https://github.com/morluto/rea/commit/cfce91d418fbcde4a9ef283a61549279751854e7))
* **ci:** scope verification and reuse native runners ([#1344](https://github.com/morluto/rea/issues/1344)) ([d5cb8ae](https://github.com/morluto/rea/commit/d5cb8aee063065a48233458e04771635167825c8))
* **cli:** avoid duplicate primary cleanup diagnostics ([37fcea7](https://github.com/morluto/rea/commit/37fcea78cecbeeadd869e9a3d77dd133ed264a0a))
* **cli:** classify JSON input permission denials ([08daf05](https://github.com/morluto/rea/commit/08daf056cc8e4d092f9592574d09d5182457b7bc))
* **cli:** classify oversized JSON inputs ([f7cf4c8](https://github.com/morluto/rea/commit/f7cf4c890d4b9c70b1f56e6c627b44a59e58fd73))
* **cli:** stream JSON inputs beyond the whole-document string limit ([#1360](https://github.com/morluto/rea/issues/1360)) ([6ce3288](https://github.com/morluto/rea/commit/6ce3288f3bd65a886e47905455ed5c9b661015e6)), closes [#1331](https://github.com/morluto/rea/issues/1331)
* **cli:** stream JSON results at the shared command boundary ([810107a](https://github.com/morluto/rea/commit/810107a2ad15cc52afd6662aec24d231d8c77225))
* **contracts:** advertise NUL with a portable hex escape ([3f59a84](https://github.com/morluto/rea/commit/3f59a84bd1039763bb349894542601ed78be2033)), closes [#1329](https://github.com/morluto/rea/issues/1329)
* **contracts:** require observed provider output metadata ([a4ba8ae](https://github.com/morluto/rea/commit/a4ba8aecd507637b6261026afc17f79516840d50))
* **electron:** preserve unrepresentable numeric option evidence ([41a228c](https://github.com/morluto/rea/commit/41a228c1b01a89127858b1706879ede08a81deaf))
* **evidence:** order canonical projections independently of locale ([614fb76](https://github.com/morluto/rea/commit/614fb7681ee9e4eba7219c1ee9e90d6a85d78095))
* **files:** reject nonregular capture and JSON inputs ([5f16124](https://github.com/morluto/rea/commit/5f16124a31fa4a82bd03037506809d6be959d768))
* **filesystem:** reject unstable artifact targets ([7829b1a](https://github.com/morluto/rea/commit/7829b1aeef8f43f186be2d2adbd6c67541306a7a))
* **ghidra:** reject a native decompiler built for another host ([#1280](https://github.com/morluto/rea/issues/1280)) ([3728c82](https://github.com/morluto/rea/commit/3728c8267b4fb6da78cbae42a2a6cbddff80ea84)), closes [#1192](https://github.com/morluto/rea/issues/1192)
* **ghidra:** retain process ownership after failed launch rollback ([07675f7](https://github.com/morluto/rea/commit/07675f78c66ce9e8706e808d417265e18ba9f3a5))
* **ghidra:** verify dense jump tables on an optimized fixture ([#1374](https://github.com/morluto/rea/issues/1374)) ([73a664b](https://github.com/morluto/rea/commit/73a664bc78ee618045a2733b8714821281f77403))
* **hopper:** allow restart after verified owned-provider shutdown ([1c12349](https://github.com/morluto/rea/commit/1c123493a21cc579ba7532c40e7ef30df45db3e8))
* **hopper:** probe interior navigation from multi-byte instructions ([#1285](https://github.com/morluto/rea/issues/1285)) ([bf934d5](https://github.com/morluto/rea/commit/bf934d5592e707ba5e7769043de3a430ed8d4923))
* **ida:** compare admitted document paths consistently ([890bb66](https://github.com/morluto/rea/commit/890bb66b35d5f9f8ee54ff0049bf7dc7b82b2480))
* **javascript:** avoid positive-zero evidence for signed zero ([9055bd6](https://github.com/morluto/rea/commit/9055bd695b75f72fb1b8a538d1485d30c0b0ee0b))
* **javascript:** decline source-map UNC references with an unusable host ([#1372](https://github.com/morluto/rea/issues/1372)) ([f504c2a](https://github.com/morluto/rea/commit/f504c2a351027f17ac353fba2d7cfc3505ee17d6))
* **javascript:** distinguish prefix-only builtins from packages ([2b4abbf](https://github.com/morluto/rea/commit/2b4abbf1ccb6dd6ad1248cf48e381df0842542c1))
* **javascript:** honor module-sync package exports ([#1361](https://github.com/morluto/rea/issues/1361)) ([d0e6069](https://github.com/morluto/rea/commit/d0e606930acb701790c286340226b1e3e7060b4f))
* **javascript:** parse declaration artifacts in ambient mode ([4896adc](https://github.com/morluto/rea/commit/4896adcd0f9316034e83129685ed3807ade6f3ea))
* **javascript:** preserve agreeing module provenance ([db171be](https://github.com/morluto/rea/commit/db171be6e570fd1261a30d711e4da2d17de85a93))
* **javascript:** preserve capture-time guards and ordering ([001851f](https://github.com/morluto/rea/commit/001851fde6f972e6ebd01fddccdff4c645a85f63))
* **javascript:** preserve semantic evidence through satisfies ([e995b19](https://github.com/morluto/rea/commit/e995b19f834ba78faa294f5959fd3ad8a97290ca))
* **javascript:** preserve uncertainty after references escape to calls ([#1292](https://github.com/morluto/rea/issues/1292)) ([355a292](https://github.com/morluto/rea/commit/355a292198bf58245c67ae315fdb4f77e62769cc))
* **javascript:** reject invalid package exports configurations ([7a4f268](https://github.com/morluto/rea/commit/7a4f2685d41b134507331c322f0f5da8e1f6c3f4))
* **javascript:** resolve exported callables through lexical bindings ([#1351](https://github.com/morluto/rea/issues/1351)) ([a9f5dad](https://github.com/morluto/rea/commit/a9f5dad5a8f196c88f6305d8d958b355cc0b52c2))
* **javascript:** resolve query-only HTML references to their document ([55a46f7](https://github.com/morluto/rea/commit/55a46f7c7176075c9edda4fe61ed995f2ceadf6a))
* **javascript:** retain array identity after length mutations ([4bcea1a](https://github.com/morluto/rea/commit/4bcea1aa76e3e7ca665197181739c5e27a62c40a))
* **javascript:** retain conditional mutation ordering uncertainty ([b8a8190](https://github.com/morluto/rea/commit/b8a8190b2f30e377eee2d69d1ba31ea454fa70b9))
* **javascript:** retain distinct module provenance path components ([2bd7de6](https://github.com/morluto/rea/commit/2bd7de6f8ca62fc1d48334cfa7fdced461b7b153))
* **javascript:** retain unresolved value frontiers in provenance queries ([3e19875](https://github.com/morluto/rea/commit/3e19875c7fa9c61cff655bbe6046ddc4ab558533))
* **javascript:** store source map URLs once ([ed8fcae](https://github.com/morluto/rea/commit/ed8fcae94b699b62b44162f880faa077a36c455d))
* **json:** preserve runtime limits across JSON file readers ([#1350](https://github.com/morluto/rea/issues/1350)) ([9c4a68b](https://github.com/morluto/rea/commit/9c4a68bc19a0f7d39557e3cc039f5877f6550f63))
* **managed:** bind graph facts to their source Evidence ([cc7b5af](https://github.com/morluto/rea/commit/cc7b5af0777fc68ebba10ec061244729ebf2357d))
* **mcp:** admit composed analysis through result bookkeeping ([e11f4d3](https://github.com/morluto/rea/commit/e11f4d371abaa8cb65ebf7b94fa216329fd78d88))
* **mcp:** advertise object roots for union input schemas ([#1373](https://github.com/morluto/rea/issues/1373)) ([39dabd0](https://github.com/morluto/rea/commit/39dabd0608ed9617d60f16ece05993089f24ff38))
* **mcp:** advertise primitive semantic literal seeds ([f62b449](https://github.com/morluto/rea/commit/f62b44971deee0e99df6fcf32758c8e5592400ed))
* **mcp:** preserve JavaScript workflow identity validation ([#1366](https://github.com/morluto/rea/issues/1366)) ([53ed942](https://github.com/morluto/rea/commit/53ed942a85f51ff9f0e4f01cbb53359df476071d)), closes [#1364](https://github.com/morluto/rea/issues/1364) [#1065](https://github.com/morluto/rea/issues/1065)
* **mcp:** retry failed shutdown resources and retain failure reasons ([e64678e](https://github.com/morluto/rea/commit/e64678e8f9768dd819d8f5f12cc844a6660ff2c5))
* **native:** distinguish symbol definitions from metadata ([70bad53](https://github.com/morluto/rea/commit/70bad53847b0e14489acee73d204ff645e1adfcd))
* **native:** preserve unknown Objective-C metadata ([b112d44](https://github.com/morluto/rea/commit/b112d44a3961939881779c81a57e7a3f9d1372f7))
* **native:** refuse to list architectures of non-Mach-O targets ([#1325](https://github.com/morluto/rea/issues/1325)) ([1b73b5a](https://github.com/morluto/rea/commit/1b73b5ab4bc75bd424e643de8e49f142ffa2b336))
* **native:** retain LLDB cleanup ownership through client close ([7ad353f](https://github.com/morluto/rea/commit/7ad353fa8b3f07e14face80336678d23cc7c6507))
* **process:** keep unobserved file contents unknown ([#1358](https://github.com/morluto/rea/issues/1358)) ([f91f279](https://github.com/morluto/rea/commit/f91f2798b4dc6adb61b3ffe28a24a5d55adbd6ff))
* **process:** retain per-file digest open failures ([415145d](https://github.com/morluto/rea/commit/415145d04f09a15cbfb7dda8ea9dc363a77f9bf0))
* **reference:** report malformed UTF-8 before import parsing ([f166a2a](https://github.com/morluto/rea/commit/f166a2ae15b072216173a51a8f5cad930a858366))
* report malformed application evidence as input errors ([218c131](https://github.com/morluto/rea/commit/218c13160ec0ed7116d6633fc76559ec39dae4d7))
* retain completed observations when later analysis steps fail ([35f121f](https://github.com/morluto/rea/commit/35f121f4acac821e848c485fb82a2c42f51f6ea1))
* **setup:** install the skill for Claude Code ([b4a1919](https://github.com/morluto/rea/commit/b4a19193fe3baf9075f8ac419517021ea0c71ea3))
* **setup:** recognize supported Nobara hosts ([f0dc233](https://github.com/morluto/rea/commit/f0dc233d64de4c215c453c346e516b7622713e95))
* **skill:** pin packaged commands to the shipping package version ([2793672](https://github.com/morluto/rea/commit/2793672ee2a575f97a8011c7fec5288098cdd5d1))
* **skill:** pin packaged commands to the shipping package version ([#1346](https://github.com/morluto/rea/issues/1346)) ([f39e71c](https://github.com/morluto/rea/commit/f39e71ce1897bb5c704b33a8b0049567f11e3a13))
* **snapshot:** preserve complete investigation revision histories ([#1354](https://github.com/morluto/rea/issues/1354)) ([1c0cc8a](https://github.com/morluto/rea/commit/1c0cc8a6753b5ac781b28ebb1832f3a6a1771a68))
* **targets:** cancel resolution before provider admission ([f3c4a33](https://github.com/morluto/rea/commit/f3c4a332f7bd198bd67f0187bc2a85c7b31bb960))
* **update:** preserve disabled client registrations ([abf5e24](https://github.com/morluto/rea/commit/abf5e243c4d2cae03404b6e1fb1ccc77be917b53))


### Performance Improvements

* **javascript:** index version relationships once per comparison ([#1347](https://github.com/morluto/rea/issues/1347)) ([b1e85ad](https://github.com/morluto/rea/commit/b1e85ad711743a594c572dbd5b0d5cb664e2a502))
* **javascript:** validate the version change graph once ([#1370](https://github.com/morluto/rea/issues/1370)) ([037709a](https://github.com/morluto/rea/commit/037709a52c0824f4d2bbee90d8e2642b2d88d364))
* **json:** encode streamed JSON iteratively ([#1322](https://github.com/morluto/rea/issues/1322)) ([56598be](https://github.com/morluto/rea/commit/56598beb4e82968a313deb9efdf4b98db5bd1f4f))


### Code Refactoring

* use canonical implementations and types directly ([765e809](https://github.com/morluto/rea/commit/765e809e366eff21b4b9c224f1a813ad64245ea3))
* **artifacts:** remove unused root classifier ([5291bca](https://github.com/morluto/rea/commit/5291bca108af781214572fac709f9808bb8aa4db))
* **artifacts:** test inventory changes at materialization boundary ([750fb65](https://github.com/morluto/rea/commit/750fb6565052e9eaad40b946b6a284d0730d14f8))
* **browser:** open scenario sessions without a factory wrapper ([d1983a4](https://github.com/morluto/rea/commit/d1983a45767bfcdc020652f48109a78a3f9fa590))
* **catalog:** import CLI metadata from its owner ([8c96baa](https://github.com/morluto/rea/commit/8c96baab80dc258d31ca1632d761fffb11dbaaae))
* consolidate boundary semantics and prune redundant tests ([392f1f3](https://github.com/morluto/rea/commit/392f1f310733f2c365da7bc57a1154cf10ec4ba0))
* **javascript:** normalize erased expression syntax once ([b628bba](https://github.com/morluto/rea/commit/b628bba1fa65fd3b51363bf4b745f0afc57e1dba))
* **javascript:** parse runtime evidence into one verified owner ([006b295](https://github.com/morluto/rea/commit/006b295f1de19fd5351832cf52d98a202a5cd5cd))
* **javascript:** remove obsolete scope truncation statistic ([449d570](https://github.com/morluto/rea/commit/449d57075eec71b2f064af8877c50cbbde30a283))
* **javascript:** share Babel child traversal ([0f10499](https://github.com/morluto/rea/commit/0f10499245ec2fab8823f116caf34450b3a7385b))
* **javascript:** share semantic evidence at fact construction ([e3bbb9a](https://github.com/morluto/rea/commit/e3bbb9ac453da8d15f3b32511180451613710616))
* **process:** remove duplicate observation and trace entry points ([070339a](https://github.com/morluto/rea/commit/070339af50a50a0f23e82db859e761c53277ee79))
* **providers:** use canonical artifact and managed identities ([87f0051](https://github.com/morluto/rea/commit/87f0051496aff1b05ab24d6b63f79884f4ca9b8f))
* **reference:** simplify malformed UTF-8 handling ([377df71](https://github.com/morluto/rea/commit/377df715ea5b2523cd6c1084fdc286eb8a056182))
* remove obsolete source exclusions and identity wrapper ([44c92f8](https://github.com/morluto/rea/commit/44c92f88c51841735741811a68cc89fde14efa80))
* remove single-use forwarding helpers ([4144e45](https://github.com/morluto/rea/commit/4144e454f385c372d29e301e6bb959092c606a6e))


### Documentation

* keep license sections text-only ([e10f1f0](https://github.com/morluto/rea/commit/e10f1f0901fa56fb4443837cf9528b31a12e140e))
* align translated README artwork and layout ([ccfbe87](https://github.com/morluto/rea/commit/ccfbe87e984e456e12c66d0d2fe6d5a559d09518))
* add README artwork and refine closing sections ([4b8e744](https://github.com/morluto/rea/commit/4b8e744d90579e353371649047215c4e4be7a5f6))
* add repository-local REA tool design skill ([7738c1f](https://github.com/morluto/rea/commit/7738c1f6a9ccf1ec9868ef832f154abe9ba5eebd))
* celebrate 40,000 GitHub stars 🎉 ([3edb217](https://github.com/morluto/rea/commit/3edb2172def0e0bd9076f23148f0c41cd2f341a3))
* celebrate 40,000 GitHub stars 🎉 ([5ecc98a](https://github.com/morluto/rea/commit/5ecc98a5eac4c10d33e9c418b9ffae61c68e3ef2))
* consolidate agent guidance around ownership and boundaries ([ba44222](https://github.com/morluto/rea/commit/ba4422296dc409d49836f25642555e00463bfe3b))
* **contracts:** explain canonical URL and skill metadata ownership ([e36afa1](https://github.com/morluto/rea/commit/e36afa112fd7b7ab5a925ca452de93b68f12a6ab))
* correct MCP error and capture import guidance ([077d6c4](https://github.com/morluto/rea/commit/077d6c407b3ea7443a7277ae0e5531b3927dd742))
* correct README setup and runtime guidance ([5b3715e](https://github.com/morluto/rea/commit/5b3715ef825a30150b02d3f1bb7d40dd89453018))
* explain CI scope and native runner reuse ([#1348](https://github.com/morluto/rea/issues/1348)) ([6c9161d](https://github.com/morluto/rea/commit/6c9161d61745e242643f224ce49e7468143a15f3))
* prune repeated contributor and tool design instructions ([5d79387](https://github.com/morluto/rea/commit/5d79387505ebae1ec8d800ee3ffd901920a9d8be))
* remove retired architecture and migration artifacts ([7a0c800](https://github.com/morluto/rea/commit/7a0c80085128e6329ca2e4f54f3539f3245c57d1))


### Tests

* share the client registration command to restore the jscpd gate ([#1317](https://github.com/morluto/rea/pull/1317)) ([5d16be2](https://github.com/morluto/rea/commit/5d16be2a7185db8b70a5fcbc5f5e1be63297f2c8))
* **mcp:** remove arbitrary schema inventory thresholds ([24673aa](https://github.com/morluto/rea/commit/24673aaae497ca4ef0902544c0cd69817f5424ed))
* **android:** allow provider readiness under load ([961c3c3](https://github.com/morluto/rea/commit/961c3c3de79ec44d608d011eb3fa3d6bd645cf6a))
* **artifacts:** verify extraction races with real filesystem changes ([1ac8389](https://github.com/morluto/rea/commit/1ac8389c5c1f75faf8d7f2f3faf2f24febad5fea))
* **browser:** avoid duplicating source-map listener setup ([9367dc1](https://github.com/morluto/rea/commit/9367dc13bd8d2732d36d5376b5de170c9f4af424))
* **browser:** report redirect status cases independently ([5a61562](https://github.com/morluto/rea/commit/5a61562dc200120c7b8020854085c17b8203e95d))
* **cli:** remove duplicate malformed JSON assertion ([5d32e42](https://github.com/morluto/rea/commit/5d32e4252941e93065cadd83b9f02aa6427544d8))
* exercise source test selection through Git and Vitest ([25711ad](https://github.com/morluto/rea/commit/25711ad2590af136dfb301839dddd6d30971ba76))
* **filesystem:** bound FIFO regressions at consumers ([0bfb6e0](https://github.com/morluto/rea/commit/0bfb6e00abae1e67a96e548d64954bb21861f621))
* **ghidra:** allow rollback tests to reach spawned process ([d761d73](https://github.com/morluto/rea/commit/d761d7358b45fe0724b182a206241fd605f338b0))
* **javascript:** share primitive expansion producer fixtures ([c867bcd](https://github.com/morluto/rea/commit/c867bcd0aadd63473865f9a328459e0db3c89565))
* **javascript:** share semantic graph test facts ([ac356c4](https://github.com/morluto/rea/commit/ac356c46ad6a17c8864bc5d350984786db62d2f5))
* **javascript:** verify distinct module origins through reconstruction ([96b2b24](https://github.com/morluto/rea/commit/96b2b245fdefc9c78f5dcf6ce054232b51f7c117))
* **json:** remove assertions covered by CLI output consumers ([a959a83](https://github.com/morluto/rea/commit/a959a8309db79fbee6477efd7ee541615e625627))
* **managed:** include shared dossier fixture in artifact inputs ([66a20a2](https://github.com/morluto/rea/commit/66a20a2597b5daebc0a292361aa62a78b7df6e7d))
* **native:** retain trace diagnostics when observed hits differ ([048b798](https://github.com/morluto/rea/commit/048b79878c70c594789909082499dc675472b63a))
* **package:** share validated native dossier fixtures ([ca90109](https://github.com/morluto/rea/commit/ca9010936a934a49fbc6cf69eb1d7fc2242b6da9))
* **process:** publish capture readiness atomically ([74be526](https://github.com/morluto/rea/commit/74be52611e66f680ef1919d521fc3c304bc2326e))
* **process:** report cleanup details on cancellation failures ([79d5b9a](https://github.com/morluto/rea/commit/79d5b9a826b9204c1ef59b0a5c5ec83e7a2f2bec))
* **process:** use owned CLI and workspace fixtures ([4940a86](https://github.com/morluto/rea/commit/4940a867e2e56cbb974bfa321008a8f35db47d52))
* share snapshot replay and managed graph fixtures ([d83cbd2](https://github.com/morluto/rea/commit/d83cbd2abf1bbf15beef990f5353457fdbaaeb8e))


### Continuous Integration

* enforce architecture guards with portable checkout paths ([ecc67ca](https://github.com/morluto/rea/commit/ecc67cab2d85cacda245890ffe84b80ac395d79e))

## [6.2.0](https://github.com/morluto/rea/compare/rea-agents-6.1.0...rea-agents-6.2.0) (2026-10-09)


### ⚠ BREAKING CHANGES

Read the [6.1 to 6.2 migration guide](docs/migrations/migration-6.2.md) before upgrading. REA's `always-bump-minor` policy includes breaking changes; 6.2 is not a backward-compatibility promise. Preserve original saved files and regenerate missing observations rather than fabricating identities or facts.

* **MCP / Evidence / snapshots / artifacts:** Success results are direct canonical Evidence; read `normalized_result` rather than the old `result`/`evidence` wrapper. Evidence requires nullable `analysis_profile`, session provider aliases are removed, snapshots require complete profile-bound query records, and artifact roles/permissions belong to occurrences. Recreate incompatible saved data; adding fields without recomputing their semantic identity is invalid. ([63bf914](https://github.com/morluto/rea/commit/63bf91405cf97b114a84f337fb1272d98a267999))
* **Process captures:** Legacy v3 conversion is removed. Explicit executable identity and `event_journal` are required; retain old captures and recapture when current comparisons are needed instead of inventing launch identity or event order. ([2a77469](https://github.com/morluto/rea/commit/2a7746998d47446c4db6d4f524e0f183d6803f3f))
* **Cleanup and evaluation:** A one-shot analysis reports cleanup failure while preserving the completed observation or primary diagnostic. Handle `cleanup_incomplete` and retained observations/resources. Configured agent-evaluation fixtures require Evidence-backed correctness, not routing or answer wording alone. ([#1211](https://github.com/morluto/rea/pull/1211), [27a9cea](https://github.com/morluto/rea/commit/27a9ceade7232c1c9a24dc7d454ae060948183a1))
* **JavaScript:** Return-field projections require explicit presence; export-shape changes carry both sides' presence and property inventory coverage. Semantic object operations retain complete `property_path` segments. Regenerate old analysis and distinguish unknown values from unknown presence. ([475a0f8](https://github.com/morluto/rea/commit/475a0f84dac63d710e032bc7f731c1a3bda624ec))
* **Function comparisons:** Remove the unreachable `truncated` dimension state and `summary.truncated` counter; update enum and display consumers while retaining explicit `unknown` facts. ([5510b27](https://github.com/morluto/rea/commit/5510b27d7f863a3df26212fba4a59f8df0da3712))
* **Historical sources:** Unreadable/unknown symlink targets require `target: null`; external targets retain the observed absolute target. Reimport graphs containing display placeholders such as `<outside-root>` and handle nullable targets. ([b7b4333](https://github.com/morluto/rea/commit/b7b433370310c3ffe33d5027d8393151d5e862da))

### Features

* **javascript:** report observed export property presence ([#1160](https://github.com/morluto/rea/issues/1160)) ([45e3edc](https://github.com/morluto/rea/commit/45e3edc17f48954c89d8db86f7313c479bd39344))
* **mcp:** select views of retained analysis results ([#1180](https://github.com/morluto/rea/issues/1180)) ([db675f1](https://github.com/morluto/rea/commit/db675f1d52acda62b6f57b5a8773532f49b259e7))
* **website:** add an Aegis APK code-generation showcase ([0270dd5](https://github.com/morluto/rea/commit/0270dd5739480acced62e045b5890ec0ebde2631))
* **website:** add an Android showcase and clearer project prompts ([6cc817e](https://github.com/morluto/rea/commit/6cc817e8bd377b064b3568ef1eacb27eaefcb4c1))
* **website:** add beginner examples and synchronized publishing ([0fec65d](https://github.com/morluto/rea/commit/0fec65d06b2f5431e704c472e53015d4b3cc967c))
* **website:** add beginner examples and synchronized publishing ([#1203](https://github.com/morluto/rea/issues/1203)) ([0fec65d](https://github.com/morluto/rea/commit/0fec65d06b2f5431e704c472e53015d4b3cc967c))
* **website:** add Discord link beside GitHub badge ([cc39fc5](https://github.com/morluto/rea/commit/cc39fc53b829a349ae199823472990a53014c507))
* **website:** add homepage navigation and faster reading paths ([863674b](https://github.com/morluto/rea/commit/863674b2e92dd7c699768db82d521ccc88b7ebe4))
* **website:** add homepage navigation and faster reading paths ([c94f06d](https://github.com/morluto/rea/commit/c94f06d98f895eb8b6c5ffa5e999ef1d4bb5eea2))
* **website:** add homepage navigation and faster reading paths ([#1213](https://github.com/morluto/rea/issues/1213)) ([863674b](https://github.com/morluto/rea/commit/863674b2e92dd7c699768db82d521ccc88b7ebe4))
* **website:** add search metadata and automatic sitemap ([99f257b](https://github.com/morluto/rea/commit/99f257bbf03c27327e5e0a232fefd3c792acd5bc))
* **website:** add search metadata and automatic sitemap ([b8851cb](https://github.com/morluto/rea/commit/b8851cb977cfdd608798d32bf5877f645b960831)), closes [#1283](https://github.com/morluto/rea/issues/1283)
* **website:** clarify reverse engineering and showcase goals ([e750c26](https://github.com/morluto/rea/commit/e750c262fbf37100369ab25bf8659daa1a2c4cc7))
* **website:** explain REA through a first investigation ([5160d9b](https://github.com/morluto/rea/commit/5160d9b717d0207a357c754bdf72e215e59d19d1))
* **website:** explain REA with Calculator and a playable dinosaur lab ([11b9f03](https://github.com/morluto/rea/commit/11b9f0346cf5413045b41ff552a024e11ba46ccc))
* **website:** lead with the playable dinosaur example ([19c52f5](https://github.com/morluto/rea/commit/19c52f5e3f42fb754fc154bbd16552c5111df0c5))
* **website:** show manual analysis beside a one-prompt workflow ([291bc6f](https://github.com/morluto/rea/commit/291bc6fb70f47d28d23440f03a8a7fa49eb9a391))


### Bug Fixes

* **dev:** accept formatter-ignored staged documentation without failing the commit hook; malformed JSON remains rejected. ([bd2db2f](https://github.com/morluto/rea/commit/bd2db2f0fa495fb08dea443cd16d7683d4b86e6a))

* **release:** publish reviewed release-PR merges from their exact reviewed source. ([c12bad7](https://github.com/morluto/rea/commit/c12bad7f139431fc0db7a8b7c9db1eab95f96dc2))

* **android:** support owned JADX stdio on Windows ([#1276](https://github.com/morluto/rea/issues/1276)) ([636b245](https://github.com/morluto/rea/commit/636b245f1badf2a7ecfa63c6e2378ac2f7673cc3)), closes [#1262](https://github.com/morluto/rea/issues/1262)
* **android:** validate engine archive prerequisites ([#1145](https://github.com/morluto/rea/issues/1145)) ([e9ebfb9](https://github.com/morluto/rea/commit/e9ebfb94eff0699b1ea84bba000c4467fa1cb998))
* **apple:** report unusable dylib-resolution roots as invalid input ([6a1e558](https://github.com/morluto/rea/commit/6a1e558db3ec2b69561e91ea817f1c2065dfc676))
* **apple:** report unusable dylib-resolution roots as invalid input ([24a30fd](https://github.com/morluto/rea/commit/24a30fd91c144b7f2533e5f5de8c91268773519c))
* **artifacts:** keep cancellation and the caller path in extraction refusals ([37025cc](https://github.com/morluto/rea/commit/37025cc09f12d49f46e61eedc3564c710089146b))
* **artifacts:** keep cancellation and the caller path in extraction refusals ([eacf846](https://github.com/morluto/rea/commit/eacf8461dad6bab11a3d5438e6db001a10f33a9b))
* **artifacts:** match lipo arm64e variant names to their FAT slices ([de5bfec](https://github.com/morluto/rea/commit/de5bfec79fe862816350b2deeb42a12c0734d855))
* **artifacts:** match lipo arm64e variant names to their FAT slices ([0b32577](https://github.com/morluto/rea/commit/0b32577a90aef97e36adf2a7af4f3eccd5d82357)), closes [#1168](https://github.com/morluto/rea/issues/1168)
* **artifacts:** name only host-available workflows for non-archive plists ([f4c99ab](https://github.com/morluto/rea/commit/f4c99ab8a53806dd57dc24b3d5a600905bcb4686))
* **artifacts:** name only host-available workflows for non-archive plists ([2295855](https://github.com/morluto/rea/commit/22958558eafdfccf71a7d5bbbcf360574a6b2e3c))
* **artifacts:** recheck failed DMG detaches before reporting cleanup failure ([#1155](https://github.com/morluto/rea/issues/1155)) ([58a91f0](https://github.com/morluto/rea/commit/58a91f03d72162849991caf537ab058ccc918594))
* **artifacts:** refuse unsupported extraction formats before scanning ([8e74c9c](https://github.com/morluto/rea/commit/8e74c9c62fb44556b90f20bb6c12771ac05a18f2))
* **artifacts:** report encrypted archive entries as unsupported extraction ([de43da7](https://github.com/morluto/rea/commit/de43da71ae982dd0f3d7b5ae49c914729db3a6ec))
* **artifacts:** report non-archive keyed-archive selections as unsupported targets ([fef38e4](https://github.com/morluto/rea/commit/fef38e4d22ee859ec43fb591d53e8b9973c69958))
* **artifacts:** report non-archive keyed-archive selections as unsupported targets ([8c5088c](https://github.com/morluto/rea/commit/8c5088c8cdf32a9f96f6c479c6e70a71fa360168))
* **artifacts:** report wrong target kinds as unsupported targets ([b34bdcd](https://github.com/morluto/rea/commit/b34bdcdb2877be394c59c9cbf70269dc1841ff78))
* **artifacts:** report wrong target kinds as unsupported targets ([637bcb5](https://github.com/morluto/rea/commit/637bcb5e4182b6c60e922b18688642d8e1008e90))
* **browser:** classify export-web-scripts capture selection failures by cause ([ddaa183](https://github.com/morluto/rea/commit/ddaa18301ab9c67e7a6f7ce66076075e8a4d5017))
* **browser:** classify export-web-scripts capture selection failures by cause ([8c5e34c](https://github.com/morluto/rea/commit/8c5e34cd379392ca40f651ca5eeb6a947b44aa33))
* **browser:** report Windows HAR heap exhaustion ([#1147](https://github.com/morluto/rea/issues/1147)) ([1393507](https://github.com/morluto/rea/commit/13935077ba039f6e342f9c11ab5eea935a335ae6))
* **browser:** retain scenario observations across failures ([614e0c2](https://github.com/morluto/rea/commit/614e0c2e74819bb5e3ef3d2e16ff31ee6cab76ae))
* **browser:** retain scenario resources until cleanup succeeds ([88640f6](https://github.com/morluto/rea/commit/88640f60fe566edbe2320688df62c7ef46c4c61c))
* **ci:** pass selected environment to Windows Ghidra fixture ([#1281](https://github.com/morluto/rea/issues/1281)) ([f085589](https://github.com/morluto/rea/commit/f085589957922eaf421db814399e88e415712050))
* **cli:** advertise defaulted inputs as optional in --schema and help ([#1175](https://github.com/morluto/rea/issues/1175)) ([b4927a0](https://github.com/morluto/rea/commit/b4927a0a4fa7e8935b101d214b396bfa78208281)), closes [#1169](https://github.com/morluto/rea/issues/1169)
* **cli:** cancel routed JavaScript analysis in rea analyze ([#1156](https://github.com/morluto/rea/issues/1156)) ([089bbf5](https://github.com/morluto/rea/commit/089bbf58f3561e3f465c544bbcf8c307287b1256))
* **cli:** complete cleanup after relayed interrupts ([#1202](https://github.com/morluto/rea/issues/1202)) ([911152a](https://github.com/morluto/rea/commit/911152a04d3aeb0d361141a8d54959009b269e49))
* **cli:** list the read failure cause for an unreadable JSON input file ([db0afce](https://github.com/morluto/rea/commit/db0afce5f344268271c59acee04e96f986c5619a))
* **cli:** list the read failure cause for an unreadable JSON input file ([6020df5](https://github.com/morluto/rea/commit/6020df53d9cd44845cf3b6b416db2d7802925578))
* **cli:** resolve xrefs symbol selectors after address validation ([#1209](https://github.com/morluto/rea/issues/1209)) ([7e9c911](https://github.com/morluto/rea/commit/7e9c91199ecd133d26a51cb33b6e63e1f942df7e))
* **config:** name the rejected setting and its constraint in configuration errors ([c3acc34](https://github.com/morluto/rea/commit/c3acc34475ca22387ea674839acfa1891b0b9f66))
* **config:** name the rejected setting and its constraint in configuration errors ([0a0244d](https://github.com/morluto/rea/commit/0a0244db4212bc1f59dec4b925fa90b3b473136a)), closes [#1184](https://github.com/morluto/rea/issues/1184)
* **doctor:** find the Homebrew Hopper cask without writing Homebrew caches ([98b07d0](https://github.com/morluto/rea/commit/98b07d07ddd20bea2c3bdf8d55ac2776a263bcf4))
* **doctor:** find the Homebrew Hopper cask without writing Homebrew caches ([a503376](https://github.com/morluto/rea/commit/a503376b2f9d9ba14d1602e58e0e93059e9d9181)), closes [#1165](https://github.com/morluto/rea/issues/1165)
* **domain:** report target read-permission denials as access_denied ([f36c10f](https://github.com/morluto/rea/commit/f36c10f9e8dc45a298d668e608f8e945bde487cf))
* **domain:** report target read-permission denials as access_denied ([d0ff57a](https://github.com/morluto/rea/commit/d0ff57a45c8da8938e7ae16d00bfd5ec63310af3)), closes [#1188](https://github.com/morluto/rea/issues/1188)
* **electron:** resolve effective preload after option overrides ([#1286](https://github.com/morluto/rea/issues/1286)) ([411498d](https://github.com/morluto/rea/commit/411498d45f860eba2fbc9d7051af20237b7a4cb1))
* emit v-mode-compatible patterns for tool schemas ([#1220](https://github.com/morluto/rea/issues/1220)) ([f0da05f](https://github.com/morluto/rea/commit/f0da05f67fff1411cf2f7a48a752ee7b348c71ff))
* **errors:** report caller-selected evidence path failures as invalid input ([d4a598e](https://github.com/morluto/rea/commit/d4a598e93649607dd293a9c81bbf79c211bc8dd4))
* **errors:** report caller-selected evidence path failures as invalid input ([db177c9](https://github.com/morluto/rea/commit/db177c91b83adb0c3edc4f9f6f06e31ac7523d53))
* **evidence:** cancel exports before atomic publication ([16624f1](https://github.com/morluto/rea/commit/16624f1324e156d14025b2c346596c9781c07488))
* **ghidra:** classify modern Swift manglings in swift type analysis ([#1208](https://github.com/morluto/rea/issues/1208)) ([6935dc7](https://github.com/morluto/rea/commit/6935dc7fe1258b340bb9cdfb8cecae66ef7bc0d4))
* **ghidra:** do not run Java from a relative JAVA_HOME in doctor and setup ([04a516b](https://github.com/morluto/rea/commit/04a516b1e369f7e57e08d0653cc08292ac497e07))
* **ghidra:** do not run Java from a relative JAVA_HOME in doctor and setup ([c3f1698](https://github.com/morluto/rea/commit/c3f169823f690371ecfdd2d1b3b07a5749438cf1))
* **ghidra:** keep and name a runtime directory that close could not remove ([5b769d3](https://github.com/morluto/rea/commit/5b769d3a781c645ed8885e4fabf01a00f0bbc89b))
* **ghidra:** keep and name a runtime directory that close could not remove ([b79d379](https://github.com/morluto/rea/commit/b79d379c25bcc8ed61571c41a94b912b5704a067)), closes [#1190](https://github.com/morluto/rea/issues/1190)
* **ghidra:** keep the NativeAOT target refusal's own recovery advice ([f198993](https://github.com/morluto/rea/commit/f198993f418e6aaa9755e7e6413abcb27c6cd684))
* **ghidra:** preserve decoded return flow evidence ([b189c3c](https://github.com/morluto/rea/commit/b189c3ceb175dd9fa089eada9e9ca54e76307cb3))
* **ghidra:** preserve decoded return flow evidence ([bcc8a77](https://github.com/morluto/rea/commit/bcc8a773e2a714e4899755b786a4fef1539bbace))
* **ghidra:** reject relative installation and Java paths in doctor and setup ([8998438](https://github.com/morluto/rea/commit/8998438c23aa19e68f4ffa7574c5d341aa419165))
* **ghidra:** reject relative installation and Java paths in doctor and setup ([5356856](https://github.com/morluto/rea/commit/53568568bf32b36274ba3a532f1e2cfb2daed271)), closes [#1183](https://github.com/morluto/rea/issues/1183)
* **ghidra:** report NativeAOT host and target refusals as unsupported, not failures ([cfb49eb](https://github.com/morluto/rea/commit/cfb49eb8a88fc51f460907024c51e05a2f272502))
* **ghidra:** report NativeAOT host and target refusals as unsupported, not failures ([42c276a](https://github.com/morluto/rea/commit/42c276af1ec02473a7b6700a31292aae9e53d53e)), closes [#1185](https://github.com/morluto/rea/issues/1185)
* **ghidra:** resolve secondary symbols at function entries ([#1195](https://github.com/morluto/rea/issues/1195)) ([6fbdbd6](https://github.com/morluto/rea/commit/6fbdbd682038d012b04f0fe92c470cf1789fb101))
* **ghidra:** stop dereferencing the removed error payload in address verification ([b80bd2d](https://github.com/morluto/rea/commit/b80bd2db966731fd3cfddfff7e92704053dbe955))
* **ghidra:** stop dereferencing the removed error payload in address verification ([59fbaa2](https://github.com/morluto/rea/commit/59fbaa2d33359216534407f99f49705ac04a3426))
* **ghidra:** use dot-free private session paths ([c3fc6c3](https://github.com/morluto/rea/commit/c3fc6c3aedc202e8ade015c4039a63e9f91cac6d))
* **hopper:** keep the OS error when the FAT64 source cannot be reopened ([9f5dc52](https://github.com/morluto/rea/commit/9f5dc52be8420fb5e874595d63312bf80d07a3a2))
* **hopper:** reserve Linux demo application before launch ([#1158](https://github.com/morluto/rea/issues/1158)) ([33d5ae0](https://github.com/morluto/rea/commit/33d5ae0b52b8684634ecf14d4e9469968c69d462))
* **javascript:** allow cancellation during semantic graph commitment ([#1218](https://github.com/morluto/rea/issues/1218)) ([9405bd6](https://github.com/morluto/rea/commit/9405bd660def9946afaa5fcc1d99921a816911bf))
* **javascript:** classify application input selection failures by cause ([fe5291e](https://github.com/morluto/rea/commit/fe5291e9166977a6ebbfa6ffcf7850af57192b34))
* **javascript:** classify application input selection failures by cause ([0a14bbb](https://github.com/morluto/rea/commit/0a14bbbf05e0e61c98e06326fe7136e52fa4fb3c))
* **javascript:** keep Wakaru version stderr out of the refusal message ([6489d58](https://github.com/morluto/rea/commit/6489d58851d055fd7ce621000d960bb42a0e4ce0))
* **javascript:** match source-map originals that name parent directories ([#1215](https://github.com/morluto/rea/issues/1215)) ([889fb37](https://github.com/morluto/rea/commit/889fb374df0f8986f49e9d61b0fefd536327f781))
* **javascript:** omit self-referential static references with disclosure ([#1157](https://github.com/morluto/rea/issues/1157)) ([b620e2a](https://github.com/morluto/rea/commit/b620e2a2bdcf3683b494d137bc409813735d5572))
* **javascript:** preserve alias and container uncertainty ([73e98b2](https://github.com/morluto/rea/commit/73e98b2516dd792ea7b510aeed6b71f384bea21d))
* **javascript:** preserve graphs with async chunk self-references ([#1152](https://github.com/morluto/rea/issues/1152)) ([7220166](https://github.com/morluto/rea/commit/72201668ed88c2cc822a07c08cf35a1e5ba88f35))
* **javascript:** preserve property paths and uncertain slot presence ([475a0f8](https://github.com/morluto/rea/commit/475a0f84dac63d710e032bc7f731c1a3bda624ec))
* **javascript:** reject encoded separators joined by HTML URL whitespace ([2ddd945](https://github.com/morluto/rea/commit/2ddd9456cd405f081784a4b3cb02cb77cd90fbd6))
* **javascript:** reject encoded separators joined by HTML URL whitespace ([fb57c86](https://github.com/morluto/rea/commit/fb57c8643fb8b4733cbac9090ef58fd13a3b5347))
* **javascript:** report located sources with differing digests as modified ([#1216](https://github.com/morluto/rea/issues/1216)) ([01174c4](https://github.com/morluto/rea/commit/01174c4a81fea109ae712ea1a746a83996f928ac))
* **javascript:** resolve HTML script URLs after URL whitespace and percent decoding ([d601b80](https://github.com/morluto/rea/commit/d601b8016eaeb2955cea4e4c0aca10d17e7d12a7))
* **javascript:** resolve HTML script URLs after URL whitespace and percent decoding ([502528c](https://github.com/morluto/rea/commit/502528c58df54c7b34eefdb5837f36e58f473405)), closes [#1236](https://github.com/morluto/rea/issues/1236)
* **javascript:** resolve package exports targets only to the exact file ([#1181](https://github.com/morluto/rea/issues/1181)) ([2a620c0](https://github.com/morluto/rea/commit/2a620c06cdcaa32844c4a80aeb3df1793f1ce09e)), closes [#1174](https://github.com/morluto/rea/issues/1174)
* keep the Ghidra session root free of dot-prefixed path elements ([a8b8288](https://github.com/morluto/rea/commit/a8b8288396cf2e053db768ef03f4db756aa8f71e))
* **managed:** preserve literal library names during native matching ([81b70bc](https://github.com/morluto/rea/commit/81b70bc358031686c9d7afd049f21719c67a9525))
* **managed:** separate metadata and signature completeness ([2f02eff](https://github.com/morluto/rea/commit/2f02eff9887fc715c33f5d8770a6e6191ba70ca9))
* **mcp:** advertise input patterns without look-around ([1f099a6](https://github.com/morluto/rea/commit/1f099a6fc00b08fb0283dcabc5a238025d4c4c8b))
* **mcp:** advertise input patterns without look-around ([a8701ea](https://github.com/morluto/rea/commit/a8701eaf489692449739d5b2490502b1a14951c5)), closes [#1282](https://github.com/morluto/rea/issues/1282)
* **mcp:** deliver tool errors within advertised schema contracts ([da606ff](https://github.com/morluto/rea/commit/da606ff77718d9a3b10426fcf68c098138e6dcfa)), closes [#1261](https://github.com/morluto/rea/issues/1261)
* **mcp:** deliver typed errors without invalid structured output ([#1277](https://github.com/morluto/rea/issues/1277)) ([7e96f25](https://github.com/morluto/rea/commit/7e96f25f8b1380a13a086a68f8d5a70380468151))
* **mcp:** emit portable Unicode NUL patterns ([#1230](https://github.com/morluto/rea/issues/1230)) ([aa5750c](https://github.com/morluto/rea/commit/aa5750c263632d98d626c5ca3b985bb1519d2395))
* **mcp:** measure tool errors against their text-only delivery ([fe34ec2](https://github.com/morluto/rea/commit/fe34ec2ef3e2968eeb06f64a1a0fdb8b825f56c4))
* **mcp:** measure tool errors against their text-only delivery ([7b51121](https://github.com/morluto/rea/commit/7b51121f7cee21a5938f10ac3b5762e0bb41a58d))
* **mcp:** only recommend exporting retained evidence ([5f749c2](https://github.com/morluto/rea/commit/5f749c2096af2617d4b6b387ff19c13001af8e54))
* name host and tool requirements in optional adapter refusals ([68cb02f](https://github.com/morluto/rea/commit/68cb02fe8b123b9a0778c0065c13a15bcf0e577d))
* name host and tool requirements in optional adapter refusals ([170d0bf](https://github.com/morluto/rea/commit/170d0bf9e2d45b2512ad556c02f31bdc81ea03ca))
* **native:** distinguish batch selectors from resolved entries ([13c3b68](https://github.com/morluto/rea/commit/13c3b68730df80330fd867d921dea38770d5f880))
* **native:** distinguish batch selectors from resolved entries ([bfaa5a6](https://github.com/morluto/rea/commit/bfaa5a6c2c0ddc9e6fcf16cd11ad06f24db174a2))
* **native:** name the CLI flag that selects another plist ([9b69503](https://github.com/morluto/rea/commit/9b6950373cfaa1a2c0d28287bfadd4a421afb9e9))
* **native:** name the plist selection that works when Info.plist is missing ([5612496](https://github.com/morluto/rea/commit/5612496f6d34a462dcd0fb69fa38337592e2f72d))
* **native:** name the plist selection that works when Info.plist is missing ([a6fdf42](https://github.com/morluto/rea/commit/a6fdf426bd98c8cf7b7a7f589208d3193784062f))
* **native:** refuse truncated executable headers at target admission ([d39a450](https://github.com/morluto/rea/commit/d39a450bdfac425962c3a6a6f47b45600057a230))
* **native:** refuse truncated executable headers at target admission ([0b04d38](https://github.com/morluto/rea/commit/0b04d384cca4f22f271d60bcfe67f79cab89c8de)), closes [#1189](https://github.com/morluto/rea/issues/1189)
* **process:** apply one timeout rule to both execFileOutput modes ([3d32819](https://github.com/morluto/rea/commit/3d328193d69a63a355644c51bfb70f524d99bca9))
* **process:** await cleanup on CLI and MCP cancellation ([f6fe575](https://github.com/morluto/rea/commit/f6fe575094658e99ced78d45f385633fbfaaae32))
* **process:** keep ports before a chunk-final period ([184ed97](https://github.com/morluto/rea/commit/184ed970b9021552a5454ced20d202d10cabcbb8))
* **process:** localize capture truncation diagnostics ([#1284](https://github.com/morluto/rea/issues/1284)) ([33bf585](https://github.com/morluto/rea/commit/33bf585185ffcaea63d658e2d3145c900a680485))
* **process:** normalize ports that end a sentence ([098d769](https://github.com/morluto/rea/commit/098d76900effdbc682b0f97bcde7f8711380ecea))
* **process:** normalize ports that end a sentence ([db98a51](https://github.com/morluto/rea/commit/db98a51dd1750b09b3905e18efac526f7ebf90f7))
* **process:** preserve numeric output and original PTY evidence ([c5c75c3](https://github.com/morluto/rea/commit/c5c75c38c3a4ff0153513b8f8ad600d8a5bacc09))
* **process:** preserve numeric output and original PTY evidence ([00d8e44](https://github.com/morluto/rea/commit/00d8e44cbf82caa51709c2e0857fbaa69ea329b7))
* **process:** preserve unknown filesystem absence in partial captures ([c8544b1](https://github.com/morluto/rea/commit/c8544b1574a32838da6d4ed40f2b72582edb60dd))
* **process:** refuse malformed timeouts for stoppable commands ([136d4aa](https://github.com/morluto/rea/commit/136d4aab18d822f0f908096b8acfac556ef1873b))
* **process:** refuse malformed timeouts for stoppable commands ([59c91c8](https://github.com/morluto/rea/commit/59c91c88fe88210b4b22b9f1365a16567513da4a))
* **process:** require current captures and preserve cleanup failures ([2a77469](https://github.com/morluto/rea/commit/2a7746998d47446c4db6d4f524e0f183d6803f3f))
* **process:** retain known events from incomplete captures ([5eb0049](https://github.com/morluto/rea/commit/5eb0049a9f502b404f30e48c3fe3430a942bb0b5))
* **process:** stop cancelled Swift helper builds before removing their files ([cf41561](https://github.com/morluto/rea/commit/cf415619cadcfcb18cda59a54b26c9d164f750a4))
* **process:** stop cancelled Swift helper builds before removing their files ([c717204](https://github.com/morluto/rea/commit/c7172047951e7dbb9df58b57ff1b43ac9bd47909)), closes [#1173](https://github.com/morluto/rea/issues/1173)
* **process:** stop timed-out commands with the caller's stop signal ([4b38d18](https://github.com/morluto/rea/commit/4b38d1899566089d19b9fd137202f7d86b62fc6f))
* **process:** stop timed-out commands with the caller's stop signal ([063de50](https://github.com/morluto/rea/commit/063de5014f19e85c38b6bec5984de4f38e71adaa))
* **process:** treat non-ASCII letters as port continuations ([ad813e4](https://github.com/morluto/rea/commit/ad813e473b094ab0d3ab30798b7d252e2f4beb94))
* **process:** validate terminal byte totals against retained frames ([69833fb](https://github.com/morluto/rea/commit/69833fb0d0fe9b320b5745a992822342f2c54a92))
* **process:** validate terminal byte totals against retained frames ([39eb058](https://github.com/morluto/rea/commit/39eb0587c95ad028bb961c539ad1f326a1e8d81c))
* **providers:** preserve observations and primary cleanup failures ([0696bde](https://github.com/morluto/rea/commit/0696bde2660bb5d6538d8c01da15aa023312aa9f))
* **reference:** represent unreadable symlink targets explicitly ([b7b4333](https://github.com/morluto/rea/commit/b7b433370310c3ffe33d5027d8393151d5e862da))
* restore caching, preserve failures, and verify fixture claims ([#1211](https://github.com/morluto/rea/issues/1211)) ([27a9cea](https://github.com/morluto/rea/commit/27a9ceade7232c1c9a24dc7d454ae060948183a1))
* **server:** report 2025-era client identity and features in binary_session ([e6abaef](https://github.com/morluto/rea/commit/e6abaefbbc2bd81a6be34cbe71b87be801158c16))
* **server:** report 2025-era client identity and features in binary_session ([b8312fa](https://github.com/morluto/rea/commit/b8312fa8d184ba9f422d1f5592fb41e49811544a)), closes [#1167](https://github.com/morluto/rea/issues/1167)
* **session:** require an open target for session-bound native and artifact tools ([d8e314c](https://github.com/morluto/rea/commit/d8e314cb24e7a4a494347e45474234e0aad74ad1))
* **session:** require an open target for session-bound native and artifact tools ([cf77d07](https://github.com/morluto/rea/commit/cf77d073fc06ab95ce4181c30d68b1346e990b64)), closes [#1166](https://github.com/morluto/rea/issues/1166)
* **session:** retain failed provider cleanup for lifecycle retries ([#1260](https://github.com/morluto/rea/issues/1260)) ([24a3aa0](https://github.com/morluto/rea/commit/24a3aa08d1f69e25b441f086300ba3082d860a35))
* **setup:** keep Codex TOML comments when adding or removing REA ([f5539cf](https://github.com/morluto/rea/commit/f5539cfc2f6c0daf6c275fc97f3351e2cf89b2c3))
* **setup:** keep Codex TOML comments when adding or removing REA ([e9c48a6](https://github.com/morluto/rea/commit/e9c48a61e4c2c05c5b77ef4a815c5b2a65a9337e)), closes [#1163](https://github.com/morluto/rea/issues/1163)
* **setup:** preserve initial backups and Codex comments ([#1204](https://github.com/morluto/rea/issues/1204)) ([6051cb2](https://github.com/morluto/rea/commit/6051cb2c0c723d88dc43ee5ef8a96971bf84d49e))
* **setup:** stop remaining uninstall removals after a client fails ([fd975c7](https://github.com/morluto/rea/commit/fd975c75fa353840e6e887232ca68496cf8705ea))
* **setup:** stop uninstall before removals when a client config is unsafe ([4fb2f3e](https://github.com/morluto/rea/commit/4fb2f3e6ed0233505eada3cddeeff0ea0bfc6fe5))
* **setup:** stop uninstall before removals when a client config is unsafe ([5cc841d](https://github.com/morluto/rea/commit/5cc841d5c154f692bdc257e106cc4b212dc19dc0)), closes [#1164](https://github.com/morluto/rea/issues/1164)
* **snapshot:** report query workflow and Evidence counts separately ([04aef6d](https://github.com/morluto/rea/commit/04aef6df331634238cfc61f320ba4a4e720750a4))
* **snapshot:** report query workflow and Evidence counts separately ([0e77953](https://github.com/morluto/rea/commit/0e779533a9108a550b4d10dcb3920f91c7d48989))
* **website:** clarify Android host and JDK requirements ([5691606](https://github.com/morluto/rea/commit/5691606aa948bddc641e3ecbccf5375a12b65924))
* **website:** identify publication verifier requests ([e6905c1](https://github.com/morluto/rea/commit/e6905c18e09c41e04525fb1a84575483df789204))
* **windows:** retain runtime authority after cleanup failure ([af7a439](https://github.com/morluto/rea/commit/af7a43963351c655eb86197bf52ae798a04e9c22))
* **windows:** retain unsettled jobs for cleanup retry ([76b214e](https://github.com/morluto/rea/commit/76b214e45fa05fe723e216894327185b9b4e6f53))


### Performance Improvements

* **mcp:** share repeated output schema definitions. ([441813c](https://github.com/morluto/rea/commit/441813c0708dbee82ef554c91e973ae02964bf2e))

* **hopper:** resolve string search records once per query ([#1229](https://github.com/morluto/rea/issues/1229)) ([9426c3f](https://github.com/morluto/rea/commit/9426c3f1bbb94711d8b33097e604b9b8ed853b5e))
* **mcp:** reuse input schemas without losing caller guidance ([#1162](https://github.com/morluto/rea/issues/1162)) ([e1afbc1](https://github.com/morluto/rea/commit/e1afbc1914cc7ff90265313e942f34ea4a58a4fc))
* **snapshot:** avoid redundant result copies and serialization ([552634d](https://github.com/morluto/rea/commit/552634d634655a722b2204cfbc4b29f6d442c294))
* **snapshot:** avoid redundant result copies and serialization ([569d2bc](https://github.com/morluto/rea/commit/569d2bc6b9f600114267a4c69f8400393ea1bc2f))


### Code Refactoring

* **domain:** remove obsolete comparison representations ([5510b27](https://github.com/morluto/rea/commit/5510b27d7f863a3df26212fba4a59f8df0da3712))
* enforce canonical evidence and provider boundaries ([63bf914](https://github.com/morluto/rea/commit/63bf91405cf97b114a84f337fb1272d98a267999))
* remove forwarding exports and redundant aliases ([ad59531](https://github.com/morluto/rea/commit/ad59531a960a0c51ef6857fa1391270dda0fa7a4))
* **schemas:** share portable identifier and base64 patterns ([#1227](https://github.com/morluto/rea/issues/1227)) ([954badb](https://github.com/morluto/rea/commit/954badbaaadd24a210190ce3015e40c23d327567))


### Documentation

* add French README translation ([84094af](https://github.com/morluto/rea/commit/84094af54a4e0a6247445e59abff27bc4eca361b))
* add French README translation ([9664b2b](https://github.com/morluto/rea/commit/9664b2b101fe4ac334b2911f9210b50d58d90a89))
* celebrate 30,000 GitHub stars 🎉 ([6987cb0](https://github.com/morluto/rea/commit/6987cb066a5aa5e51480bb06a93a758e6f67cd1e))
* celebrate 30,000 GitHub stars 🎉 ([beca997](https://github.com/morluto/rea/commit/beca9977eb2b18fc7b9844cff0ca70004b6ff21a))
* clarify REA has no affiliated cryptocurrency or token ([#1214](https://github.com/morluto/rea/issues/1214)) ([c2d8146](https://github.com/morluto/rea/commit/c2d8146f94c7533eb87681c2405e93bdfef21b59))
* explain 6.2 contract and saved-data migration ([#1304](https://github.com/morluto/rea/issues/1304)) ([c267e99](https://github.com/morluto/rea/commit/c267e9922751c03df312655ebd623de1b480215c))
* **ghidra:** explain supported heap and CPU controls ([#1278](https://github.com/morluto/rea/issues/1278)) ([0c6852b](https://github.com/morluto/rea/commit/0c6852b392b34319a6fd2c6dffcac10cee51ab94)), closes [#1255](https://github.com/morluto/rea/issues/1255)
* keep the 30k milestone in Star History ([#1217](https://github.com/morluto/rea/issues/1217)) ([c399670](https://github.com/morluto/rea/commit/c399670653884673158f314ed38260aef74da593))
* require focused brittleness cleanup and executable examples ([d6832c3](https://github.com/morluto/rea/commit/d6832c3632847cf3e62d4082b4b8b8d9af554633))
* thank feature request contributors ([9db1fd0](https://github.com/morluto/rea/commit/9db1fd0bd7b17ed1dd21b9c72dabfa4ec6c23a3f))
* **website:** continue the Calculator example with reconstruction ([4578647](https://github.com/morluto/rea/commit/4578647c59a7487bce597a65be6eab8be0412e84))
* **website:** continue the Calculator example with reconstruction ([18a1e8c](https://github.com/morluto/rea/commit/18a1e8cd0efe14c06fd14aabe0c318d2ae390f78))
* **website:** explain SEO maintenance and indexing follow-up ([bb8ff2c](https://github.com/morluto/rea/commit/bb8ff2cfba638ee3a77f951c01e98340c757f525))
* **website:** introduce the worked homepage examples ([f6f5c16](https://github.com/morluto/rea/commit/f6f5c160979624cdcb33928f1a77cf000de403d4))
* **website:** invite deeper projects and reader feedback ([3fb9ffa](https://github.com/morluto/rea/commit/3fb9ffaa4d67685412873cbd3101c64fabbeaff3))


### Tests

* **apple:** verify compiled Mach-O root occurrence facts ([#1300](https://github.com/morluto/rea/issues/1300)) ([4bb4c6f](https://github.com/morluto/rea/commit/4bb4c6fe6d34525c7665a9d38b584b026dd5cdd9))
* **artifacts:** assert asset-catalog target refusal only on macOS ([44d5b4b](https://github.com/morluto/rea/commit/44d5b4b25e0831769c1bd4e5426ef498d0bd3c74))
* **artifacts:** pin per-occurrence roles for direct Mach-O roots and shared bytes ([701d90a](https://github.com/morluto/rea/commit/701d90aba48aaf4f23e1a73e46ebf9968fb85293))
* **artifacts:** pin per-occurrence roles for direct Mach-O roots and shared bytes ([b9e29c5](https://github.com/morluto/rea/commit/b9e29c52d483704c64cd88f87eaa117066288602)), closes [#1234](https://github.com/morluto/rea/issues/1234) [#1235](https://github.com/morluto/rea/issues/1235)
* **artifacts:** read /bin/ls slice layout from its FAT table ([#1223](https://github.com/morluto/rea/issues/1223)) ([c89b3a0](https://github.com/morluto/rea/commit/c89b3a00dce8df36ddb696b59c80e1adc6aceac1))
* **artifacts:** verify compiled Mach-O roles and permissions ([4bb4c6f](https://github.com/morluto/rea/commit/4bb4c6fe6d34525c7665a9d38b584b026dd5cdd9))
* consolidate redundant assertions into boundary workflows ([b71a591](https://github.com/morluto/rea/commit/b71a591a60e3fa5333889e3cf97e05f4ae03c686))
* **ghidra:** preserve selected verification resource limits ([1c3766a](https://github.com/morluto/rea/commit/1c3766a8bcc8a2b6af679cdaa92a73fec42b3372))
* **ghidra:** size oversized annotations for canonical delivery ([1e34197](https://github.com/morluto/rea/commit/1e341973cfad1dbf06755f3a086ffc23d42a723c))
* **ghidra:** use host-native absolute session root fixtures ([1e83d27](https://github.com/morluto/rea/commit/1e83d270c2098b1bcb59591698a257a05d2296fc))
* **javascript:** expect the invalid input_path code in the streamed CLI failure test ([d186ca7](https://github.com/morluto/rea/commit/d186ca7e41928fc2748de2631f5cb43115776571))
* **mcp:** read bundle failures from public error content ([69c3b32](https://github.com/morluto/rea/commit/69c3b32a21c90ea96194fb695f7b58992e8b3714))
* **mcp:** read typed errors in canonical Evidence regressions ([fd46cff](https://github.com/morluto/rea/commit/fd46cff017f0110aaab1216764cf01a71b341766))
* **mcp:** validate public error diagnostics in acceptance workflows ([09058eb](https://github.com/morluto/rea/commit/09058ebc4a68c76d865a92dbddb65811ba8344f7))
* **native:** assert batch identity in production registration ([933fcb3](https://github.com/morluto/rea/commit/933fcb33c1fa1eae109228b89c1200abb7745eb8))
* **native:** build the .app fixture executable with a complete Mach-O header ([facaae8](https://github.com/morluto/rea/commit/facaae865af243656ab8f557aeb42f5909748f2b))
* **process:** check malformed capture choices concurrently ([6020a0b](https://github.com/morluto/rea/commit/6020a0b3683ce16e1441963473605f870c247e29))
* **process:** check malformed capture choices concurrently ([48de11c](https://github.com/morluto/rea/commit/48de11ce2e5af9810fc97d1c2f89df56bf3a3d4d))
* remove duplicate workflow examples and self assertions ([d6d1cd2](https://github.com/morluto/rea/commit/d6d1cd248506015b59a2abdbbb84e3dbd02388fc))


### Continuous Integration

* **website:** allow explicitly requested Pages-only publication ([796b65e](https://github.com/morluto/rea/commit/796b65e1cd15f3cf819396716320db007655ee3f))
* **website:** allow explicitly requested Pages-only publication ([864160d](https://github.com/morluto/rea/commit/864160d8858fad3c0afebff81c31b090a1ebf823))
* **website:** allow explicitly requested Pages-only publication ([#1205](https://github.com/morluto/rea/issues/1205)) ([796b65e](https://github.com/morluto/rea/commit/796b65e1cd15f3cf819396716320db007655ee3f))
* **website:** publish Cloudflare and Pages from one artifact ([761881c](https://github.com/morluto/rea/commit/761881cec33b18d7228bae5e2093e5d44b96ceb1))

## [6.1.0](https://github.com/morluto/rea/compare/rea-agents-6.0.0...rea-agents-6.1.0) (2026-10-09)


### ⚠ BREAKING CHANGES

* **hopper:** Hopper regex mode uses ECMAScript Unicode syntax instead of Python re. Matching runs in a cancellable worker with a five-second deadline; literal mode keeps Unicode casefold matching.
* **hopper:** remove set_current_document. Use open_binary to switch targets; document arguments are scoped to the active target.

### Features

* **clients:** register Grok Build and Grok Bot during setup ([#1134](https://github.com/morluto/rea/issues/1134)) ([08561e0](https://github.com/morluto/rea/commit/08561e0eb7a4a01a256f3693a97061fbea7fb8fa))
* **ghidra:** make the startup deadline configurable ([#974](https://github.com/morluto/rea/issues/974)) ([d84bc8f](https://github.com/morluto/rea/commit/d84bc8f11abd6cbf5612daf5c8f7e1805d23c16e))
* **website:** add GitHub link with live star count ([2f59287](https://github.com/morluto/rea/commit/2f59287f1a1794a68102a45c61cc657659fa5de6))


### Bug Fixes

* **analysis:** bind overview document identity to the active target ([#1094](https://github.com/morluto/rea/issues/1094)) ([81b5104](https://github.com/morluto/rea/commit/81b51042767ad75310bad1a7a9faf954339841c0))
* **analysis:** resolve procedure identities and preserve literal queries ([d830cb7](https://github.com/morluto/rea/commit/d830cb79b305e6d4d255f8080de69ca668cbe0af))
* **android:** report actual provider readiness ([c715af8](https://github.com/morluto/rea/commit/c715af80587f808de816d3add6a6f989437ab66a))
* **android:** report startup and selector failure causes ([6c13fc8](https://github.com/morluto/rea/commit/6c13fc8e0a318ebe7be6b038089b350d99f8e286))
* **apple:** account for repeated archive projections ([e1df5e8](https://github.com/morluto/rea/commit/e1df5e85551125b27ef0debb7573de5507b149e1))
* **apple:** budget Interface Builder decoding and projection ([dbcf8c3](https://github.com/morluto/rea/commit/dbcf8c33915d924fdbc881bf2cf9676587f3b96f))
* **apple:** classify empty dyld settings by consumer semantics ([#1110](https://github.com/morluto/rea/issues/1110)) ([fe297e5](https://github.com/morluto/rea/commit/fe297e56e804130dd49cc0a95fcf2d115c183ae3))
* **apple:** decode bundle plist bytes before executable lookup ([d575a73](https://github.com/morluto/rea/commit/d575a7340bb19b84733c79b14de9f4df7181c6b3))
* **apple:** decode Interface Builder XML byte encodings ([#1095](https://github.com/morluto/rea/issues/1095)) ([f8e143a](https://github.com/morluto/rea/commit/f8e143a3bcd20ddcc0d76d90e73e238d456fe5a3))
* **apple:** derive dispatch coverage from located decode facts ([488f448](https://github.com/morluto/rea/commit/488f448ae27fd62904967ec1e0ab072e834a9822))
* **apple:** keep skipped catalog entries from reading as absence ([a079af2](https://github.com/morluto/rea/commit/a079af297bb454417dfd3d89b0037397554ad83e))
* **apple:** report apps without asset catalogs as empty inventories ([e2f0378](https://github.com/morluto/rea/commit/e2f03786f496ed742572acd87f47270c958171ec))
* **apple:** report apps without asset catalogs as empty inventories ([79e5a39](https://github.com/morluto/rea/commit/79e5a3923db896323c0491e31004214856529b74))
* **apple:** report missing keyed archive hierarchy references ([#1104](https://github.com/morluto/rea/issues/1104)) ([3b2ec69](https://github.com/morluto/rea/commit/3b2ec69c54fc9cf65bf8441edbb96e9619c3a37e))
* **apple:** validate dylib candidates and preserve search uncertainty ([#1100](https://github.com/morluto/rea/issues/1100)) ([7914e36](https://github.com/morluto/rea/commit/7914e36ab9adbbf591a6e1f3fafcb2e17f55d667))
* **apple:** validate physical slices and dylib platform compatibility ([15f92f2](https://github.com/morluto/rea/commit/15f92f298891c8b16d7d13c78cb6ca66cb90cd85))
* **application:** budget bridge candidate projection by bytes ([3d450a2](https://github.com/morluto/rea/commit/3d450a29fc91cef3e06ffce9a925ac70dcb24272))
* **artifacts:** preserve keyed archive integer precision ([4034883](https://github.com/morluto/rea/commit/4034883e9860a97edee03260fab59f9229debfa6))
* **artifacts:** report keyed-archive selection mistakes as invalid input ([5a55d5b](https://github.com/morluto/rea/commit/5a55d5b1c6aefb4a4e5df63ec43b7e2fc0a7d385))
* **artifacts:** report keyed-archive selection mistakes as invalid input ([25fb6d3](https://github.com/morluto/rea/commit/25fb6d32a325d88bb0f4e05e16f5f82e4f91c5ca))
* **artifacts:** retain failed DMG cleanup state and diagnostics ([#1103](https://github.com/morluto/rea/issues/1103)) ([4bb056b](https://github.com/morluto/rea/commit/4bb056bbb5b735e214ed8d725aa3de1c06fb0dc9))
* **browser:** advertise zero-based units for runtime source coordinates ([#1085](https://github.com/morluto/rea/issues/1085)) ([6218d28](https://github.com/morluto/rea/commit/6218d289e241715d0868004caafe15b5c4758450))
* **browser:** bind correlated replies to their selected session ([96d3caf](https://github.com/morluto/rea/commit/96d3cafb0725881b6cdab0e2185104957dc69f71))
* **browser:** bound aggregate source-map decoding before expansion ([f983c71](https://github.com/morluto/rea/commit/f983c718c33789ee40aec43f84315f6b53e95bde))
* **browser:** bound script metadata and preserve omissions ([faf209e](https://github.com/morluto/rea/commit/faf209e50d9faab03a185c1f044de3582552d11e))
* **browser:** bound source-map fetches and retain predecessor requests ([eaf5734](https://github.com/morluto/rea/commit/eaf57340831a753faec58246290f9502d159b6b1))
* **browser:** compose nested source-map column offsets ([#1109](https://github.com/morluto/rea/issues/1109)) ([8b08ec0](https://github.com/morluto/rea/commit/8b08ec0af936405fd20db25f941e2ae6318c5145))
* **browser:** keep initiator callsites out of script coordinate guidance ([#1096](https://github.com/morluto/rea/issues/1096)) ([3c157b4](https://github.com/morluto/rea/commit/3c157b4ec6297e6737bd3c2ec3dc520c7403402f))
* **browser:** normalize selected script manifest roots on Windows ([#1078](https://github.com/morluto/rea/issues/1078)) ([b49beb4](https://github.com/morluto/rea/commit/b49beb42d7a97f73d052a27fb99673b1bd0d3d39))
* **browser:** preserve captures when response bodies are unavailable ([96af2fa](https://github.com/morluto/rea/commit/96af2fa7444a3777d51ff46202ef563146929dbd))
* **browser:** preserve command failures and reject malformed replies ([6b92002](https://github.com/morluto/rea/commit/6b92002597d34555c32ebf24b9db6e4c17c0a08d))
* **browser:** treat module-import initiator positions as script positions ([ae0630a](https://github.com/morluto/rea/commit/ae0630a619ee2c98a68e65ca44bf0b93424e2f8e))
* **browser:** treat module-import initiator positions as script positions ([99d31ee](https://github.com/morluto/rea/commit/99d31ee24ad060babace9eca3325858418e0f55a))
* **browser:** validate and bound source-map evidence ([0a0174b](https://github.com/morluto/rea/commit/0a0174b9ac8a73b61094e857a2950f4e5a06f544))
* **build:** exclude the test-only generated catalog from packages ([#1116](https://github.com/morluto/rea/issues/1116)) ([d1c904b](https://github.com/morluto/rea/commit/d1c904bac7977d44b06bf2f823587baedcc88b9e))
* **build:** make catalogs and packaged skills generated outputs ([#1086](https://github.com/morluto/rea/issues/1086)) ([e613405](https://github.com/morluto/rea/commit/e6134056cf519410160a196363f8a04f0729324e))
* **capture:** retain Electron observations and HAR resource failures ([44fd183](https://github.com/morluto/rea/commit/44fd18305fa5a8893ebb5b952099fdf45dbd6e55))
* **ci:** align diagnostic regressions and format merged changes ([67756da](https://github.com/morluto/rea/commit/67756dacc0d435a61d2d0c403412151769da028f))
* **ci:** restore generated shard inputs and cleanup assertions ([5f93b4b](https://github.com/morluto/rea/commit/5f93b4b125e78f088a2349a178e60f8c0af3e1a2))
* **cli:** accept exact native names through explicit selectors ([c313606](https://github.com/morluto/rea/commit/c3136064c7f8f72b2f6c6799ec41ea6424111bb7))
* **cli:** drive mcp doctor help from a single option schema ([b7d803d](https://github.com/morluto/rea/commit/b7d803dd10c7ef8bb73f81f5e893168af8ea86e6))
* **cli:** preserve blank JSON paths for input validation ([#1068](https://github.com/morluto/rea/issues/1068)) ([3dcb732](https://github.com/morluto/rea/commit/3dcb732da33f6ceef597506b14a4536f1c9aff96))
* **cli:** preserve web cancellation exit status ([1d9b96a](https://github.com/morluto/rea/commit/1d9b96a9c497694592137cf95bea2af0a190abe7))
* **cli:** support MCP doctor help ([a69b833](https://github.com/morluto/rea/commit/a69b8337ab38707aaad2ac2fedb652f05afeb71c))
* **contracts:** preserve local inputs and comparison uncertainty ([70e8a8f](https://github.com/morluto/rea/commit/70e8a8f86060496452ccbc1a49b39822efef4113))
* **docs:** validate translated links to canonical product facts ([34f7c4f](https://github.com/morluto/rea/commit/34f7c4fd661e07db66c560a4d54272b0163a52b6))
* **domain:** order canonical paths by code point, not UTF-16 unit ([#1034](https://github.com/morluto/rea/issues/1034)) ([b5c2954](https://github.com/morluto/rea/commit/b5c2954ad67f0280732df043d5d9702f3d202819))
* **domain:** preserve prototype-named JSON members through Evidence boundaries ([#1049](https://github.com/morluto/rea/issues/1049)) ([40e18b2](https://github.com/morluto/rea/commit/40e18b2e37f2be11f452606c2d875981b03ad03e))
* **domain:** reject excessive JSON depth with actionable diagnostics ([#1029](https://github.com/morluto/rea/issues/1029)) ([bfbfc73](https://github.com/morluto/rea/commit/bfbfc7330aa7175018de04f1d099b8d4aeec3bd1))
* **electron:** bound hook retention and report dropped coverage ([02d0702](https://github.com/morluto/rea/commit/02d07027617a5df014f92a351aa9418aade6f06f))
* **evidence:** name the failed constraint when a bundle is rejected ([82a1a52](https://github.com/morluto/rea/commit/82a1a525d7aa725d939926ba953434fbf5db0ab0))
* **evidence:** name the failed constraint when a bundle is rejected ([cf96ceb](https://github.com/morluto/rea/commit/cf96ceb2119f52f61a621d2a790b7c8804c65595))
* **evidence:** report missing evidence files instead of permission advice ([e8b92a4](https://github.com/morluto/rea/commit/e8b92a40c003a5e6ce3cefe4ad18392d39759653))
* **evidence:** report missing evidence files instead of permission advice ([89252f1](https://github.com/morluto/rea/commit/89252f1f35de91494bd49460b1645d8c09cc6d33))
* **evidence:** require a complete record before the single-record hint ([38bbb65](https://github.com/morluto/rea/commit/38bbb656da2659088e30a1ca3e4434b2f65bab32))
* **firmware:** reject malformed UTF-8 producer reports ([4a45c14](https://github.com/morluto/rea/commit/4a45c14742e6868f687cead2ddf736c3f7c49acd))
* **ghidra:** admit Linux arm64 with matching native tools ([3e598b2](https://github.com/morluto/rea/commit/3e598b2d38a728cd9fd4a359741500a021ba9d3a))
* **ghidra:** harden location resolution and provider lifecycle ([1f5be75](https://github.com/morluto/rea/commit/1f5be750bced759339183945488cea352b18f28b))
* **ghidra:** make qualified function renames idempotent ([4458128](https://github.com/morluto/rea/commit/4458128a845c1448140b44d6e62d6ccfe611d37c))
* **ghidra:** parse long procedure selectors without recursion ([480b16b](https://github.com/morluto/rea/commit/480b16b9c151e1d4bfbca8b49a0668d74ceaa400))
* **ghidra:** preserve function references and snapshot boundaries ([84a17d5](https://github.com/morluto/rea/commit/84a17d55199b1b46493aea6bf4e41029a3b200fc))
* **ghidra:** preserve POSIX runtime paths with spaces ([80c3d36](https://github.com/morluto/rea/commit/80c3d36dfa2597f34fdeb69e0ba75277ee50c85c))
* **ghidra:** preserve source failures and snapshot ownership ([704fa76](https://github.com/morluto/rea/commit/704fa7699ca183d5d5e0518a6fcdbb953ec35a10))
* **ghidra:** preserve Unicode boundaries without breaking sessions ([bef234d](https://github.com/morluto/rea/commit/bef234d6ce63cd296a654400443fcdbbcd44d7de))
* **ghidra:** recover regex stack exhaustion without losing annotations ([bc4aa46](https://github.com/morluto/rea/commit/bc4aa46d7c3960a1f325523e48aed2089b176e84))
* **ghidra:** reject address truncation before reads and edits ([dcae3c6](https://github.com/morluto/rea/commit/dcae3c6c148582d235f5650aace6f9744eeb153c))
* **ghidra:** resolve exact external function entries ([549effa](https://github.com/morluto/rea/commit/549effa056729e5f9239d9ed7864537a9c49e421))
* **hopper:** bind analysis to the active target and correct boundary contracts ([2f71375](https://github.com/morluto/rea/commit/2f71375efc517bb9e6f9800f8e8a6849766bc893))
* **hopper:** bind file mappings to verified source bytes ([82626c4](https://github.com/morluto/rea/commit/82626c4499a53c227187575d40a845fadd5318e2))
* **hopper:** diagnose MCP provider failures with stage, state, and request context ([#1044](https://github.com/morluto/rea/issues/1044)) ([5a67c7f](https://github.com/morluto/rea/commit/5a67c7fc540c494371de76dcdf353923656993d3))
* **hopper:** enforce caller-supplied request deadlines ([#1119](https://github.com/morluto/rea/issues/1119)) ([e8939ca](https://github.com/morluto/rea/commit/e8939ca2208bc41454b73b90a32418714e6a2969))
* **hopper:** isolate regex matching from the native API thread ([f201b04](https://github.com/morluto/rea/commit/f201b04fbbb29591b0d2bb3f3b24636526e4ec4e))
* **hopper:** load verified FAT64 slices with native Mach-O semantics ([0a49d5b](https://github.com/morluto/rea/commit/0a49d5bfb931124d3d398dfbd64e9f6ae8a01405))
* **hopper:** normalize native block endpoints and retain terminal evidence ([2847311](https://github.com/morluto/rea/commit/2847311a579ce2da4c8ded4d89fcdd01545e6da5))
* **hopper:** preserve launcher evidence on readiness timeout ([458771c](https://github.com/morluto/rea/commit/458771cb583e38b848b3d8c58595d163143ff50a))
* **hopper:** preserve native navigation and annotation semantics ([f2e22e1](https://github.com/morluto/rea/commit/f2e22e13a6956985bd65a2d75e4db7e3128cce81))
* **hopper:** preserve owned basic-block endpoint instructions ([#1118](https://github.com/morluto/rea/issues/1118)) ([329cf20](https://github.com/morluto/rea/commit/329cf206d1111c051733c7115cabff4b46722deb))
* **hopper:** preserve partial native call and string evidence ([2461702](https://github.com/morluto/rea/commit/246170238ebb8669a20b57b559b03cfc26ee1b8c))
* **hopper:** preserve typed string values and verify real searches ([7d7b3f9](https://github.com/morluto/rea/commit/7d7b3f961af2dc9b7572e91aaec29e6c4eccf9d5))
* **hopper:** report launcher failures before bridge timeout ([#1105](https://github.com/morluto/rea/issues/1105)) ([cd756b0](https://github.com/morluto/rea/commit/cd756b07d5b9c06e085d778e9f1c4fc9bd403219))
* **hopper:** resolve FAT loaders and original file coordinates ([35f1ddd](https://github.com/morluto/rea/commit/35f1ddd6bc77588b9971961cd70968a815aae266))
* **hopper:** validate annotation destinations and symbol extents ([b2d5bc1](https://github.com/morluto/rea/commit/b2d5bc110914f2ad42d17bc739d5f37c1b0f0a4d))
* **hopper:** verify lease cleanup and repair the macOS test lane ([#1111](https://github.com/morluto/rea/issues/1111)) ([b743bd2](https://github.com/morluto/rea/commit/b743bd20a0cbc39728e2e822fa75c013d87e1730))
* **inspector:** bound retained metadata and preserve cancellation ([e714fb0](https://github.com/morluto/rea/commit/e714fb027afdf11bfbb0838722523d3fa9ebf244))
* **install:** guard empty prefix_args expansion on macOS Bash 3.2 under set -u ([#1061](https://github.com/morluto/rea/issues/1061)) ([68b9fa4](https://github.com/morluto/rea/commit/68b9fa489b0c07f580633785ec61c17fa20b5083))
* **javascript:** bound primitive string growth and repeated evaluation ([4a1837d](https://github.com/morluto/rea/commit/4a1837d9d52b1a6454469e2dc63eeb8d716fb296))
* **javascript:** bound semantic expansion and resolve lexical receivers ([16f4609](https://github.com/morluto/rea/commit/16f4609d689445c05a0befc744fce7e72f7047ec))
* **javascript:** classify direct defaults and argv elements ([6495171](https://github.com/morluto/rea/commit/649517181268a0b729970b7cbbda15e04b199e32))
* **javascript:** honor cancellation before evidence publication ([#1098](https://github.com/morluto/rea/issues/1098)) ([cc0ee2e](https://github.com/morluto/rea/commit/cc0ee2edc60dda42d7b7cfb2c08e39b0b736b5e9))
* **javascript:** omit self-referential import edges with disclosure ([#1130](https://github.com/morluto/rea/issues/1130)) ([1d7115b](https://github.com/morluto/rea/commit/1d7115b7b470719a32e477ca3cbb681f0ad408b8))
* **javascript:** parse plain TypeScript artifact dialects ([#1102](https://github.com/morluto/rea/issues/1102)) ([3db4681](https://github.com/morluto/rea/commit/3db46813f80f84504c5b87c73a4bece82a8fdc5e))
* **javascript:** preserve HTML carriage return source ranges ([#1092](https://github.com/morluto/rea/issues/1092)) ([23862af](https://github.com/morluto/rea/commit/23862af1b57413e09abf394f6e4f8369f6355d5a))
* **javascript:** preserve lexical open and exact template semantics ([d6cc9ca](https://github.com/morluto/rea/commit/d6cc9ca3a6e92604c837f61c193baf5abedaabc8))
* **javascript:** preserve original BOM source coordinates ([#1093](https://github.com/morluto/rea/issues/1093)) ([83defc0](https://github.com/morluto/rea/commit/83defc054b69e94da888d70bb3b05d835e1bf74d))
* **javascript:** retain NodeNext artifact source facts ([#1087](https://github.com/morluto/rea/issues/1087)) ([c1b370c](https://github.com/morluto/rea/commit/c1b370ce0dfcbd5725cf6aebe23b022dfc75ac84))
* **javascript:** use Node legacy package entry fields ([1706005](https://github.com/morluto/rea/commit/170600541bf44f2a63731e8b3d42aae3cbb8d6b3))
* **managed:** bind inspection evidence to artifact identity ([73b09f4](https://github.com/morluto/rea/commit/73b09f4c5c511ce80baa0c89717181bbe0ecba8f))
* **managed:** match exact method bytes without decoded signatures ([17809ca](https://github.com/morluto/rea/commit/17809caacd0f44fcc7c1af42932ea655489d64ae))
* **mcp:** flatten root union input schemas ([#1062](https://github.com/morluto/rea/issues/1062)) ([6a7650e](https://github.com/morluto/rea/commit/6a7650e93cba9169baad95d2c52b11351ae39d0e))
* **mcp:** preserve retained evidence on oversized delivery ([0639a54](https://github.com/morluto/rea/commit/0639a541a3b712940119f59e8189bc962b267726))
* **mcp:** retain complete application results across response limits ([a1ed423](https://github.com/morluto/rea/commit/a1ed4232de635d4acc0dd9eb293e309a29d03e80))
* **mcp:** retain oversized errors before transport delivery ([b3f1b4e](https://github.com/morluto/rea/commit/b3f1b4e822aec5626d1952a88f50c7520dc265d3))
* **metadata:** stop schema changes churning generated skill evidence ([#1075](https://github.com/morluto/rea/issues/1075)) ([d52f66d](https://github.com/morluto/rea/commit/d52f66d62a93ec09cccdf53e64e3ccd24d16e520))
* **native:** bind signature observations to registered target versions ([#1099](https://github.com/morluto/rea/issues/1099)) ([c789af0](https://github.com/morluto/rea/commit/c789af04b76c0e76a522a5dece34f461288f5ecd))
* **native:** bound retained observations and preserve failure evidence ([7c32387](https://github.com/morluto/rea/commit/7c323870c2dcab78654ee7a80128b06affdf2bbe))
* **native:** preserve bridge failure types during cleanup ([1d0baa3](https://github.com/morluto/rea/commit/1d0baa352fc76d1760abbe29a3cc80fa17296916))
* **native:** resample tool identity for each invocation ([14b19a0](https://github.com/morluto/rea/commit/14b19a0b8a5af401212c552173e761eac53bfe46))
* **native:** share command supervision and retain failure output ([f2e9c49](https://github.com/morluto/rea/commit/f2e9c491ea00bf79d5665102d95a3339b63cfe4f))
* **native:** supervise LLDB and preserve bounded capture uncertainty ([915855e](https://github.com/morluto/rea/commit/915855e75ca3fe3b1b54978ace6bbe10d1973f64))
* **process:** avoid cold ownership helper deadline exhaustion ([#1139](https://github.com/morluto/rea/issues/1139)) ([65a809a](https://github.com/morluto/rea/commit/65a809a0da0555aa8eeafbc2ec2559517471be02))
* **process:** derive executable names from the capture host ([#1108](https://github.com/morluto/rea/issues/1108)) ([34cc925](https://github.com/morluto/rea/commit/34cc9259c1076a0d9575a87679befca692ec86c2))
* **process:** identify unknown live processes in cleanup diagnostics ([eb89a16](https://github.com/morluto/rea/commit/eb89a16d9bc51b65dcc75e05f8492de894320753))
* **process:** name the reason two captures cannot be compared ([#1080](https://github.com/morluto/rea/issues/1080)) ([eb69763](https://github.com/morluto/rea/commit/eb69763d27e29fe3247c008925016e4c73cb6abe))
* **process:** preserve observations after successful cleanup ([2af12a1](https://github.com/morluto/rea/commit/2af12a18a36bb80fb7d91ef4c8009212750daa0a))
* **process:** retain ownership after incomplete cleanup ([e2fc249](https://github.com/morluto/rea/commit/e2fc2493b6a59f0663495d277c0cfec1aeb25a7a))
* **process:** stabilize native capture and ownership prerequisites ([2b27515](https://github.com/morluto/rea/commit/2b2751547662f8cb142f96d91eff50388a1ecb31))
* **process:** stop failing captures on tokens macOS cannot expose ([#1057](https://github.com/morluto/rea/issues/1057)) ([5547c1e](https://github.com/morluto/rea/commit/5547c1e697af8c2e1c771abe5344d10b7c1cd340))
* **providers:** validate ELF versions and preserve probe cancellation ([8b01e0c](https://github.com/morluto/rea/commit/8b01e0cc8904b512b517b4471ef2150f40c98f0d))
* **release:** always bump minor for releases ([be783ef](https://github.com/morluto/rea/commit/be783efaba62dc76c5d8d42229869a32afdb302a))
* **release:** publish prereleases under the next npm tag ([bfb7776](https://github.com/morluto/rea/commit/bfb7776006303c6164dba2f22b8e81fdb7c20beb))
* **release:** publish reviewed release PR merges ([cdddfdd](https://github.com/morluto/rea/commit/cdddfddf495ffd172f62a6a801f7697fe502847e))
* **release:** recognize conventional titles in GitHub merge commits ([f5009ed](https://github.com/morluto/rea/commit/f5009ed55f081939409808870458162991f836ca))
* **release:** restore automatic release proposals on main ([acb3e0f](https://github.com/morluto/rea/commit/acb3e0f2e5b38a9c97df7ed78c8e6e5f38bfa08f))
* **release:** validate frozen checkpoint versions and breaking notes ([8a31508](https://github.com/morluto/rea/commit/8a31508c8958800364e255540ded1586298d7008))
* **release:** validate frozen checkpoint versions and breaking notes ([60825fb](https://github.com/morluto/rea/commit/60825fb44751c9482bdf4cafdac3599da7c82d45)), closes [#1063](https://github.com/morluto/rea/issues/1063)
* select Node legacy package entry fields for import and require ([#1035](https://github.com/morluto/rea/issues/1035)) ([1706005](https://github.com/morluto/rea/commit/170600541bf44f2a63731e8b3d42aae3cbb8d6b3))
* **session:** serialize snapshot lifecycle with admitted requests ([e44cb45](https://github.com/morluto/rea/commit/e44cb45908af8d3902e0db044e0cf7b86cdd7ed0))
* **setup:** launch Windows npx registrations through cmd.exe ([#1072](https://github.com/morluto/rea/issues/1072)) ([ef30343](https://github.com/morluto/rea/commit/ef30343154d64d78b620d41c37457eee5d99fc71))
* **setup:** treat empty client config files as new documents ([#1117](https://github.com/morluto/rea/issues/1117)) ([9fd65ce](https://github.com/morluto/rea/commit/9fd65ce0711ce9257aee15e62a5ecf9832960035))
* **snapshot:** retain MCP workflow replay bindings ([5e1afe4](https://github.com/morluto/rea/commit/5e1afe454f2f283eeeea4532d07a9bdbea8bd51e))
* **target:** preserve app bundle filesystem failure reasons ([d4c2c3c](https://github.com/morluto/rea/commit/d4c2c3c18f691d04526fe38867347faa2530861d))
* **update:** accept npm 12 release metadata ([#1138](https://github.com/morluto/rea/issues/1138)) ([567a82f](https://github.com/morluto/rea/commit/567a82f8d4feb629a7c10d2cc9180377eb1f6f66))
* **verify:** close both sides of the browser proxy ([f7366a5](https://github.com/morluto/rea/commit/f7366a517ff0545f01df6202b1ed3231d9dd3b4a))
* **verify:** isolate package archives and published canary caches ([3eb7dbd](https://github.com/morluto/rea/commit/3eb7dbdc1689737b44cc4ff044bcb1a311511969))
* **verify:** remove stale mocked bridge package probe ([826583d](https://github.com/morluto/rea/commit/826583dd43fc918c70a87dfe148c2fdbc8612f3b))
* **verify:** report final success only after resource cleanup ([ee043e2](https://github.com/morluto/rea/commit/ee043e2cbf30152c60b403fff050a0fc848a3286))
* **workflows:** keep caller-input details in workflow input errors ([#1089](https://github.com/morluto/rea/issues/1089)) ([289aef6](https://github.com/morluto/rea/commit/289aef6838e424c14f331a9905020079e6b7539b))
* **workflows:** retain residual unknowns through CLI and MCP ([0136ee8](https://github.com/morluto/rea/commit/0136ee8c22300ed351af5eab6329ab4d271b5bb6))


### Performance Improvements

* **mcp:** advertise each tool JSON Schema once per target ([#1059](https://github.com/morluto/rea/issues/1059)) ([5ccb924](https://github.com/morluto/rea/commit/5ccb9241be15bb6a19b99fbbfb27ff3356ba157b))
* **build:** avoid duplicate documentation generation ([c701376](https://github.com/morluto/rea/commit/c701376777212ec9acfd10c97f45b1eaf0c885c6))
* **javascript:** index configuration and module lookups ([67252b2](https://github.com/morluto/rea/commit/67252b23b9e35e9526fed7842dab47a2c7c9fe5f))
* **javascript:** reuse validated immutable graphs ([#1112](https://github.com/morluto/rea/issues/1112)) ([ec6db0f](https://github.com/morluto/rea/commit/ec6db0f0630c4b0b35f0db84c0030784c1aa58a6))


### Code Refactoring

* **artifacts:** centralize stable inventory identities ([135d102](https://github.com/morluto/rea/commit/135d102f9df844d70d352870afce80f67c0ae96f))
* **browser:** charge source-map records before retention ([e762e32](https://github.com/morluto/rea/commit/e762e32afbba3fd32532fd42a3f4fdcd05252ad3))
* **config:** prune unused format wrappers and launcher export ([81ae838](https://github.com/morluto/rea/commit/81ae8385679ef10b95d34d0f0b5ba11732ac86b5))
* **input:** share schema issue error construction ([65a6288](https://github.com/morluto/rea/commit/65a6288257e4c3cab9adb53b0f9123ef567b61bd))
* **setup:** validate formats through canonical configuration ([4b10665](https://github.com/morluto/rea/commit/4b1066501b379107b2375e270f386fc9855a85c1))


### Documentation

* add Persian README translation with full language navigation ([7a7460f](https://github.com/morluto/rea/commit/7a7460f04f3cfd7e365d70ff891bdd0c474901b6))
* add ten README translations and expand language navigation ([a61491a](https://github.com/morluto/rea/commit/a61491ad00b21e912e16f68bff829927aed6e16f))
* align translated READMEs and website links with English ([d83f098](https://github.com/morluto/rea/commit/d83f0983d5aa18d29d95d24c4ccb3928be6f29f5))
* celebrate 20,000 GitHub stars 🎉 ([#1079](https://github.com/morluto/rea/issues/1079)) ([9455e7c](https://github.com/morluto/rea/commit/9455e7c8bc9d5c4a9a1fc9077aa15007ad80997e))
* check surrounding cases when changing boundaries ([46d195e](https://github.com/morluto/rea/commit/46d195e8a48b710fc355e84cb6b79461b9c39005))
* clarify contribution scope and cosmetic suggestions ([1f79002](https://github.com/morluto/rea/commit/1f7900249783956070af49c10f86002a0dfdc42b))
* clarify evidence ownership and verification guidance ([a9e00b8](https://github.com/morluto/rea/commit/a9e00b83f37651a8dd241375615b248062e04227))
* move Portuguese toward the end of language navigation ([2a4979b](https://github.com/morluto/rea/commit/2a4979b7cdc1a517865573d6c36654c022347d0a))
* move star milestone into history sections across readmes ([6e6ff7b](https://github.com/morluto/rea/commit/6e6ff7bd2eabb668602258ad5e31eb758b31f823))
* require partial native facts at provider boundaries ([2b86ea9](https://github.com/morluto/rea/commit/2b86ea9c7cd3cfc2141a021f8b531dbc84395c81))
* require surrounding boundary checks for review fixes ([9833c94](https://github.com/morluto/rea/commit/9833c94656e1d54e7711dc483bf8091ced14234f))
* **testing:** prioritize real workflows and distinct regressions ([9588482](https://github.com/morluto/rea/commit/9588482bfeeea869d7274d27fb96bac70278dd42))
* **website:** add a CTF showcase and FAQ ([#1077](https://github.com/morluto/rea/issues/1077)) ([a4d77f0](https://github.com/morluto/rea/commit/a4d77f0ff0242b7ab891030d2ffa09a4b4bc1c3c))


### Tests

* **acceptance:** add application workflow MCP parity harness and scenarios ([5ac3dc9](https://github.com/morluto/rea/commit/5ac3dc96f064e691b357aeddc11fa76b7b4d66d1))
* **artifacts:** retire simulated mounts after detach failures ([f591e37](https://github.com/morluto/rea/commit/f591e37a1e45d9b7179ed788c4e7ee77a708c6b0))
* **artifacts:** verify native directory identity on supported Windows runtimes ([#1069](https://github.com/morluto/rea/issues/1069)) ([e94be95](https://github.com/morluto/rea/commit/e94be95c66515fa6fba2a46e4b29850d34141fef))
* **browser:** pin DOM and source-map URL policy classifications ([#1120](https://github.com/morluto/rea/issues/1120)) ([c1d0002](https://github.com/morluto/rea/commit/c1d0002470dc2b6bde73e4ffe438e734dbb24d8d))
* **browser:** reject unmodeled CDP commands in protocol fixtures ([017297c](https://github.com/morluto/rea/commit/017297c40c0c38b9d9c17f5194f0f4c51748f0c3))
* classify application scenarios by their actual boundaries ([0e0b386](https://github.com/morluto/rea/commit/0e0b386dc35bdee1174df9a2d718e0f3e5793666))
* **cli:** verify self-import parity and cleanup ([55c9ce2](https://github.com/morluto/rea/commit/55c9ce26d1b52f359a21512103088048f9aa7492))
* consolidate failure guards and trim unused fixture APIs ([ffd9611](https://github.com/morluto/rea/commit/ffd9611308c91b894a7b0d27f331238f5117dacf))
* **hopper:** cover real boundary failures and CLI parity ([64717ad](https://github.com/morluto/rea/commit/64717ad7daa3152eeb718b4eb5fdcc77f1d76542))
* **hopper:** verify real boundaries and prune redundant happy paths ([7005166](https://github.com/morluto/rea/commit/7005166f5878737fb7b3c7ec4e3d2ee5f4dcce30))
* **mcp:** serialize real process capture and report unavailable authority ([8f9da25](https://github.com/morluto/rea/commit/8f9da251647beb530f6851c9dad5040b19a50a35))
* **process:** cover argv rewrites in native ownership inspection ([09d7b9b](https://github.com/morluto/rea/commit/09d7b9bab53ae968502fd6e19df694cca8cab817))
* **process:** distinguish native startup from producer verification ([9a70fb4](https://github.com/morluto/rea/commit/9a70fb482c974658088167c9d279bd70159e5dc8))
* **process:** expose unavailable capture and unexpected teardown failures ([90b06db](https://github.com/morluto/rea/commit/90b06db6c0b2c5863f292f63a226a5c5678a86ac))
* **process:** report the cause of terminal capture failures ([8a4c4b6](https://github.com/morluto/rea/commit/8a4c4b657fe3b0c249dd2e2147f6960361684c59))
* **process:** retain cancellation checks under unverified host cleanup ([9a5b077](https://github.com/morluto/rea/commit/9a5b0778993102460e333de6cad3ba85383c10be))
* **process:** retire native caches at worker teardown ([a0784c0](https://github.com/morluto/rea/commit/a0784c0d2cb70c48ecfeb0be23c6d68de5ee5be1))
* **process:** serialize real CLI capture boundaries ([82560eb](https://github.com/morluto/rea/commit/82560ebf593a7dfc704698ee312e4d8f1629be8f))
* prune redundant cases and promote configuration lifecycle coverage ([5945915](https://github.com/morluto/rea/commit/5945915f91adf85de91e16b69534bc3ed1d1b69a))
* prune resource-recovery wording assertions ([ae06dcf](https://github.com/morluto/rea/commit/ae06dcf83f65b06abb390d2e0b0ea33543278d6e))
* remove duplicate result assertions before throwing guards ([a1b7d40](https://github.com/morluto/rea/commit/a1b7d40bb0212cdfdddd770a1bccbed097601e0a))
* **session:** preserve live binding after cancelled switches ([1136ea8](https://github.com/morluto/rea/commit/1136ea881029eab59ffb0834149e86a6aff69e3b))
* **setup:** scope removal regression to its fixture client ([fe48e77](https://github.com/morluto/rea/commit/fe48e779c264745d28b5a819e51c06e6b5bd2776))
* **workflows:** verify residual questions in CLI snapshots ([770d2f6](https://github.com/morluto/rea/commit/770d2f60aa948cfdb61c71304be2f3e35f673840))


### Continuous Integration

* run signature target binding regressions on native macOS ([#1107](https://github.com/morluto/rea/issues/1107)) ([1e63144](https://github.com/morluto/rea/commit/1e63144390070f569998271fafd1459788ef3265))

## [6.0.0](https://github.com/morluto/rea/compare/rea-agents-5.0.0...rea-agents-6.0.0) (2026-10-08)


### ⚠ BREAKING CHANGES

* **contracts:** MCP filesystem inputs now require absolute host paths, including target/snapshot paths, evidence bundle paths, managed and firmware inputs, browser/Electron launch paths and expected server paths. Calls such as `open_binary({"path":"./app"})` must send an absolute path such as `/home/analyst/app` or `C:\analysis\app`. Optional paths remain optional. CLI operator-relative paths continue to work. See [#948](https://github.com/morluto/rea/pull/948) and [#1004](https://github.com/morluto/rea/pull/1004).

### Features

* **artifacts:** trace Mach-O dylib resolution in bundles ([78d594c](https://github.com/morluto/rea/commit/78d594cacd376725f833a99402069c103aae9aac))
* **browser:** inspect historical web network captures ([#992](https://github.com/morluto/rea/issues/992)) ([2bf3663](https://github.com/morluto/rea/commit/2bf3663f654386c9fd8c1437c49659df97bd4697))
* **evm:** inspect offline bytecode interfaces through EVMole ([#1051](https://github.com/morluto/rea/issues/1051)) ([7af7bc8](https://github.com/morluto/rea/commit/7af7bc88ce0e8f084eaa0db1e8f834d495440fd9))
* **ghidra:** support native x86 PE applications on Windows ([#1030](https://github.com/morluto/rea/issues/1030)) ([c6dad93](https://github.com/morluto/rea/commit/c6dad932084032bcb32acc61e8066a7784497710))
* **native:** inspect offline ELF layout through pwntools ([#1037](https://github.com/morluto/rea/issues/1037)) ([4fc6565](https://github.com/morluto/rea/commit/4fc6565b0ffb36d7105b3524e08d0c5d603ae07d))
* **native:** inspect recorded crashes through pwntools and pwndbg ([#1054](https://github.com/morluto/rea/issues/1054)) ([163ee09](https://github.com/morluto/rea/commit/163ee09a7425479385e0ed0b5d74043e2587eab2))
* **native:** observe function and Objective-C method calls under LLDB ([1d13cef](https://github.com/morluto/rea/commit/1d13cef5f46f5e07f594bde7b1a4725f189b9a5e))


### Bug Fixes

* **dotnet:** validate managed metadata and CIL boundaries ([#938](https://github.com/morluto/rea/pull/938)) ([bda4ada](https://github.com/morluto/rea/commit/bda4ada7fb6bd7dd70a444bb3c57e34f7f5cc00b))

* **build:** clarify generated-file check hint and drop redundant catalog step ([#998](https://github.com/morluto/rea/pull/998)) ([6f0ef16](https://github.com/morluto/rea/commit/6f0ef160501ea3b24dfa2939dfcd3eea0dc13ee7))

* **release:** extend npm propagation window and improve diagnostics ([#943](https://github.com/morluto/rea/pull/943)) ([06b047a](https://github.com/morluto/rea/commit/06b047a0929369d5b8635b3651da115c8fcd53a7))

* **contracts:** require absolute local paths for session filesystem inputs ([#948](https://github.com/morluto/rea/pull/948)) ([5b172b1](https://github.com/morluto/rea/commit/5b172b1042fc09a4e12d956018f15d86cf397ffe))

* **ci:** generate source catalog before shard tests ([#1002](https://github.com/morluto/rea/pull/1002)) ([eb8f649](https://github.com/morluto/rea/commit/eb8f6491a88bfa79d13f7923e4ef94d791f6ba4d))

* **contracts:** require absolute local paths for remaining caller-supplied file inputs ([#1004](https://github.com/morluto/rea/pull/1004)) ([cbc0dd1](https://github.com/morluto/rea/commit/cbc0dd1e7ca36fa3504a9ea8eae303a0876b176b))

* **cli:** classify ENOTDIR JSON input failures ([#1000](https://github.com/morluto/rea/pull/1000)) ([a6132be](https://github.com/morluto/rea/commit/a6132be0546d6a9e3fa83426c8b59b1280b3e5bd))

* **browser:** preserve authorized redirect hops ([#986](https://github.com/morluto/rea/pull/986)) ([ae0f725](https://github.com/morluto/rea/commit/ae0f725fad368730c6198d49716ccc410bca0536))

* **mcp:** reject unknown MCP tool inputs ([#975](https://github.com/morluto/rea/pull/975)) ([fe64fd6](https://github.com/morluto/rea/commit/fe64fd65d93eff202ad90145544dc9ff84651974))

* **release:** publish from explicit source checkpoints ([#1003](https://github.com/morluto/rea/pull/1003)) ([64c7188](https://github.com/morluto/rea/commit/64c71880ae4f7bc658ffce46eb729c4141dbdf19))

* **release:** publish from explicit source checkpoints ([#1006](https://github.com/morluto/rea/pull/1006)) ([b4fc0ec](https://github.com/morluto/rea/commit/b4fc0ecaa1f6b912dc27880e6b6127ace47abc2e))

* **javascript:** bound semantic node projection for resource safety ([#966](https://github.com/morluto/rea/pull/966)) ([96a46ad](https://github.com/morluto/rea/commit/96a46ada0a36f0349f2b0fc20b4c932401b4ad84))

* **ci:** avoid slow Azure archive for the native cross compiler ([#1016](https://github.com/morluto/rea/issues/1016)) ([51956c1](https://github.com/morluto/rea/commit/51956c1a49a7dc9ed70a6fba480a670a7e7b2b9b))
* **ci:** decouple stdio smoke tests from Linux display probes ([#1014](https://github.com/morluto/rea/issues/1014)) ([93731e1](https://github.com/morluto/rea/commit/93731e17ddea76db86dfa84bb54536dcf8ebfa0b))
* **cli:** stream large JavaScript JSON results ([#1024](https://github.com/morluto/rea/issues/1024)) ([0e25bef](https://github.com/morluto/rea/commit/0e25befe78f220691abe5d0291cc04a75c9cc877))
* **javascript:** complete large-ASAR analysis with file-local projection ([#1055](https://github.com/morluto/rea/issues/1055)) ([b9fb438](https://github.com/morluto/rea/commit/b9fb43883570bef7cb29fd16f27c25d5a7e5bb54))
* **javascript:** recognize digits in artifact URI schemes ([#1045](https://github.com/morluto/rea/issues/1045)) ([03424ae](https://github.com/morluto/rea/commit/03424ae91ef22efd57db1bdde9379a3ac450b8f7))
* **javascript:** reconstruct HTML script loads accurately ([#1042](https://github.com/morluto/rea/issues/1042)) ([1154f2f](https://github.com/morluto/rea/commit/1154f2f03c0b0bb6cb6c5da09b8d8e1c837febc4))
* **javascript:** report application analysis progress on the CLI ([#1008](https://github.com/morluto/rea/issues/1008)) ([7b18c58](https://github.com/morluto/rea/commit/7b18c581409848077de7a9cb6d7d1a0b91a02e12))
* **javascript:** resolve module URLs and reject invalid exports targets ([#1031](https://github.com/morluto/rea/issues/1031)) ([8d5c88f](https://github.com/morluto/rea/commit/8d5c88f17cde4ab4fa54c5142f0a45e612619a53))
* **javascript:** resolve root package exports arrays ([#1046](https://github.com/morluto/rea/issues/1046)) ([53409ab](https://github.com/morluto/rea/commit/53409ab1968d60c77f98feedefe237a08859a95c))
* **mcp:** advertise JSON values without recursive schemas ([#995](https://github.com/morluto/rea/issues/995)) ([7425f70](https://github.com/morluto/rea/commit/7425f70fd0247a7ea7192deb959fd6f48ba83a21)), closes [#919](https://github.com/morluto/rea/issues/919)
* **mcp:** bound capture comparison input schema depth ([#1005](https://github.com/morluto/rea/issues/1005)) ([6b55de0](https://github.com/morluto/rea/commit/6b55de017badc9066642e1ff2561eb1da0ff93f8))
* **process:** preserve partial evidence and verify detached cleanup ([#1011](https://github.com/morluto/rea/issues/1011)) ([63cf28f](https://github.com/morluto/rea/commit/63cf28fd8f8acaf656e993300a2a24280b2fd692))
* **release:** support built-in credentials and refresh release boundary ([6a278a6](https://github.com/morluto/rea/commit/6a278a68dd4fa69b9153697ecb7bba7de4c55c32))
* **release:** support default credentials and record 5.0.0 boundary ([#1012](https://github.com/morluto/rea/issues/1012)) ([6a278a6](https://github.com/morluto/rea/commit/6a278a68dd4fa69b9153697ecb7bba7de4c55c32))
* **release:** sync 5.0.0 checkpoint back to main ([966cca8](https://github.com/morluto/rea/commit/966cca8efe5ed08b3285cd06409688d871eb5e6b))
* **snapshot:** replay validated workflow evidence ([#984](https://github.com/morluto/rea/issues/984)) ([1d62e54](https://github.com/morluto/rea/commit/1d62e54e1f976e64130e4e9b651c3180aa4fa727))
* **windows:** allow Java to read retained target snapshots ([#1027](https://github.com/morluto/rea/issues/1027)) ([28d5c39](https://github.com/morluto/rea/commit/28d5c397c83f901e4086083868041711371ad32a))


### Performance Improvements

* **artifacts:** replace quadratic ZIP overlap checks ([#1013](https://github.com/morluto/rea/issues/1013)) ([76e7e51](https://github.com/morluto/rea/commit/76e7e510bb2d7d37728ca50749d524beb5890cf8))
* **javascript:** cache canonical export comparison sort keys ([#1028](https://github.com/morluto/rea/issues/1028)) ([63ba742](https://github.com/morluto/rea/commit/63ba7424c0ab69b94397e8913f8e231de111583f))


### Code Refactoring

* **build:** generate MCP tool catalog at build time instead of committing it ([#997](https://github.com/morluto/rea/pull/997)) ([35a4e18](https://github.com/morluto/rea/commit/35a4e18d3028014e24d2e209ec99a590fde63152))

* **process:** separate capture implementation from analyst workflows ([#988](https://github.com/morluto/rea/pull/988)) ([6aa9afb](https://github.com/morluto/rea/commit/6aa9afb5493a97801eb1126a0dcf11f9705165db))

* **artifacts:** move inventory and extraction into provider owners ([#1032](https://github.com/morluto/rea/issues/1032)) ([6e4535c](https://github.com/morluto/rea/commit/6e4535c1011f1982e9ab07b7ebcd600c19cd494d))
* remove abandoned test-only analysis scaffolding ([c93422a](https://github.com/morluto/rea/commit/c93422a898fdbedb7d28709144b4337a2669440b))


### Documentation

* improve Korean wording and particles ([#1047](https://github.com/morluto/rea/issues/1047)) ([c5d165b](https://github.com/morluto/rea/commit/c5d165bd03fed95a0b0105661d3ba7e0efbfa449))
* simplify the English README and organize guides ([#1043](https://github.com/morluto/rea/issues/1043)) ([28f10cf](https://github.com/morluto/rea/commit/28f10cf2bc7b7c590700b50d47072015f3e3c66e))


### Tests

* **process:** wait for observable snapshot ctime changes ([#999](https://github.com/morluto/rea/pull/999)) ([161ed91](https://github.com/morluto/rea/commit/161ed9157134d5c3b0fbae19ceb756ac58a26c04))

* **browser:** consolidate CDP workflows and colocate parser coverage ([2682904](https://github.com/morluto/rea/commit/26829045d0f0e744bb60d6babc2dc3312f4bfa53))
* **ci:** stabilize browser source identity fixture delivery ([#1023](https://github.com/morluto/rea/issues/1023)) ([ed725da](https://github.com/morluto/rea/commit/ed725dace4a689e4e5c804dc6bf06c7fc663c7c9))
* **cli:** reduce repeated startup and filesystem setup ([d88d6c1](https://github.com/morluto/rea/commit/d88d6c1897740ccbd6c57f4ba01861fc751fb3a8))
* consolidate service and process fixtures ([f8a53a8](https://github.com/morluto/rea/commit/f8a53a8c065f1ccbdaa051a4e1ef267a2047d759))
* **javascript:** consolidate source analysis and export regressions ([f517a5a](https://github.com/morluto/rea/commit/f517a5a1d7c0766ed50f8dfd5ee69e65525ac744))
* **javascript:** cover plain long-line loader identities ([#1025](https://github.com/morluto/rea/issues/1025)) ([984fc27](https://github.com/morluto/rea/commit/984fc27ce19d57f708bdae688a258cf8663cdea6))
* **mcp:** consolidate SDK schema checks and scenario ports ([9c3479e](https://github.com/morluto/rea/commit/9c3479ed95100d8ee5ed4d9158a4550e4ac2a752))
* **providers:** verify framing through client socket boundaries ([1fd1989](https://github.com/morluto/rea/commit/1fd1989d342375a01b6d14b282ad58001b7d1800))
* prune redundant conformance checks and document test priorities ([aafdf8a](https://github.com/morluto/rea/commit/aafdf8a01b42fb6fd927c0f2a66e758e1a510abc))

## [5.0.0](https://github.com/morluto/rea/compare/rea-agents-4.1.0...rea-agents-5.0.0) (2026-10-07)


### ⚠ BREAKING CHANGES

* **native:** preserve incomplete native UI captures ([#991](https://github.com/morluto/rea/issues/991))
* **android:** Android analysis now requires a full JDK 17 or newer with its compiler module for the packaged Java source bridge.

### Features

* **apple:** project macOS bundle anatomy in application graphs ([88c940b](https://github.com/morluto/rea/commit/88c940b165d788a491e212ea93e00462c4dde6a2))
* **apple:** project macOS bundle anatomy in application graphs ([dd3e7ae](https://github.com/morluto/rea/commit/dd3e7aef0d52c478f6cdf475501c42ebe7f5c97e))
* **application:** wire Android and Apple inventory graph tools ([#852](https://github.com/morluto/rea/issues/852)) ([e0fd820](https://github.com/morluto/rea/commit/e0fd8207a1fb738bcc34f204b55c4fa154f5f02d))
* **browser:** attribute native execution and listener sources ([#917](https://github.com/morluto/rea/issues/917)) ([b5afa5f](https://github.com/morluto/rea/commit/b5afa5f91eed9ae31d670aeab9bbf5112d790ec2))
* **browser:** capture correlated network content and lifecycle evidence ([#797](https://github.com/morluto/rea/issues/797)) ([f9eaf05](https://github.com/morluto/rea/commit/f9eaf056ef58215094513176a70fabae0740081f))
* **browser:** trace captured website module imports ([#879](https://github.com/morluto/rea/issues/879)) ([01be082](https://github.com/morluto/rea/commit/01be082e9e11c78b91828c06a9c543c754783c07))
* **browser:** trace captured website source-map locations ([#897](https://github.com/morluto/rea/issues/897)) ([f430c41](https://github.com/morluto/rea/commit/f430c416c72d444fbe521e0263f8935da4cdb040))
* **javascript:** recover readable modules with Wakaru ([#848](https://github.com/morluto/rea/issues/848)) ([166dcd2](https://github.com/morluto/rea/commit/166dcd21d06f687a9c480a6a6d36beb3b4954dd0))
* **native:** decode chained fixups, binds, ObjC categories and properties ([a657557](https://github.com/morluto/rea/commit/a65755728f7a10d984514c75fa863b84ddcdaee9))
* **native:** decode chained fixups, binds, ObjC categories and properties ([3e24a72](https://github.com/morluto/rea/commit/3e24a72465fe6c628db1f836e93d74d7f4a92b80))
* **native:** open iOS-style and iOS-on-Mac wrapper app bundles ([2ed89e6](https://github.com/morluto/rea/commit/2ed89e6529924248d2e21084f8730bedbb16bc3f))
* **native:** open iOS-style and iOS-on-Mac wrapper app bundles ([aeebba3](https://github.com/morluto/rea/commit/aeebba391ee5c288b75cd828e7d18d32b40aa698))
* **web:** export captured scripts for JavaScript application analysis ([#801](https://github.com/morluto/rea/issues/801)) ([472b72a](https://github.com/morluto/rea/commit/472b72a53068a8e2ec78fe239d687023482daaa7))
* **website:** add a shared back-to-top link ([5047373](https://github.com/morluto/rea/commit/504737300632d8644fbd6c658d2c97e38bb54c3b))
* **website:** introduce REA and the DX-Ball reconstruction ([#906](https://github.com/morluto/rea/issues/906)) ([4e3953c](https://github.com/morluto/rea/commit/4e3953cc45ce9c21786a7a6fc495d2350aa85d24))


### Bug Fixes

* address review nits from batch integration follow-ups ([#818](https://github.com/morluto/rea/issues/818)) ([5a0e0ba](https://github.com/morluto/rea/commit/5a0e0ba3b81ea0ec336addb07da98ec7bc0a35d3))
* **android:** align runtime suffix inference ([#977](https://github.com/morluto/rea/issues/977)) ([fb3749a](https://github.com/morluto/rea/commit/fb3749aff692a7a8225dff00a4516b48a76866b6))
* **android:** bound fragmented JADX MCP frame memory ([#937](https://github.com/morluto/rea/issues/937)) ([9e39795](https://github.com/morluto/rea/commit/9e397958951edb543134e3ad57e7ab253d6df21a))
* **android:** preserve JVM settings and reuse metadata sessions ([#908](https://github.com/morluto/rea/issues/908)) ([eab34a9](https://github.com/morluto/rea/commit/eab34a9d8c5eebad6b04b85750be0276d679c3f9))
* **apple:** attribute only application-root components in macOS inventories ([5524970](https://github.com/morluto/rea/commit/55249704c5c83cbf8d20ac7869863cc196da00a6))
* **apple:** count only real framework version directories ([2e81e86](https://github.com/morluto/rea/commit/2e81e867b24da8314f666f62d154de5803040cdf))
* **apple:** pair bridge hypotheses within one application root ([7acf4e7](https://github.com/morluto/rea/commit/7acf4e741a6a314ea7aabb18fc757e196158ff76))
* **apple:** pair bridge hypotheses within one application root ([9226ade](https://github.com/morluto/rea/commit/9226ade5114f287eb8e1b00b08dd91da1cc66003))
* **apple:** traverse keyed archive hierarchy collections ([#976](https://github.com/morluto/rea/issues/976)) ([71ac83f](https://github.com/morluto/rea/commit/71ac83f3dd376135098f460c86e7897183456ec5))
* **artifacts:** accept APFS image disks ejected with their container ([d93ebec](https://github.com/morluto/rea/commit/d93ebec9df951d40e66ced667f07fadd2dd5d25a))
* **artifacts:** accept APFS image disks ejected with their container ([b72c079](https://github.com/morluto/rea/commit/b72c079a9a90c374bd6dd30ff8c4387306b8f59b))
* **artifacts:** accept the bundle subject when extracting an app bundle ([#891](https://github.com/morluto/rea/issues/891)) ([37d2eba](https://github.com/morluto/rea/commit/37d2ebac4c2a524eec6e32c4c57cbbb632491ad8))
* **artifacts:** decode flat keyed-archive NIBs with data and shared references ([b3f013f](https://github.com/morluto/rea/commit/b3f013fa183e8351319a053575aeee5df337c276))
* **artifacts:** decode flat keyed-archive NIBs with data and shared references ([2a4667b](https://github.com/morluto/rea/commit/2a4667bb79117b202abb009c0bb9ebfdfde57158))
* **artifacts:** harden reader lifecycle boundaries ([#951](https://github.com/morluto/rea/issues/951)) ([2366bda](https://github.com/morluto/rea/commit/2366bda37b1084016d42a0d06920dc57e7c7723f))
* **artifacts:** keep the post-snapshot detach check out of provenance ([62634e4](https://github.com/morluto/rea/commit/62634e4c0177bde8a08decc356da98fbe25d2000))
* **artifacts:** preserve reader failure diagnostics ([#987](https://github.com/morluto/rea/issues/987)) ([fc4a9a0](https://github.com/morluto/rea/commit/fc4a9a05922ce8474fd0717bc800343b0a95bd41))
* **artifacts:** project compiled AppKit actions from the control to its target ([b08228d](https://github.com/morluto/rea/commit/b08228d19f8a0f6dbc940e8d322ef2bb42d2ce1a))
* **artifacts:** project compiled AppKit actions from the control to its target ([#905](https://github.com/morluto/rea/issues/905)) ([900d7c8](https://github.com/morluto/rea/commit/900d7c8606cbc1ccbca818827a55bf2eab28bca4))
* **artifacts:** project UIKit runtime outlet and event connections ([aa8082e](https://github.com/morluto/rea/commit/aa8082ea6c0898feb4d842135aea6b9539f769f8))
* **artifacts:** project UIKit runtime outlet and event connections ([8b24387](https://github.com/morluto/rea/commit/8b243877c22a5550d005e7b8abf93791ce8566b9))
* **artifacts:** read AppKit connectors from flat keyed-archive NIBs ([#900](https://github.com/morluto/rea/issues/900)) ([27c272b](https://github.com/morluto/rea/commit/27c272bd9a42e7235c7991881196c60dbc126714))
* **artifacts:** read keyed archive dictionaries keyed UID as dictionaries ([cfd2b0c](https://github.com/morluto/rea/commit/cfd2b0c75dfb9d51b936788a46d0338145803ece))
* **artifacts:** read keyed archive dictionaries keyed UID as dictionaries ([35c82b9](https://github.com/morluto/rea/commit/35c82b93eb2579687bb446c3a8a2a9f1a7563d28))
* **artifacts:** report which path constraint failed ([#847](https://github.com/morluto/rea/issues/847)) ([3f1a77f](https://github.com/morluto/rea/commit/3f1a77f68ec4355d8b792ccb2970bc03485889c9))
* **browser:** distinguish computed call keys from identifiers ([#808](https://github.com/morluto/rea/issues/808)) ([02beb74](https://github.com/morluto/rea/commit/02beb745358f02bdaabed4bb523c5e3527a9841e))
* **browser:** distinguish WebMCP registration frame owners ([#813](https://github.com/morluto/rea/issues/813)) ([b3b44d8](https://github.com/morluto/rea/commit/b3b44d8a2d8b2aa70a8ed8b9cddf365865fcc53f))
* **browser:** fingerprint cookies at the selected page URL ([#763](https://github.com/morluto/rea/issues/763)) ([78014e3](https://github.com/morluto/rea/commit/78014e3d149f762c848581a0aac7e44f75d51225))
* **browser:** identify NodeNext TypeScript original source artifacts ([#811](https://github.com/morluto/rea/issues/811)) ([e84ad86](https://github.com/morluto/rea/commit/e84ad86a7578fb46568663aca6fe6a6f3986cc8d))
* **browser:** preserve evidence through deep AST analysis ([#924](https://github.com/morluto/rea/issues/924)) ([f826aa8](https://github.com/morluto/rea/commit/f826aa893fa7d55e87d907f0c94c39421a166dd8))
* **browser:** preserve form destinations and satisfies mutation uncertainty ([#825](https://github.com/morluto/rea/issues/825)) ([6dd719e](https://github.com/morluto/rea/commit/6dd719eaf605b37cd5dad6d01d33527ca9d59f06)), closes [#820](https://github.com/morluto/rea/issues/820)
* **browser:** preserve Link header value delimiters ([#805](https://github.com/morluto/rea/issues/805)) ([dd36405](https://github.com/morluto/rea/commit/dd3640548fe3d1e8b92784a63fac55d757dcc1f0))
* **build:** validate installed dependencies before cache hits ([#982](https://github.com/morluto/rea/issues/982)) ([a45fe86](https://github.com/morluto/rea/commit/a45fe86a39b9e7a7c21e3665b6de4763cb72d782))
* capture IndexedDB object-store record fingerprints ([#809](https://github.com/morluto/rea/issues/809)) ([21a8bd0](https://github.com/morluto/rea/commit/21a8bd0ccde2326c8bc022714a88a438d8b89dde))
* **cli:** align structured output guard with native flags ([#777](https://github.com/morluto/rea/issues/777)) ([e9fac56](https://github.com/morluto/rea/commit/e9fac56232e74c8287863ca5c4cc7d8e39fb4a40))
* **cli:** emit empty structured filter projections ([#914](https://github.com/morluto/rea/issues/914)) ([2db668f](https://github.com/morluto/rea/commit/2db668f6ca91d2514a354fd459239b84031812e7))
* **cli:** honor the selected native plist path ([#773](https://github.com/morluto/rea/issues/773)) ([0374865](https://github.com/morluto/rea/commit/0374865836aa4960657fb92f588c71e35dd3bed8))
* **cli:** preserve output and comparison input validation ([#981](https://github.com/morluto/rea/issues/981)) ([d5c43d6](https://github.com/morluto/rea/commit/d5c43d65f0f6a1de8fb2eb5f2c1940a6ea2af20c))
* **cli:** preserve unsupported historical-source imports ([#795](https://github.com/morluto/rea/issues/795)) ([911d580](https://github.com/morluto/rea/commit/911d58063477912042da5e9e573a9e8008956622))
* **contracts:** align CLI/MCP boundary contracts ([#946](https://github.com/morluto/rea/issues/946)) ([4a60738](https://github.com/morluto/rea/commit/4a6073810a955d058c10f209157cbd68832a92c5))
* **deps:** remediate smol-toml advisories ([93091ab](https://github.com/morluto/rea/commit/93091abb4dbd3cceee217d179db816895df24d70))
* **deps:** remediate smol-toml advisories ([c55ae3b](https://github.com/morluto/rea/commit/c55ae3b9eccc17e6e8f4369e13044995d0650704))
* **dotnet:** compare members with undecoded signatures by exact identity ([28fd49f](https://github.com/morluto/rea/commit/28fd49f0f6cf54e373411f5999e6b5722dd826f5))
* **dotnet:** compare members with undecoded signatures by exact identity ([d52af3b](https://github.com/morluto/rea/commit/d52af3b321a321964598fb302edeb26552c9dffd))
* **dotnet:** inspect native boundaries of non-managed and malformed PEs ([d5f28fb](https://github.com/morluto/rea/commit/d5f28fb29c5c3e8acef940fcae042e660e3a4d72))
* **dotnet:** inspect native boundaries of non-managed and malformed PEs ([d98dcfa](https://github.com/morluto/rea/commit/d98dcfa8c2e46a7cc918aeb01058c26c4a84060c))
* **dotnet:** keep a decoded member unknown beside an undecoded counterpart ([76b7020](https://github.com/morluto/rea/commit/76b70203d941ab85c1772f330407fd832d438c9c))
* **dotnet:** keep admitted CLI header facts when metadata is unreadable ([e5ba693](https://github.com/morluto/rea/commit/e5ba6934e4ff819c09077ca70bd2417d37f85bc0))
* **dotnet:** name the shared key in exact-signature ambiguities ([7714e76](https://github.com/morluto/rea/commit/7714e763d9ac2e87994068b3dee37ca6c5ffc6f4))
* **dotnet:** treat ambiguous undecoded members as possible counterparts ([73370e1](https://github.com/morluto/rea/commit/73370e1c064899753988581c9a821e0e7f579561))
* **errors:** report union input issues at the union's path ([bddeb63](https://github.com/morluto/rea/commit/bddeb634b583cf4f7d5fa6cf3a1ee821e05d2923))
* **evaluation:** canonicalize Unicode argument keys ([#980](https://github.com/morluto/rea/issues/980)) ([0a4caf4](https://github.com/morluto/rea/commit/0a4caf4a0a1355b6a121fc88886b22e55843ac76))
* **firmware:** accept the verified Binwalk and Unblob release lines ([#844](https://github.com/morluto/rea/issues/844)) ([bef4321](https://github.com/morluto/rea/commit/bef4321afb3d0d480e8a04ad7e256663542caa3d))
* **firmware:** retain multi-file extraction failures ([#978](https://github.com/morluto/rea/issues/978)) ([8aaf9a1](https://github.com/morluto/rea/commit/8aaf9a19788beb6612332505850ad3407cb00027))
* **ghidra:** admit the 12.1 line and the install's JDK range ([#840](https://github.com/morluto/rea/issues/840)) ([5cbf06c](https://github.com/morluto/rea/commit/5cbf06c7ad0ace599721bffd7da566b8a790b622))
* **ghidra:** select exact packaged bridge scripts ([#800](https://github.com/morluto/rea/issues/800)) ([894c30e](https://github.com/morluto/rea/commit/894c30ef02d946f0c8de3ae6c9168d9525d95033))
* **ida:** share concurrent session cleanup ([#950](https://github.com/morluto/rea/issues/950)) ([f14b6a8](https://github.com/morluto/rea/commit/f14b6a84306116716e78c5ffc84353ac07939593))
* **installer:** validate exact semantic versions ([#954](https://github.com/morluto/rea/issues/954)) ([248972f](https://github.com/morluto/rea/commit/248972f327776687037dc07099117584c0674e77))
* integrate 24 reviewed browser/native/semantics corrections ([#815](https://github.com/morluto/rea/issues/815)) ([3af3811](https://github.com/morluto/rea/commit/3af3811ab0a212b6aab6185628d47ecad37958fc))
* **javascript:** advertise the exact empty seed rule and match empty API keys ([35e5508](https://github.com/morluto/rea/commit/35e5508fd095a062d7477bd6bb7d2d8e28201cd8))
* **javascript:** analyze source maps with empty source names ([58ef8ac](https://github.com/morluto/rea/commit/58ef8ac3aa803d7b64dd12a5b2a2e8ec24261060))
* **javascript:** analyze sources containing empty string literals ([e7cbfe0](https://github.com/morluto/rea/commit/e7cbfe04fdfd7affe50dba9e2c7a9a0a72291041))
* **javascript:** analyze sources containing empty string literals ([11fc3b9](https://github.com/morluto/rea/commit/11fc3b981509e8107b10b2e75363f5bb489879db))
* **javascript:** filter keyed-collection receivers only for get/delete ([00f707b](https://github.com/morluto/rea/commit/00f707b250451246d69a1205c39c6843fab6bb5b))
* **javascript:** handle deep AST traversal and addition without stack overflow ([#915](https://github.com/morluto/rea/issues/915)) ([62b3711](https://github.com/morluto/rea/commit/62b37111e7f09887eb712c6e8e721e0334cf10b9))
* **javascript:** handle deep static member paths ([#939](https://github.com/morluto/rea/issues/939)) ([348c65c](https://github.com/morluto/rea/commit/348c65c7ece1aee280f9431d995996b444e7549d))
* **javascript:** keep bare relative URLs for computed-method XHR ([e32028d](https://github.com/morluto/rea/commit/e32028d1b566872ba8cd08fc6800c198d6aef30b))
* **javascript:** keep computed-method XHR request URLs ([602d002](https://github.com/morluto/rea/commit/602d0021d45a6cdab9f806554f3ee12ea670ec97))
* **javascript:** keep exact empty env keys and method names ([522c2d0](https://github.com/morluto/rea/commit/522c2d0ecb1eb7be262eaef2926cceac9a68badc))
* **javascript:** keep exact empty env keys and method names ([f7954a8](https://github.com/morluto/rea/commit/f7954a8fd692f262ef3ce1507b957681150ce9c4)), closes [#783](https://github.com/morluto/rea/issues/783)
* **javascript:** keep exact empty require paths and request fields ([ad1f6b5](https://github.com/morluto/rea/commit/ad1f6b508fbdd44d8bf1884ed96ae69082808e7d)), closes [#783](https://github.com/morluto/rea/issues/783)
* **javascript:** keep exact empty values in graph identities ([f608127](https://github.com/morluto/rea/commit/f608127635ed8e0d105ad95252e5ea0dff899f5b))
* **javascript:** keep exact empty values in graph identities ([63012ee](https://github.com/morluto/rea/commit/63012eeb601fc74ca82f3a027d852a5da1b099d2))
* **javascript:** keep keyed-collection reads out of endpoints ([9075ce7](https://github.com/morluto/rea/commit/9075ce71ada4334407aa2d194dc82e3031e30260))
* **javascript:** keep keyed-collection reads out of endpoints ([eb68761](https://github.com/morluto/rea/commit/eb68761eb0a35b876e33dd6115d0d07f97e99dd5))
* **javascript:** keep literal HTTP methods on storage-named receivers ([9f48a76](https://github.com/morluto/rea/commit/9f48a76e1186cc43c6928eff1c82e93280caee1a))
* **javascript:** keep literal-method and URL-literal requests on aliased receivers ([e3e7664](https://github.com/morluto/rea/commit/e3e76646657e950e24241ba715eb97ea385933e9))
* **javascript:** keep mutated object initializer values unknown ([#752](https://github.com/morluto/rea/issues/752)) ([6caa38a](https://github.com/morluto/rea/commit/6caa38a0cad369ddff52b08f8d7d44c1b92ecac0))
* **javascript:** keep storage open versions out of XHR endpoints ([4f51103](https://github.com/morluto/rea/commit/4f5110306d9edab94bf63bf81cf259324d96af57))
* **javascript:** keep storage open versions out of XHR endpoints ([898b0f6](https://github.com/morluto/rea/commit/898b0f62d76ea1cf793140cb255cad16ab85b44d))
* **javascript:** keep XHR and client endpoints that receiver spellings hid ([05f43ed](https://github.com/morluto/rea/commit/05f43ed388ae4e9316d320b592b6eba5b119ce89))
* **javascript:** leave empty application values unlabeled ([527b76e](https://github.com/morluto/rea/commit/527b76ef78e84d29bb41bd45f1f83fae05ca66ca))
* **javascript:** match exact empty literal channels and seeds ([e20da1f](https://github.com/morluto/rea/commit/e20da1f205b105b1b6a5decd3c2d0fe36fd12410))
* **javascript:** never read window or document open as XHR ([ae849a7](https://github.com/morluto/rea/commit/ae849a72811857ba9755962ec48a1d76c9d1181a))
* **javascript:** preserve computed Electron member uncertainty ([3a4a63f](https://github.com/morluto/rea/commit/3a4a63f70a2e42fb1fa48881e08b08d612289f2e))
* **javascript:** preserve computed Electron member uncertainty ([1260cac](https://github.com/morluto/rea/commit/1260cacc67b8e0c93fb9434452053feca956e7e7))
* **javascript:** project decoded file URL paths ([#810](https://github.com/morluto/rea/issues/810)) ([2572e1e](https://github.com/morluto/rea/commit/2572e1eb2f853a4cebfc8303d9e293e1d106d608))
* **javascript:** read open() endpoints only from XHR method/URL pairs ([63e0822](https://github.com/morluto/rea/commit/63e0822cc794bd6ec1688340b3230ffb6b5c4a8c))
* **javascript:** read open() endpoints only from XHR method/URL pairs ([1be3705](https://github.com/morluto/rea/commit/1be370543f7ea39016f86ebdec80a8ceaf7f8a28))
* **javascript:** read substitution-free templates as exact strings ([c371d6e](https://github.com/morluto/rea/commit/c371d6e1e9cceb28e6cfc874e14c4e740bb87751))
* **javascript:** read substitution-free templates as exact strings ([77cf757](https://github.com/morluto/rea/commit/77cf75710369acc6c304ec352ab25aa7274e04b1))
* **javascript:** resolve bare source-map and worker URLs next to the script ([#890](https://github.com/morluto/rea/issues/890)) ([45fcd28](https://github.com/morluto/rea/commit/45fcd28b4018723bdb508a9229b74ab9eb749f75))
* **javascript:** retain recovered call argument positions ([#929](https://github.com/morluto/rea/issues/929)) ([e6ba9c3](https://github.com/morluto/rea/commit/e6ba9c3af3053485f154825eea6a156127328be9))
* **linux:** improve Hopper reliability and CachyOS support ([#963](https://github.com/morluto/rea/issues/963)) ([98b2b02](https://github.com/morluto/rea/commit/98b2b027afd8c80b68e9daaf97bdaa4d942105cc))
* **mcp:** advertise reserved process environment key ([#949](https://github.com/morluto/rea/issues/949)) ([e0d76ae](https://github.com/morluto/rea/commit/e0d76ae80ddc70ae4d5afcbd1427afb81eee3669))
* **mcp:** isolate optional observation adapter failures ([#838](https://github.com/morluto/rea/issues/838)) ([be3cfbf](https://github.com/morluto/rea/commit/be3cfbffdfbbb65da75dcec0518e2ebf387e66bc))
* **mcp:** preserve exact guided prompt context ([#761](https://github.com/morluto/rea/issues/761)) ([66c26f2](https://github.com/morluto/rea/commit/66c26f280b1d494806ee182b52564166760f0ae2))
* **native-ui:** handle incomplete accessibility child collections ([#944](https://github.com/morluto/rea/issues/944)) ([ac3bae3](https://github.com/morluto/rea/commit/ac3bae3cb97c4fb622eb1b6ac1f3b84e6a70ba03))
* **native:** inspect plists containing data, dates, and non-finite reals ([bc2cd8b](https://github.com/morluto/rea/commit/bc2cd8b874e115eee446860043758a80bd583ad0))
* **native:** inspect plists containing data, dates, and non-finite reals ([5ead2cf](https://github.com/morluto/rea/commit/5ead2cfbc47896b43502363d3568330f5d94762e))
* **native:** keep echoed codesign paths out of signature fields ([#865](https://github.com/morluto/rea/issues/865)) ([4aa2b60](https://github.com/morluto/rea/commit/4aa2b60c1d84607a138395ae93260b2e50c2a721))
* **native:** keep echoed Mach-O paths out of load commands and symbols ([ab985c6](https://github.com/morluto/rea/commit/ab985c6a10e9da856ed151100cee8459793c3573))
* **native:** keep echoed Mach-O paths out of load commands and symbols ([37fe105](https://github.com/morluto/rea/commit/37fe105ba168488d05226f2912bed802e2d48d75))
* **native:** keep integral plist reals beyond the JSON range as reals ([#860](https://github.com/morluto/rea/issues/860)) ([3b92a2b](https://github.com/morluto/rea/commit/3b92a2bceddaa1659654da08160813a3affbc6b7))
* **native:** keep plist XML element types for large numbers ([f85056d](https://github.com/morluto/rea/commit/f85056d83e42a461c8c947792774580294d0ceb9))
* **native:** keep the resolved bundle plist and permission failures ([418a556](https://github.com/morluto/rea/commit/418a5562f6f640503c751924a4787586c2c5c98a))
* **native:** pass Swift symbols to swift-demangle as operands ([dd90965](https://github.com/morluto/rea/commit/dd90965058a9e6f7dd7f30eb7e462572e777db7f))
* **native:** pass Swift symbols to swift-demangle as operands ([6c88094](https://github.com/morluto/rea/commit/6c88094da45258b346fe594764e561f999622a58))
* **native:** preserve incomplete native UI captures ([#991](https://github.com/morluto/rea/issues/991)) ([9f496ef](https://github.com/morluto/rea/commit/9f496ef2d4a3aa68816287bf5d2ba1620d72c97a))
* **native:** report exact plist integers beyond the JSON number range ([c9f49db](https://github.com/morluto/rea/commit/c9f49db907db0513ad8b22c9b2bbdcee400aff11))
* **native:** report exact plist integers beyond the JSON number range ([430c297](https://github.com/morluto/rea/commit/430c297ca4ddb3491c2b835b889486e6a2ffdc17))
* **native:** report plist permission denials as access failures ([5738a0c](https://github.com/morluto/rea/commit/5738a0cf8c111833847fecb2f7d0c2ee35eabbd6))
* **native:** report why a selected plist cannot be inspected ([14f9b3d](https://github.com/morluto/rea/commit/14f9b3d93119a60a3cf5f3d9c138ca829a5462e8))
* **native:** report why a selected plist cannot be inspected ([0674fac](https://github.com/morluto/rea/commit/0674facd468c3321584ece908031feee7220b9c6))
* **plist:** keep character references beyond Unicode literal ([5afd8a8](https://github.com/morluto/rea/commit/5afd8a850b2ebd62e3400a5e2ece1a1cfa98bab6))
* **plist:** read XML plists containing a __proto__ key ([faaee69](https://github.com/morluto/rea/commit/faaee693d5bb4bb957387ebd0f4338513c4c914a))
* **plist:** read XML plists containing a __proto__ key ([a08be51](https://github.com/morluto/rea/commit/a08be51e9f0d23bd46b66bbdb88dbda44bc54c88))
* **plist:** report omitted __proto__ entries in signatures and Interface Builder ([15ab5db](https://github.com/morluto/rea/commit/15ab5dbcaf3fac09756e98926373965247dad622))
* **plist:** report omitted __proto__ entries in signatures and Interface Builder ([6729ee7](https://github.com/morluto/rea/commit/6729ee7636889a0a2ebc9fca8e35860476f8ca34))
* preserve native UI failure reasons and dedupe version literals ([#854](https://github.com/morluto/rea/issues/854)) ([2d4a910](https://github.com/morluto/rea/commit/2d4a910fcd30e8d5b96fcb957b931e9aa3e4ab0c))
* **process:** clarify Windows capture support and recovery ([#798](https://github.com/morluto/rea/issues/798)) ([50787b2](https://github.com/morluto/rea/commit/50787b2faf1a4bea799d041960ca2b91199ef403))
* **process:** harden filesystem snapshot identity and cancellation ([#956](https://github.com/morluto/rea/issues/956)) ([93aa9eb](https://github.com/morluto/rea/commit/93aa9eb5c2551984182a4025d836e4223e8ecc8a))
* **process:** retain provider output until streams close ([#928](https://github.com/morluto/rea/issues/928)) ([b929251](https://github.com/morluto/rea/commit/b9292516f4eedc2dedba713abf57f665ef1fb596))
* **reference:** retain partial imports for unreadable directories ([#766](https://github.com/morluto/rea/issues/766)) ([cffc548](https://github.com/morluto/rea/commit/cffc548cd3127c5db811f20db4816039846b3170))
* **release:** drive checkpoint releases from frozen branches ([fc58fa1](https://github.com/morluto/rea/commit/fc58fa1eb01fe5a8200a78e9551799c9c1a3d256))
* **release:** publish from explicit source checkpoints ([49887f0](https://github.com/morluto/rea/commit/49887f0239da4483153a5e1610058619855525db))
* **semantics:** isolate named function expression bindings ([#776](https://github.com/morluto/rea/issues/776)) ([ae81f64](https://github.com/morluto/rea/commit/ae81f64d2ad10e5cdbf8356819351c02480aee7a))
* **semantics:** preserve direct promise ownership boundaries ([#758](https://github.com/morluto/rea/issues/758)) ([e1ca412](https://github.com/morluto/rea/commit/e1ca412757bb01be855a66bf72006e3becd497b6))
* **semantics:** preserve empty string property keys ([#764](https://github.com/morluto/rea/issues/764)) ([630bdaf](https://github.com/morluto/rea/commit/630bdafcacc621105f6a43ed68a6e51651aca629))
* **semantics:** recognize Node builtin default namespaces ([#769](https://github.com/morluto/rea/issues/769)) ([24a0bf9](https://github.com/morluto/rea/commit/24a0bf9a618604e2fa30817d673ce911c7842819))
* **semantics:** retain trailing rest argument flows ([#756](https://github.com/morluto/rea/issues/756)) ([4bfd803](https://github.com/morluto/rea/commit/4bfd8038be0a60c43a452bec15e23799a0b040c0))
* **setup:** accept the pinned Hopper RPM launcher ([#933](https://github.com/morluto/rea/issues/933)) ([dda8e6a](https://github.com/morluto/rea/commit/dda8e6a72890f87bdf8bbd3250b68b6648aae553))
* **setup:** read an OpenCode V2 server named type as a table entry ([#866](https://github.com/morluto/rea/issues/866)) ([4e17be5](https://github.com/morluto/rea/commit/4e17be57053fb0ce2561d92e05b6e38ef789b2d4))
* **setup:** register OpenCode V2 configurations in mcp.servers ([957069d](https://github.com/morluto/rea/commit/957069d14d832ddeac3f90dd141d379b81e2832a))
* **setup:** register OpenCode V2 configurations in mcp.servers ([69d8afe](https://github.com/morluto/rea/commit/69d8afefc19e014a4bba7a182983a9e77e100a75))
* **target:** decode app Info.plist executables with an XML parser ([c57f1b7](https://github.com/morluto/rea/commit/c57f1b74e0af5cf5fbb459cb247e1448cbf8df1b))
* **target:** decode app Info.plist executables with an XML parser ([c182f72](https://github.com/morluto/rea/commit/c182f72ad3d9eea10b084a43527acb7c8ca2d6bf))
* **test:** disconnect Hopper fixture IPC on SIGTERM ([b912b11](https://github.com/morluto/rea/commit/b912b117f019d5d3e4b4e3ef683e9b25f3a709bc))
* **windows:** accept ordinary drive path separators ([#791](https://github.com/morluto/rea/issues/791)) ([b62931f](https://github.com/morluto/rea/commit/b62931f8335f58bfe344883a4f149e9eef73d835))
* **windows:** remove cancelled snapshot outputs ([#957](https://github.com/morluto/rea/issues/957)) ([d76f7d1](https://github.com/morluto/rea/commit/d76f7d150895289aa1fb85a057b81ca7ff102df4))


### Performance Improvements

* **artifacts:** stream ASAR members without full buffering ([#962](https://github.com/morluto/rea/issues/962)) ([abd7a5e](https://github.com/morluto/rea/commit/abd7a5ed091061e4b1e83e5933e9009fb5b8d577))
* **call-path:** prune dead ends and enumerate without recursion ([#909](https://github.com/morluto/rea/issues/909)) ([e52fe97](https://github.com/morluto/rea/commit/e52fe9719fec03f2aa79b1a1b9e11b38c229903c))
* **cli:** defer catalog digests and use canonical cache scope ([9a15525](https://github.com/morluto/rea/commit/9a1552529889e9f5b52a88739eb767b92e57e24e))
* **cli:** defer unused catalog work during command startup ([#920](https://github.com/morluto/rea/issues/920)) ([9a15525](https://github.com/morluto/rea/commit/9a1552529889e9f5b52a88739eb767b92e57e24e))
* **comparison:** reuse canonical sort keys ([#990](https://github.com/morluto/rea/issues/990)) ([ebb065e](https://github.com/morluto/rea/commit/ebb065e2dc15f5763276f401521896f66bae6339))
* **dotnet:** index declaring-type ranges once per metadata table ([#918](https://github.com/morluto/rea/issues/918)) ([7a9f587](https://github.com/morluto/rea/commit/7a9f587c3a9998d828b83388438976527ca7074f))
* **dotnet:** index ordered declaring-type ranges once per table ([7a9f587](https://github.com/morluto/rea/commit/7a9f587c3a9998d828b83388438976527ca7074f))
* **evidence:** scale imports and dependency graphs ([#941](https://github.com/morluto/rea/issues/941)) ([7dc40d3](https://github.com/morluto/rea/commit/7dc40d3d9e00caf013109942a5d9a1d7fdf9ec62))
* **inspector:** bound runtime script location authorization ([#945](https://github.com/morluto/rea/issues/945)) ([58381ee](https://github.com/morluto/rea/commit/58381eefa24f73580e31eaa09dc14b9c04d78d6c))
* **javascript:** analyze member chains without recursive copying ([#932](https://github.com/morluto/rea/issues/932)) ([dcde958](https://github.com/morluto/rea/commit/dcde9584508830a5d99ac5e2032f539563c69002))
* **javascript:** index Promise return-site ownership ([#971](https://github.com/morluto/rea/issues/971)) ([2cedde9](https://github.com/morluto/rea/commit/2cedde9f1cf72b04bef37f9f004bb68d5ff6502a))
* **javascript:** index semantic fingerprint relations ([#942](https://github.com/morluto/rea/issues/942)) ([c92a344](https://github.com/morluto/rea/commit/c92a344d4770125d85a11f3fc7a23d800bd30003))
* **javascript:** reduce analysis and source-map work ([#955](https://github.com/morluto/rea/issues/955)) ([c7530f9](https://github.com/morluto/rea/commit/c7530f9a816d84354516d3ea137f4a0d91d3b8b3))
* **providers:** assemble fragmented responses once per line ([#911](https://github.com/morluto/rea/issues/911)) ([df7151b](https://github.com/morluto/rea/commit/df7151ba305eab3a33a9261a023705b29862b308))
* **reconstruction:** index coverage evaluation ([#983](https://github.com/morluto/rea/issues/983)) ([f26c8b5](https://github.com/morluto/rea/commit/f26c8b5b8cff10b93173359b5453874d659f2440))
* **setup:** reuse initial diagnostics during planning ([#940](https://github.com/morluto/rea/issues/940)) ([118d43e](https://github.com/morluto/rea/commit/118d43e787e38857714852cc846b1b604a61950d))


### Code Refactoring

* add incremental capability migration safeguards ([#819](https://github.com/morluto/rea/issues/819)) ([75f50d8](https://github.com/morluto/rea/commit/75f50d86f6d504f4dd97a707871d39ec022b3047))
* **android:** group layered source and verification ([#873](https://github.com/morluto/rea/issues/873)) ([8e8921d](https://github.com/morluto/rea/commit/8e8921d40c63b40ab7e1598f672063dd304d93f0))
* **apple:** group artifact producers and verification ([#952](https://github.com/morluto/rea/issues/952)) ([ef1a0cc](https://github.com/morluto/rea/commit/ef1a0cc65af7918ef7204a39f42a4299b486c453))
* **artifacts:** isolate JavaScript file acquisition ([#916](https://github.com/morluto/rea/issues/916)) ([f0a68dc](https://github.com/morluto/rea/commit/f0a68dce60e81b4d2f420bf774b61957a37326ac))
* **binary:** group session selection and snapshot ownership ([#886](https://github.com/morluto/rea/issues/886)) ([dd114d3](https://github.com/morluto/rea/commit/dd114d39801973e958a582c8fcba7ccce0e50299))
* **binary:** move production composition outside application workflows ([#965](https://github.com/morluto/rea/issues/965)) ([33d4761](https://github.com/morluto/rea/commit/33d4761cc7a96630b7c2fed890df83d433c45914))
* **browser:** align inspector exclusions with canonical vocabulary ([#834](https://github.com/morluto/rea/issues/834)) ([de9593a](https://github.com/morluto/rea/commit/de9593ad48c0b97507f18949b7ad86ad9c743ebc))
* **cli:** split core analysis command registrar ([#858](https://github.com/morluto/rea/issues/858)) ([8b9940a](https://github.com/morluto/rea/commit/8b9940a7b5d3fcd5a8eda6d397f0ab7c3aaf2ac9))
* colocate investigation record implementation ([#867](https://github.com/morluto/rea/issues/867)) ([bb19c94](https://github.com/morluto/rea/commit/bb19c9477ef3eefd9c5b2e6cabe78cc94e6779ae))
* compose investigation record ownership ([#845](https://github.com/morluto/rea/issues/845)) ([ce73c3f](https://github.com/morluto/rea/commit/ce73c3fed2e5fd20ae0113579345a69763eb7655))
* declare auxiliary capabilities from source ([#853](https://github.com/morluto/rea/issues/853)) ([4a6c17c](https://github.com/morluto/rea/commit/4a6c17ce83dfd20412f0e168525314a20c61169e))
* **domain:** consolidate property-key extraction behind semanticStaticPropertyKey ([#823](https://github.com/morluto/rea/issues/823)) ([764ff05](https://github.com/morluto/rea/commit/764ff05231f1a666dfa655492da42b4b6ba742c3))
* **domain:** converge comparison mechanics on shared vocabulary ([#824](https://github.com/morluto/rea/issues/824)) ([c13c9d4](https://github.com/morluto/rea/commit/c13c9d41f8441a711266adee21429fb7433a6aa1))
* **domain:** extract artifact path syntax helpers ([#830](https://github.com/morluto/rea/issues/830)) ([ef535b8](https://github.com/morluto/rea/commit/ef535b81fefc358b0bdb655e5aa057fc3949ce5f))
* **domain:** extract source-map envelope walk and disambiguate stringValue ([#828](https://github.com/morluto/rea/issues/828)) ([64ebdf4](https://github.com/morluto/rea/commit/64ebdf45016bda679674cbd2287576eadf66a1fc))
* **domain:** map validation taxonomies and add inventory Result seam ([#833](https://github.com/morluto/rea/issues/833)) ([78f4848](https://github.com/morluto/rea/commit/78f4848d70ce462426e9f221d6e7b3e34219bf46))
* **domain:** split Interface Builder keyed-archive parse from graph builder ([#859](https://github.com/morluto/rea/issues/859)) ([da09706](https://github.com/morluto/rea/commit/da0970672da725dbb095ffcaefad07303ae85aab))
* **firmware:** group layered source and verification ([#878](https://github.com/morluto/rea/issues/878)) ([507e8b3](https://github.com/morluto/rea/commit/507e8b3c7be75f8de69be214618394aca3585404))
* **ghidra:** extract createClient and load-image attestation ([#856](https://github.com/morluto/rea/issues/856)) ([b7df5b7](https://github.com/morluto/rea/commit/b7df5b78052539e57967db8e6562befd70c6ebdc))
* give Inspector its own capability directory ([#869](https://github.com/morluto/rea/issues/869)) ([021ba69](https://github.com/morluto/rea/commit/021ba690b07eab4b990be47f90946db9f70e0fc0))
* **javascript:** group application workflows and verification ([#896](https://github.com/morluto/rea/issues/896)) ([0804722](https://github.com/morluto/rea/commit/0804722cdf721a8d767d02f9342ebdf8d186f7e1))
* **javascript:** group domain semantics and contracts ([#907](https://github.com/morluto/rea/issues/907)) ([f6a58f1](https://github.com/morluto/rea/commit/f6a58f10629614fb7a6970421218b73d41bce6a5))
* **managed:** group capability workflows and verification ([#926](https://github.com/morluto/rea/issues/926)) ([28713f9](https://github.com/morluto/rea/commit/28713f9b4dcb882f0e811653890fde70cb5fdadb))
* **native:** group analyst semantics workflows and contracts ([#973](https://github.com/morluto/rea/issues/973)) ([ea4db4c](https://github.com/morluto/rea/commit/ea4db4c9f7cbc10dc701c4d5770109c08952a5b8))
* **native:** split Apple dispatch metadata decode facets ([#855](https://github.com/morluto/rea/issues/855)) ([676959e](https://github.com/morluto/rea/commit/676959ecb55b606a567af3d2eb3d3edc96f0aa2f))
* **provider:** declare deep capabilities from source ([#892](https://github.com/morluto/rea/issues/892)) ([b808e2d](https://github.com/morluto/rea/commit/b808e2d6bbbae38c1ff2e293e1cf77464d889bdd))
* share Android and firmware provider factories ([#826](https://github.com/morluto/rea/issues/826)) ([3ed59b2](https://github.com/morluto/rea/commit/3ed59b281247f2180b3c79e658078507e4cc1be2))


### Documentation

* add concise lawful-use disclaimer ([#888](https://github.com/morluto/rea/issues/888)) ([4037c65](https://github.com/morluto/rea/commit/4037c6545dc8cc47f4602d8f06e5329ed641cdbb))
* add DX-Ball reconstruction showcase ([#876](https://github.com/morluto/rea/issues/876)) ([895079d](https://github.com/morluto/rea/commit/895079dd093f02487789d9aa967f0cccbfe379d8))
* add prominent website and showcase links to READMEs ([2ccc86c](https://github.com/morluto/rea/commit/2ccc86cd13d71f08b553d3b9962175144b882539))
* add README star history chart ([#850](https://github.com/morluto/rea/issues/850)) ([11f27de](https://github.com/morluto/rea/commit/11f27deddf88703368942d3ddfc239a7ebe72e3e))
* add website and showcase links to READMEs ([#930](https://github.com/morluto/rea/issues/930)) ([2ccc86c](https://github.com/morluto/rea/commit/2ccc86cd13d71f08b553d3b9962175144b882539))
* **apple:** describe directory-based framework plist ambiguity ([6d74992](https://github.com/morluto/rea/commit/6d74992efed3271e8370c505afdde347609f8353))
* audit and improve localized readmes translations and wording ([00a6ac3](https://github.com/morluto/rea/commit/00a6ac3de99f432bd6dbb88148a2aab5f8d3d338))
* clarify NativeAOT scope and regenerate conformance ledger ([c945931](https://github.com/morluto/rea/commit/c945931961cbd488163c6d92ef91336ed506942e))
* fix stale IDA roadmap item, mermaid paths, toolchain wording ([d2aed17](https://github.com/morluto/rea/commit/d2aed172ab79d98ff4e62c14d8f34cc49c1d17b4))
* move quick start up and mark skill install optional ([554e9b1](https://github.com/morluto/rea/commit/554e9b1612f7799c2bc7177eb1a9b04a0f27d2e9))
* note Cloud Agent Node.js toolchain ([#837](https://github.com/morluto/rea/issues/837)) ([6aa6350](https://github.com/morluto/rea/commit/6aa6350c800796d0953937e894ff176ae248e930))
* publish VitePress documentation on GitHub Pages ([c78fe69](https://github.com/morluto/rea/commit/c78fe6990bcface6853ac5c11c90df6bc0df562d))
* separate ambiguous and unavailable provider recovery ([c3f2b8e](https://github.com/morluto/rea/commit/c3f2b8e7742915dc27ab7c801a8a1a9127169896))
* show task-scoped readiness and provider preference in the quick start ([880cca1](https://github.com/morluto/rea/commit/880cca1bca497bb53c97a821b470df0f2235e043))
* show task-scoped readiness and provider preference in the quick start ([5fd0db3](https://github.com/morluto/rea/commit/5fd0db37d94f1c1a0495920c79e121d799da0d30)), closes [#726](https://github.com/morluto/rea/issues/726)
* update release boundary to npm 4.1.0 with Windows native bundle ([69be514](https://github.com/morluto/rea/commit/69be514c67c8b2eb8b450355a9782d9237748fda))
* **website:** add Notion case study and improve onboarding ([a6ba772](https://github.com/morluto/rea/commit/a6ba772c08e2648e6602787a0ea537d75d72802d))
* **website:** add TH04 bullet-ring case study ([f8d84da](https://github.com/morluto/rea/commit/f8d84da127fad871050c098b004a503b36795ad0))
* **website:** add worked guides and keep Pages publishing manual ([#925](https://github.com/morluto/rea/issues/925)) ([4f25ee3](https://github.com/morluto/rea/commit/4f25ee33dcd4195f8d877f8835f81c4e08c95235))
* **website:** clarify guides and case studies ([5065fcd](https://github.com/morluto/rea/commit/5065fcd5205ec7c0d259131431c2cf54d9f69cf6))


### Tests

* **artifacts:** report compiled connector records when a storyboard route is missing ([d421d3f](https://github.com/morluto/rea/commit/d421d3f286ce515b5126859a0f9cac60667a168e))
* **artifacts:** report observed action routes when a compiled route is missing ([c60b737](https://github.com/morluto/rea/commit/c60b737f7db8e2c9a1982cdb4357fcda1f47ff08))
* **artifacts:** write the storyboard fixture's action in Cocoa syntax ([53bfa7e](https://github.com/morluto/rea/commit/53bfa7e3f792cdb9f2e95fc954f3616426414bcc))
* eliminate fixture races and prune redundant scaffolding ([#849](https://github.com/morluto/rea/issues/849)) ([f72931d](https://github.com/morluto/rea/commit/f72931d9dd54609bfca422750fc2667f80af691c))


### Continuous Integration

* consolidate macOS native baseline checks ([#935](https://github.com/morluto/rea/issues/935)) ([810fe53](https://github.com/morluto/rea/commit/810fe53e799b89dc215c52c9245d36fb2a44d9c4))
* verify native arm64 and Intel macOS workflows ([#898](https://github.com/morluto/rea/issues/898)) ([4801a24](https://github.com/morluto/rea/commit/4801a24089964860db7f4855be21d2d4313c7eab))

## [4.1.0](https://github.com/morluto/rea/compare/rea-agents-4.0.1...rea-agents-4.1.0) (2026-10-06)


### Features

* **android:** integrate static APK analysis with headless JADX ([#738](https://github.com/morluto/rea/issues/738)) ([904d03e](https://github.com/morluto/rea/commit/904d03e987a6c498561b314a266202dee84b13ab))
* **evidence:** accept exact retained application references ([#734](https://github.com/morluto/rea/issues/734)) ([d0f3480](https://github.com/morluto/rea/commit/d0f3480a3cb9887499c2b188c783dd1c4db09787))
* **firmware:** integrate Binwalk and Unblob analysis ([5a7c769](https://github.com/morluto/rea/commit/5a7c769692c21efc4cc0e5ebf06a9f2534dc75ed))
* **ghidra:** add atomic function annotation edits ([#709](https://github.com/morluto/rea/issues/709)) ([9bab553](https://github.com/morluto/rea/commit/9bab55337ab10616be6929afddb08fb19fbb8ab7))
* **ghidra:** admit explicit DOS COM analysis ([#702](https://github.com/morluto/rea/issues/702)) ([5bcb664](https://github.com/morluto/rea/commit/5bcb6645b561e666b7e07dd8f38d2296fa7cbba8))
* **ghidra:** enable Windows x64 read-only analysis ([#699](https://github.com/morluto/rea/issues/699)) ([26881da](https://github.com/morluto/rea/commit/26881da76aa320c8529fcc741df0fc9898d97bdc))
* **ghidra:** integrate optional NativeAOT metadata recovery ([#748](https://github.com/morluto/rea/issues/748)) ([fb679b6](https://github.com/morluto/rea/commit/fb679b63c27e6c5f137532953cfa24a2ffb1aaf2))
* **ghidra:** verify DOS load images and expose memory evidence ([#697](https://github.com/morluto/rea/issues/697)) ([a6a8f67](https://github.com/morluto/rea/commit/a6a8f67649cab558b0de11601e65425f280c7170))
* **ida:** add read-only GUI and headless MCP providers ([#754](https://github.com/morluto/rea/issues/754)) ([8238232](https://github.com/morluto/rea/commit/82382324855a3a4ed51d2cdc3b2b455c9e8419e2))
* **setup:** support Command Code MCP registration ([#645](https://github.com/morluto/rea/issues/645)) ([7f1ae42](https://github.com/morluto/rea/commit/7f1ae42f71ce85547d317eed5e62fa330d9876bb))


### Bug Fixes

* **android:** validate explicit Java runtime ([#742](https://github.com/morluto/rea/issues/742)) ([7390390](https://github.com/morluto/rea/commit/739039092f98c67e8e6ccfb1f8445e8f13ac8f15))
* **artifacts:** make extraction output tree work on Windows ([#753](https://github.com/morluto/rea/issues/753)) ([c8e66c7](https://github.com/morluto/rea/commit/c8e66c704a70f5133922aa1bd1a3ba42959093ba))
* **browser:** classify CSP host sources by their own origin ([#707](https://github.com/morluto/rea/issues/707)) ([1d15bcb](https://github.com/morluto/rea/commit/1d15bcb9ecd7efa487a8fd3f0d9755bd60051722))
* **browser:** keep bare module locations unresolved ([#676](https://github.com/morluto/rea/issues/676)) ([8189081](https://github.com/morluto/rea/commit/8189081511441f0e3909b21b80c21c658ec9a453))
* **ci:** upload Vitest blob reports from current path ([77799e6](https://github.com/morluto/rea/commit/77799e6c90ce36cd52e45b62c9cba2d46641c4cf))
* **cli:** disable unmanaged skill synchronization ([433ebda](https://github.com/morluto/rea/commit/433ebda8b492f388faf6e6cac63ccc6f9c2d8d7e))
* **cli:** disable unmanaged skill synchronization ([2c1bf92](https://github.com/morluto/rea/commit/2c1bf9201040ed3d60f475af9129b7bf85a508fa))
* **cli:** fail when JSON input files cannot be parsed ([18c1829](https://github.com/morluto/rea/commit/18c18290d048b78a435f6864dfc778a9fea0af2e))
* **cli:** fail when JSON input files cannot be parsed ([3201f05](https://github.com/morluto/rea/commit/3201f0538dc88e54bce00decf689bf9b5603bfd3))
* **cli:** include build step in missing-runtime recovery ([6a37346](https://github.com/morluto/rea/commit/6a37346acb9829acaab0e2042624e6ea0d03e2a9))
* **cli:** include build step in missing-runtime recovery ([ae72abd](https://github.com/morluto/rea/commit/ae72abd019b25347bfc7593b5dcadc5a2cbc3786))
* **cli:** report reference-source import failures ([00eb03d](https://github.com/morluto/rea/commit/00eb03d0f2247da95dfa7bda0f41a0f366a25dd9))
* **cli:** report reference-source import failures ([431e8eb](https://github.com/morluto/rea/commit/431e8ebfcfba2925904c0deb4888bbd3755b17bf))
* **comparison:** break function collection collation ties ([c3d013b](https://github.com/morluto/rea/commit/c3d013b2fd5c3a32dfa73ef40dafdaeaf935f37e))
* **comparison:** break function collection collation ties ([3aaf7e2](https://github.com/morluto/rea/commit/3aaf7e2c54029a456145d6e3287fd9122f3abbe3))
* **comparison:** break JSON shape collation ties ([217e8cf](https://github.com/morluto/rea/commit/217e8cf59f49e2f68b394fbcbc87f914dbee97ee))
* **comparison:** break JSON shape collation ties ([805c338](https://github.com/morluto/rea/commit/805c338f360184d73ae335a723fca656830d6328))
* **comparison:** retain container-only export shape paths ([a55b5bb](https://github.com/morluto/rea/commit/a55b5bb8ee400ef5565954d57916e8aae7dac760))
* **comparison:** retain container-only export shape paths ([7864d66](https://github.com/morluto/rea/commit/7864d665e15edec29ade0f3fb7ac374b8579c2c0))
* **dotnet:** preserve leading Unicode content in metadata strings ([#667](https://github.com/morluto/rea/issues/667)) ([ddea063](https://github.com/morluto/rea/commit/ddea06360a09508a0ff695ab6e141eff19534619))
* **electron:** respect computed option keys and overrides ([af48fe8](https://github.com/morluto/rea/commit/af48fe879161ee749692751b3e29ba06b63b7409))
* **electron:** respect computed option keys and overrides ([98de338](https://github.com/morluto/rea/commit/98de3380e3062cb25778263bfea07b215a09b39c))
* **evidence:** admit current process provider identity ([ab5a1c6](https://github.com/morluto/rea/commit/ab5a1c61b12475c554a5e4d60b48b642b2464bbb))
* **evidence:** admit current process provider identity ([d311940](https://github.com/morluto/rea/commit/d311940f2414fe5cceb750de4464b681bb44ae1e))
* **firmware:** validate configured executables ([#751](https://github.com/morluto/rea/issues/751)) ([9a4e6da](https://github.com/morluto/rea/commit/9a4e6da5a96ed2708a0f628b436dcd7415999327))
* **ghidra:** preserve request and shutdown failure diagnostics ([#647](https://github.com/morluto/rea/issues/647)) ([19f8cdd](https://github.com/morluto/rea/commit/19f8cddfd6f283188567b8ff1e49b810d79952ee))
* **ghidra:** refuse ambiguous universal Mach-O imports ([b1b687f](https://github.com/morluto/rea/commit/b1b687fb75325c0275a0cf161843fc5969ba1d47))
* **ghidra:** refuse ambiguous universal Mach-O imports ([6582b24](https://github.com/morluto/rea/commit/6582b2433a955167e33246ad07de1a40bcb20144))
* **hopper:** retain shutdown request diagnostics ([8d7071d](https://github.com/morluto/rea/commit/8d7071da4c61c5cfb4894be6536405affd90f276))
* **hopper:** retain shutdown request diagnostics ([7254871](https://github.com/morluto/rea/commit/72548712fea972b920834663a5e2ceea4738ce1e))
* integrate 14 approved fix PRs (668,671,673,675,678-681,685-690) ([#705](https://github.com/morluto/rea/issues/705)) ([cf06115](https://github.com/morluto/rea/commit/cf061159ab69a746675e48896fa953d6990c05f9))
* **javascript:** count all source line terminators ([e60aa11](https://github.com/morluto/rea/commit/e60aa1110800e1309b482e7a44ecd1762bade992))
* **javascript:** count all source line terminators ([03bc6d3](https://github.com/morluto/rea/commit/03bc6d36db94e70c709557cb7302d40af9e99e6b))
* **javascript:** expose result schema failures ([6d1f39b](https://github.com/morluto/rea/commit/6d1f39b250f8a1c6f924b1a6b9d26d56dff4beee))
* **javascript:** expose result schema failures ([99263a7](https://github.com/morluto/rea/commit/99263a720d7106aff059ad7fa43849151a94c963))
* **javascript:** hash graph and evidence JSON incrementally ([#646](https://github.com/morluto/rea/issues/646)) ([9f42495](https://github.com/morluto/rea/commit/9f42495d11100adc8646de5c8b62762ab9715ae6))
* **javascript:** preserve path.resolve reset semantics ([863ed47](https://github.com/morluto/rea/commit/863ed47de2e35ef9b734e45e3bb44ea9e9dc8ff6))
* **javascript:** preserve path.resolve reset semantics ([4177377](https://github.com/morluto/rea/commit/417737748aa96ba38ced7b0b22dbb972187f2ee0))
* **javascript:** preserve primitive addition coercion ([#666](https://github.com/morluto/rea/issues/666)) ([94cc847](https://github.com/morluto/rea/commit/94cc8475e0e9e24cd2e8345bd36a743a979e3620))
* **javascript:** preserve unknown branches in primitive unions ([75a75cb](https://github.com/morluto/rea/commit/75a75cbb20aa9b2148f9fd0547f613eadda68edd))
* **javascript:** preserve unknown branches in primitive unions ([9a2f395](https://github.com/morluto/rea/commit/9a2f3950286a01922be0b07b29c4aefee466ec1e))
* **javascript:** read source-map directives only from comments ([#672](https://github.com/morluto/rea/issues/672)) ([7f1fa64](https://github.com/morluto/rea/commit/7f1fa64019e01a654ad0eb80b47d268a58f04e57))
* **javascript:** scope candidate ambiguity to query traversal ([6ad62ce](https://github.com/morluto/rea/commit/6ad62cec6abf182a52cf9844145e147fb6399c8e))
* **javascript:** scope candidate ambiguity to query traversal ([f94fc79](https://github.com/morluto/rea/commit/f94fc7967b2e5604c144d3638515caad6273a0c6))
* **mcp:** retain shutdown failure diagnostics ([09c249d](https://github.com/morluto/rea/commit/09c249deb86068503611fc474e76018d5c2a4d0b))
* **mcp:** retain shutdown failure diagnostics ([fd008cd](https://github.com/morluto/rea/commit/fd008cd8e0b8277e691efd8e69dc96ac8e188d9e))
* **native:** inspect mixed-signature Mach-O slices ([1dccd0d](https://github.com/morluto/rea/commit/1dccd0dee04abfdc80e8b48e3f05fa39cccf0feb))
* **native:** inspect mixed-signature Mach-O slices ([66f3cfa](https://github.com/morluto/rea/commit/66f3cfa594a86cbf1f21fc6d2eca1a82e236c896))
* **native:** retain spaced symbols in dyld inventory ([#669](https://github.com/morluto/rea/issues/669)) ([fa02df9](https://github.com/morluto/rea/commit/fa02df9ad3bc3139ef10422dedffac88c4d51d36))
* **native:** select concrete arm64e Mach-O slices ([f04445c](https://github.com/morluto/rea/commit/f04445c57c597a8312211139b75da706cb0c2a96))
* **native:** select concrete arm64e Mach-O slices ([fd3282a](https://github.com/morluto/rea/commit/fd3282a87e40417cf3d7d6211743809f9bad2dc8))
* **process:** honor disabled PID normalization in samples ([44b3627](https://github.com/morluto/rea/commit/44b3627ab0b32c42e545dd2fd095006d249a77f6))
* **process:** honor disabled PID normalization in samples ([a4e5736](https://github.com/morluto/rea/commit/a4e57366dd75077bde07f25c7966204cedad929e))
* **process:** scope comparison unknowns to their evidence ([#732](https://github.com/morluto/rea/issues/732)) ([9dd6cef](https://github.com/morluto/rea/commit/9dd6cef90abf89f9191bce942e31900870231968))
* **reconstruction:** accept function comparison source parameters ([c3bc38b](https://github.com/morluto/rea/commit/c3bc38bf6c74d2175a4680530dcadd6cab0e7791))
* **reconstruction:** accept function comparison source parameters ([7a96391](https://github.com/morluto/rea/commit/7a96391001780012f704f4ef5cb6597baa590b7d))
* **reference:** bound Dockerfile language detection ([132a3a4](https://github.com/morluto/rea/commit/132a3a46be648b036ed36372a50d6e32a9e7f2e5))
* **reference:** bound Dockerfile language detection ([53fa559](https://github.com/morluto/rea/commit/53fa55937f241fc9ef3091eb22314cc370c749b9))
* **reference:** classify test suffixes before extensions ([e828acc](https://github.com/morluto/rea/commit/e828acce0e0bf3808773590cf2dbb0bc8227df7b))
* **reference:** classify test suffixes before extensions ([8b228ae](https://github.com/morluto/rea/commit/8b228ae7010144b69a243c9682aeb0a1dc4249a3))
* **reference:** distinguish computed require member names ([ba35b55](https://github.com/morluto/rea/commit/ba35b5509db60c18dd43e350e0dd4a0b5f229c69))
* **reference:** distinguish computed require member names ([df6e476](https://github.com/morluto/rea/commit/df6e476d67b2719c4b998daa3e9ad8a4b157ace2))
* **reference:** preserve unresolved absolute module specifiers ([#670](https://github.com/morluto/rea/issues/670)) ([c8aed47](https://github.com/morluto/rea/commit/c8aed4740d52b1eecaa93b3a527e8b3814dc88a4))
* **reference:** read linked worktree commit provenance ([#677](https://github.com/morluto/rea/issues/677)) ([d565ecd](https://github.com/morluto/rea/commit/d565ecdc257514f5d0c5a412081e322fc66d4215))
* **reference:** recognize CMake build manifests ([#665](https://github.com/morluto/rea/issues/665)) ([1a24be5](https://github.com/morluto/rea/commit/1a24be574d1860931ff8d4c8ec07f3968fff9fd5))
* **reference:** retain dynamic import relationships ([a5d2986](https://github.com/morluto/rea/commit/a5d2986b1e517b71a1ed51be433c95e975eafe32))
* **reference:** retain dynamic import relationships ([b89de8f](https://github.com/morluto/rea/commit/b89de8feab389477a468f0b89b8dfa35d7ddc102))
* **reference:** retain recovered parser diagnostics ([11d0ef2](https://github.com/morluto/rea/commit/11d0ef2e09308ac06889865b3fcf356b8ffa647f))
* **reference:** retain recovered parser diagnostics ([ed3a7f0](https://github.com/morluto/rea/commit/ed3a7f070cf0793e22b9a0bbfd1f2ebe9dabcfd0))
* **setup:** accept leading BOM in JSON client configs ([a5b970c](https://github.com/morluto/rea/commit/a5b970c6bf6848145a82de51c001410aa4d50f6f))
* **setup:** accept leading BOM in JSON client configs ([fe843ec](https://github.com/morluto/rea/commit/fe843ec0b101544e22d7599d93b36377d3e3bc34))
* **setup:** align Node runtime checks with package engines ([5802ef8](https://github.com/morluto/rea/commit/5802ef8746412649bb641332f2fa7e69bb1a86a3))
* **setup:** align Node runtime checks with package engines ([ea0b733](https://github.com/morluto/rea/commit/ea0b733687582d6cc28b42beaf2fc7a48be07b6a))
* **target:** explain the JavaScript directory analysis route ([#733](https://github.com/morluto/rea/issues/733)) ([8d44b3e](https://github.com/morluto/rea/commit/8d44b3edd36b528c308e32328552ca386dc43e91))
* **trace:** match typed seeds against member arrays ([65c8797](https://github.com/morluto/rea/commit/65c879757ea09fabc5fc036d6e3395fd2939995c))
* **trace:** match typed seeds against member arrays ([38ebd54](https://github.com/morluto/rea/commit/38ebd54776d661ced2e6cc2c5e4b260653a086d9))


### Code Refactoring

* **app:** split Setup and ProcessOwnership modules ([#628](https://github.com/morluto/rea/issues/628)) ([3c84080](https://github.com/morluto/rea/commit/3c84080aab5e5aa6c9fc14bafa07c635b537b64d))
* **cli:** collapse duplicate CLI layer into src/cli ([#630](https://github.com/morluto/rea/issues/630)) ([494d4db](https://github.com/morluto/rea/commit/494d4db6d9d519f9258a25504cf29b07d61fbb9f))
* **contracts:** split tool contracts by family ([#634](https://github.com/morluto/rea/issues/634)) ([5295d56](https://github.com/morluto/rea/commit/5295d56b105074b290e0d881df43cd13e34a2f8b))
* **domain:** consolidate canonical ordering and digest helpers ([#624](https://github.com/morluto/rea/issues/624)) ([ba3869c](https://github.com/morluto/rea/commit/ba3869c597133b63fdcc0077c558923ae2e17a3f))
* **domain:** split error taxonomy into thematic modules ([#636](https://github.com/morluto/rea/issues/636)) ([735c100](https://github.com/morluto/rea/commit/735c10059ca161967d71ccf8fa3f62011d2a22ca))
* **native:** extract FAT header format switch in Mach-O slice selection ([#632](https://github.com/morluto/rea/issues/632)) ([38b2933](https://github.com/morluto/rea/commit/38b293329ca06c424a58bb59a28728f19015ce22))
* **runtime:** centralize safe JSON parsing and preserve error causes ([#629](https://github.com/morluto/rea/issues/629)) ([e7f54b3](https://github.com/morluto/rea/commit/e7f54b3310b7f45af11c1754e468d4d3804191db))
* **runtime:** name all silent catch causes without changing diagnostics ([#637](https://github.com/morluto/rea/issues/637)) ([5f27e02](https://github.com/morluto/rea/commit/5f27e02fae670774667de3618c88ba2ab0e7b661))


### Documentation

* add the official Trendshift badge to README headers ([b6c21b1](https://github.com/morluto/rea/commit/b6c21b1db5d4ff4be0968aa26693916537622a06))
* add the official Trendshift badge to README headers ([7d4ed59](https://github.com/morluto/rea/commit/7d4ed59816388409885310f40c12dfdcdd2d9246))
* align MCP discovery and skill guidance with the stable catalog ([#664](https://github.com/morluto/rea/issues/664)) ([39db9fe](https://github.com/morluto/rea/commit/39db9fe4245cc8142f57f4feeadaff64cb894e31))
* **browser:** add an interaction example that captures the visible result ([#750](https://github.com/morluto/rea/issues/750)) ([91daaa6](https://github.com/morluto/rea/commit/91daaa68aea3bbee02b837ac64d3ad13127d601e))
* clarify onboarding and align provider guidance ([#745](https://github.com/morluto/rea/issues/745)) ([5af1699](https://github.com/morluto/rea/commit/5af169910391f6b95492865247fabf3c4735a9d6))
* correct CLI examples and documentation checks ([#655](https://github.com/morluto/rea/issues/655)) ([fc80ea8](https://github.com/morluto/rea/commit/fc80ea88dfb7bde43e89db0f341c99d7b53c1a7c))
* fix architecture diagram and pretty-print tool catalog ([#626](https://github.com/morluto/rea/issues/626)) ([5e7f35c](https://github.com/morluto/rea/commit/5e7f35c7c3ea8d504421a2623eafd1d73fea08a0))
* **ghidra:** explain first-query deadlines and recovery ([#736](https://github.com/morluto/rea/issues/736)) ([e2c23f3](https://github.com/morluto/rea/commit/e2c23f3640f83c13587603c763dbd7b5ef1bbbb0))
* **hopper:** document HopperTargetLease realpath fallback ([#711](https://github.com/morluto/rea/issues/711)) ([d3f498c](https://github.com/morluto/rea/commit/d3f498ceec65e4f61f39036ab943ace7ef1b9de5))
* **installation:** pin manual MCP registration to the release version ([#658](https://github.com/morluto/rea/issues/658)) ([8dd1d84](https://github.com/morluto/rea/commit/8dd1d8447146b9962ec7ab2f245b0fe47d3ddf44))
* update Trendshift repository badge ([3f6d6dc](https://github.com/morluto/rea/commit/3f6d6dc756d99ca6e7cdc1737522842fcbaee839))


### Tests

* extract shared fixtures, drop knip carve-outs ([#627](https://github.com/morluto/rea/issues/627)) ([55e5eb0](https://github.com/morluto/rea/commit/55e5eb090bb3d6cf347d7cc2f8f028b35b7461ba))
* **hopper:** synchronize startup cancellation with launcher readiness ([#662](https://github.com/morluto/rea/issues/662)) ([88a3c3f](https://github.com/morluto/rea/commit/88a3c3f8a4bf5cb31f60bca4696431c4e4512b30))

## [4.0.1](https://github.com/morluto/rea/compare/rea-agents-4.0.0...rea-agents-4.0.1) (2026-10-05)


### Bug Fixes

* **release:** allow npm propagation time ([2ef02ce](https://github.com/morluto/rea/commit/2ef02ced1603809f0fc6984612de31dce1801dd8))

## [4.0.0](https://github.com/morluto/rea/compare/rea-agents-3.2.1...rea-agents-4.0.0) (2026-10-05)


### ⚠ BREAKING CHANGES

* Managed comparison metadata adds exact-signature matching and its count, and name_matching now reports exact-signature-fallback.
* **setup:** unscoped setup refreshes only existing REA-owned registrations. Use --all-detected to configure every detected client. Setup JSON contains a compact doctor summary; use rea doctor for full diagnostics. Cancellation and successful dry runs now exit successfully.
* Remove controlled replay, Node characterization, finite replay-machine, managed runtime planning, and redundant string-tracing tools. Retire process replay, shims, reactive scenarios, custom checkpoints, and active browser replay and origin-scope inputs.
* **tools:** Removed permission configuration and policy commands, approval fields, filesystem scope inputs, and fixed confirmation options. Process capture inherits the host environment and accepts command names; callers must refresh tool schemas and migrate removed fields.

### Features

* **ghidra:** add DOS MZ analysis and complete function extents ([#556](https://github.com/morluto/rea/issues/556)) ([4f099a1](https://github.com/morluto/rea/commit/4f099a10f819125d52bd8baed9a9018496212eab))
* **native:** add inspection primitives, dispatch traces and approved UI observation ([#500](https://github.com/morluto/rea/issues/500)) ([4fbc501](https://github.com/morluto/rea/commit/4fbc501121e96b33665a76cad2e5c3e8ac2e2c6d))
* **setup:** expand agent integrations and verify updates ([#577](https://github.com/morluto/rea/issues/577)) ([6256b68](https://github.com/morluto/rea/commit/6256b6866616fa0c3137a77ebd31cf34155a642f))


### Bug Fixes

* **artifacts:** break directory child collation ties ([#587](https://github.com/morluto/rea/issues/587)) ([b37e47c](https://github.com/morluto/rea/commit/b37e47c9f729a66008b1dc8b0a1bb266e79c2776))
* **artifacts:** exclude removed paths from unchanged counts ([#569](https://github.com/morluto/rea/issues/569)) ([52bf709](https://github.com/morluto/rea/commit/52bf709bcefb17ab07e1f9c47c5fadf5eca9bd4e))
* **artifacts:** expand nested ASARs on Windows ([#582](https://github.com/morluto/rea/issues/582)) ([ebb4c45](https://github.com/morluto/rea/commit/ebb4c45b6892ab60f2c81e05fbb4cb528ffbffc4))
* **artifacts:** interrupt ZIP extraction under backpressure ([#594](https://github.com/morluto/rea/issues/594)) ([50f7e81](https://github.com/morluto/rea/commit/50f7e81432001239ca8b5de3a9cfe8f5980d2711))
* **artifacts:** preserve archive entry types and host paths ([#581](https://github.com/morluto/rea/issues/581)) ([28e0f4e](https://github.com/morluto/rea/commit/28e0f4e9ec09ae35b26920e4c6925f48770bf5ed))
* **artifacts:** refresh cached ASAR headers for each inventory ([#574](https://github.com/morluto/rea/issues/574)) ([f5013c5](https://github.com/morluto/rea/commit/f5013c50ca81795f91fd945fae2fb76f9dbe0f97))
* **artifacts:** resolve parents after archive enumeration ([#578](https://github.com/morluto/rea/issues/578)) ([8eac290](https://github.com/morluto/rea/commit/8eac290e8d716817526ab7f628e83c75fb33d06b))
* **artifacts:** respect XML plist byte-order marks ([#514](https://github.com/morluto/rea/issues/514)) ([23c4eba](https://github.com/morluto/rea/commit/23c4eba5b38b8de4f9547d879f2c3e54f741b1e1))
* **artifacts:** retain expanded ASAR container parents ([#583](https://github.com/morluto/rea/issues/583)) ([00fa974](https://github.com/morluto/rea/commit/00fa97422f585db878ffe5d1613c56608916f972))
* **artifacts:** retain relative paths in directory identities ([#580](https://github.com/morluto/rea/issues/580)) ([348323d](https://github.com/morluto/rea/commit/348323dd23360bbac3841a9632ffcd08290566d2))
* **browser:** capture popup network and report early event gaps ([#614](https://github.com/morluto/rea/issues/614)) ([f557207](https://github.com/morluto/rea/commit/f557207887ca9336f3d3c5fc02c76c354c1b2945))
* **browser:** capture selected events in popup pages ([#600](https://github.com/morluto/rea/issues/600)) ([a3bf4a0](https://github.com/morluto/rea/commit/a3bf4a0944ce5a52e100470273b91fdd48ebce49))
* **browser:** derive source-map imports from syntax nodes ([#588](https://github.com/morluto/rea/issues/588)) ([bae87b4](https://github.com/morluto/rea/commit/bae87b4ded343b34c4226b5e5d491145db7f85ff))
* **browser:** distinguish duplicate screenshot frame events ([#612](https://github.com/morluto/rea/issues/612)) ([1bd641d](https://github.com/morluto/rea/commit/1bd641d39f58461566e4a3f07fa00f84f34e87ad))
* **browser:** ignore duplicate frame navigations and read block-form source map directives ([#546](https://github.com/morluto/rea/issues/546)) ([828395d](https://github.com/morluto/rea/commit/828395d510bd4f29525e5a0807a550a2daad885c))
* **browser:** keep subresource redirects out of page navigation scope ([#524](https://github.com/morluto/rea/issues/524)) ([9c28f3c](https://github.com/morluto/rea/commit/9c28f3c4c0840fd7424dc669db1fb9baa1dde5d7))
* **browser:** preserve RGB PNG transparent samples ([#595](https://github.com/morluto/rea/issues/595)) ([9997152](https://github.com/morluto/rea/commit/9997152c2d3127162161a2b945f506f0e834be38))
* **browser:** release cancelled CDP cleanup without waiting for responses ([#517](https://github.com/morluto/rea/issues/517)) ([488fd5f](https://github.com/morluto/rea/commit/488fd5f60be3b2900c27a915c73322b9cb5eabb5))
* **browser:** release discarded source-map response bodies ([#611](https://github.com/morluto/rea/issues/611)) ([8642055](https://github.com/morluto/rea/commit/864205570a0a9452f96c11feacd00338d026f17b))
* **browser:** resolve redirected source map paths from final URL ([#518](https://github.com/morluto/rea/issues/518)) ([056c123](https://github.com/morluto/rea/commit/056c1237591de3710cb96a51ddd71fa94317b906))
* **cli:** fail commands returning projected analysis errors ([#506](https://github.com/morluto/rea/issues/506)) ([2fd1196](https://github.com/morluto/rea/commit/2fd11961cfba0c2d211a1aa643cbf05fa4e8c20d))
* **cli:** reject invalid UTF-8 JSON file bytes ([#613](https://github.com/morluto/rea/issues/613)) ([22acb0d](https://github.com/morluto/rea/commit/22acb0d5d730379fbe49e9e491f446e11425190e))
* **comparison:** account for unpaired records after explicit bundle pairing ([#603](https://github.com/morluto/rea/issues/603)) ([12a2e37](https://github.com/morluto/rea/commit/12a2e3793af63542448124311e17eacbd5235fc0))
* **comparison:** match generated names without swallowing symbol prefixes ([#596](https://github.com/morluto/rea/issues/596)) ([5f3ba3e](https://github.com/morluto/rea/commit/5f3ba3e6886b6b3186711e025da14875dc3c9684))
* **comparison:** normalize CFG identity by numeric addresses ([#593](https://github.com/morluto/rea/issues/593)) ([d1e5c0e](https://github.com/morluto/rea/commit/d1e5c0e1fd04d2d5a0d663cbe43787a010e3d783))
* **comparison:** require decoded signatures for structural method matches ([#604](https://github.com/morluto/rea/issues/604)) ([4a98c3e](https://github.com/morluto/rea/commit/4a98c3ea035480561d138d79288974a860c2aa22))
* **conformance:** preserve own JSON keys during comparison ([#573](https://github.com/morluto/rea/issues/573)) ([3460eda](https://github.com/morluto/rea/commit/3460eda9ca01ccf41e3b9895f3cbe975c0eaed51))
* correct native inventories and bridge error classification ([#503](https://github.com/morluto/rea/issues/503)) ([405732a](https://github.com/morluto/rea/commit/405732a7f55e3033c29533b18f7d8313dbd28570))
* **docs:** allow README installation wording to vary ([92617f9](https://github.com/morluto/rea/commit/92617f965720aaa74ec20ad67291adc5e83677a1))
* **ghidra:** avoid nested quotes in Windows Java options ([a574b74](https://github.com/morluto/rea/commit/a574b744b8fe95e906524684f6a3b28cdc656499))
* **ghidra:** recover evidenced switch cases and default targets ([#579](https://github.com/morluto/rea/issues/579)) ([b225b0f](https://github.com/morluto/rea/commit/b225b0f64bfa86586c17f193d30e278d8124b14e))
* **inspector:** preserve lossy Node discovery locations ([#542](https://github.com/morluto/rea/issues/542)) ([84e4361](https://github.com/morluto/rea/commit/84e4361c0936a4bb30951699fb68970d4d7a2327)), closes [#530](https://github.com/morluto/rea/issues/530)
* **javascript:** avoid invented computed destructuring properties ([#507](https://github.com/morluto/rea/issues/507)) ([80777d9](https://github.com/morluto/rea/commit/80777d96daf64d0266e5cf3f9aad9338b97be4ff))
* **javascript:** bind named class expressions in their class scope ([#510](https://github.com/morluto/rea/issues/510)) ([55f0267](https://github.com/morluto/rea/commit/55f0267c409cbf096bcdbd07d7604c44bcde3fbe))
* **javascript:** classify assignment targets and retain compound-assignment reads ([#537](https://github.com/morluto/rea/issues/537)) ([333d118](https://github.com/morluto/rea/commit/333d118c0fa65c8c418baaa337270c0ad25cd7cc))
* **javascript:** correct lexical and dynamic scope analysis ([#538](https://github.com/morluto/rea/issues/538)) ([6fa6f1f](https://github.com/morluto/rea/commit/6fa6f1f9b17318220abb2683c327146785dcc5d3))
* **javascript:** honor computed keys when naming callables, exports, requests and options ([#536](https://github.com/morluto/rea/issues/536)) ([4c8dc39](https://github.com/morluto/rea/commit/4c8dc39f439b5283b077c6aa47f262714d7c4bbd))
* **javascript:** honor package exports condition order ([#591](https://github.com/morluto/rea/issues/591)) ([8289595](https://github.com/morluto/rea/commit/82895959d1494f16bc59909a2575facf3ab19d79))
* **javascript:** isolate lexical loop bindings ([#511](https://github.com/morluto/rea/issues/511)) ([c30878f](https://github.com/morluto/rea/commit/c30878f616c4496c6cd1993d677aa019b2412b7e))
* **javascript:** prefer package entrypoints over directory indexes ([#575](https://github.com/morluto/rea/issues/575)) ([bb91abd](https://github.com/morluto/rea/commit/bb91abd3df52802ec8f9d3d1fb215dce5eb6ea49))
* **javascript:** preserve literal CommonJS path punctuation ([#576](https://github.com/morluto/rea/issues/576)) ([063cd25](https://github.com/morluto/rea/commit/063cd25a93ee9f16b45635fea196dde0d9309ab9))
* **javascript:** preserve Node exports fallback stop reasons ([#606](https://github.com/morluto/rea/issues/606)) ([adc07f5](https://github.com/morluto/rea/commit/adc07f5eaab005f013c88617aa09b6f2b4af4111))
* **javascript:** respect HTML base URL components ([#589](https://github.com/morluto/rea/issues/589)) ([ffbde92](https://github.com/morluto/rea/commit/ffbde92f9ab65a868b660abf17ce9d3c4577d125))
* **javascript:** respect lexical shadowing of require ([#509](https://github.com/morluto/rea/issues/509)) ([6a431d8](https://github.com/morluto/rea/commit/6a431d806a1574a660b96ba49412b24df9e93b50))
* **javascript:** retain property reads during updates ([#508](https://github.com/morluto/rea/issues/508)) ([6b7923c](https://github.com/morluto/rea/commit/6b7923cdd2a099d1481783f34970a3d1a71a8206))
* **managed:** classify truncated signatures as malformed ([#598](https://github.com/morluto/rea/issues/598)) ([1b6f054](https://github.com/morluto/rea/commit/1b6f05470d6fb1903346ef7a25fb5f9d23079cb7))
* **managed:** distinguish metadata handles from member accesses ([#607](https://github.com/morluto/rea/issues/607)) ([c73742f](https://github.com/morluto/rea/commit/c73742f3003ec6c1469f77ecc9ccb093df636b4a))
* **managed:** recognize PE Thumb and ARMNT machines ([#605](https://github.com/morluto/rea/issues/605)) ([0ce529a](https://github.com/morluto/rea/commit/0ce529af4e0280fcbd4e647d0fcb0a9ca9f3496e))
* **mcp:** emit valid schemas for empty arrays ([#535](https://github.com/morluto/rea/issues/535)) ([4007b20](https://github.com/morluto/rea/commit/4007b20fc277b4d20b52cae328dea58ae033be63)), closes [#528](https://github.com/morluto/rea/issues/528)
* **mcp:** return complete inline Evidence records ([#585](https://github.com/morluto/rea/issues/585)) ([ea9c3da](https://github.com/morluto/rea/commit/ea9c3dab6b2ff4fa943c8ca4fec7ae8b304dbd93)), closes [#551](https://github.com/morluto/rea/issues/551)
* **native:** capture Mach-O header metadata alongside load commands ([#525](https://github.com/morluto/rea/issues/525)) ([a8195ba](https://github.com/morluto/rea/commit/a8195ba2cc34a37f68d7bb8a8087d73ace40984b))
* **native:** decode little-endian fat headers ([bede3e3](https://github.com/morluto/rea/commit/bede3e3c60e53d445209096b360a81eaa0c446cc)), closes [#592](https://github.com/morluto/rea/issues/592)
* **native:** decode Mach protection bits in their proper positions ([#586](https://github.com/morluto/rea/issues/586)) ([6aba6ae](https://github.com/morluto/rea/commit/6aba6ae2316fe6299c855a3db52b221fff63c00c))
* **native:** inspect Apple dispatch metadata in FAT64 binaries ([#590](https://github.com/morluto/rea/issues/590)) ([f3e6582](https://github.com/morluto/rea/commit/f3e6582e9ed327c5accb8f9068ea0eb9bac49b1f))
* **native:** inspect the selected universal Mach-O architecture ([#601](https://github.com/morluto/rea/issues/601)) ([2b7bb3b](https://github.com/morluto/rea/commit/2b7bb3bb6a87704c18469768bc82d87e97b5c99c))
* **native:** match compound otool keys exactly and badge unknown thread entrypoints ([#534](https://github.com/morluto/rea/issues/534)) ([d40502a](https://github.com/morluto/rea/commit/d40502aa3b9a8c87fde49e5887547066128f19ba))
* **native:** normalize otool line endings and strip plist JSON BOM ([#533](https://github.com/morluto/rea/issues/533)) ([3e4d4d9](https://github.com/morluto/rea/commit/3e4d4d93fdc3eb5fdffda3a8dc8bec43201cdd98))
* **native:** preserve text-valued load command metadata ([#520](https://github.com/morluto/rea/issues/520)) ([bcfb407](https://github.com/morluto/rea/commit/bcfb4072f2ff665e93477206e14ce4b0581f97b9))
* **native:** reject signal-terminated command captures ([#608](https://github.com/morluto/rea/issues/608)) ([b81d18e](https://github.com/morluto/rea/commit/b81d18eeee9d93dafcb15e3d723de951509c2612))
* **native:** reject trailing text in lipo integers and keep multi-word otool keys ([#531](https://github.com/morluto/rea/issues/531)) ([9e30d93](https://github.com/morluto/rea/commit/9e30d93af3d2c0cc1a7536a10e3141f9f2fb499c))
* **native:** retain lazy dylibs, normalize version-min builds, limit thread entrypoints ([#532](https://github.com/morluto/rea/issues/532)) ([0f77ada](https://github.com/morluto/rea/commit/0f77ada55e6d1d01cb925993d871bf4a94f94bb2))
* **native:** retain re-exported Mach-O library dependencies ([#516](https://github.com/morluto/rea/issues/516)) ([4a5673e](https://github.com/morluto/rea/commit/4a5673e1dc6f2213cf94121384cff405e390677a))
* **package:** separate agent and Hopper setup support ([#584](https://github.com/morluto/rea/issues/584)) ([205a977](https://github.com/morluto/rea/commit/205a9777776476b4f361e38f25d1c75baaccd420))
* **platform:** accept absolute paths for any host and stop blaming the ceiling for a missing grant ([#552](https://github.com/morluto/rea/issues/552)) ([e793e12](https://github.com/morluto/rea/commit/e793e124a27b8087057f58f39028144ea6f6e173))
* **process:** align provider detach with configured platform ([3fff74f](https://github.com/morluto/rea/commit/3fff74fb5bb9725be2456e8c39bc0b98181d0687))
* repair boundary contracts across CLI and MCP ([#597](https://github.com/morluto/rea/issues/597)) ([9c25dc4](https://github.com/morluto/rea/commit/9c25dc4ed2915a81fc83a1d4dc22e7ba814b8dff))
* **replay:** keep __proto__ own properties and reject symbol-keyed results ([#540](https://github.com/morluto/rea/issues/540)) ([05bb630](https://github.com/morluto/rea/commit/05bb630a00aa521229cde53ded9a5345b8bd1a2b))
* **replay:** link the complete ESM graph before evaluating ([#515](https://github.com/morluto/rea/issues/515)) ([4200a42](https://github.com/morluto/rea/commit/4200a425d50eab80847edf3baa9ea4c5244e8be8))
* **replay:** preserve CommonJS object as ESM default export ([#519](https://github.com/morluto/rea/issues/519)) ([2df6b51](https://github.com/morluto/rea/commit/2df6b51ebb87e8d406d6201d8f3158aefefa7cc5))
* **replay:** preserve Date call and explicit constructor semantics ([#512](https://github.com/morluto/rea/issues/512)) ([9975bd2](https://github.com/morluto/rea/commit/9975bd23cdba7e196ca97c3fcec41a6eee925e57))
* **replay:** preserve sparse array positions in result projection ([#522](https://github.com/morluto/rea/issues/522)) ([9d1c363](https://github.com/morluto/rea/commit/9d1c3631b8deccb5fb91906130f38e3f24aa254e))
* **replay:** share one seeded generator and present builtins with real identity ([#539](https://github.com/morluto/rea/issues/539)) ([5b51fa0](https://github.com/morluto/rea/commit/5b51fa01e2391cd4b6d5e9ba7b6aa7615de891b1))
* **repo:** keep dependency links out of version control ([#617](https://github.com/morluto/rea/issues/617)) ([b3223e3](https://github.com/morluto/rea/commit/b3223e3f61a23b79152939ef755aca95e7640f09))
* **skill:** remove obsolete grants and audit tool effects ([2919def](https://github.com/morluto/rea/commit/2919def828b3c8fc7947989f1de3f4f4ac4cdd36))
* **test:** improve capture reliability and runner cleanup ([#609](https://github.com/morluto/rea/issues/609)) ([d19686a](https://github.com/morluto/rea/commit/d19686a2a5122c691f7885997906ecb31dd9827d))
* **tools:** simplify direct invocation and harden boundary contracts ([#555](https://github.com/morluto/rea/issues/555)) ([b5e9891](https://github.com/morluto/rea/commit/b5e98915c60968213141f33839e0c5c4b34df4db))
* **web:** retain uncertainty for incomplete capture inventories ([#513](https://github.com/morluto/rea/issues/513)) ([d8c18f6](https://github.com/morluto/rea/commit/d8c18f604f292c95b6b0b185d23517cb6881c5fb))
* **win32:** probe .cmd/.bat runtime shims via cmd.exe to avoid spawn EINVAL ([#505](https://github.com/morluto/rea/issues/505)) ([31ed005](https://github.com/morluto/rea/commit/31ed005183c315f1bc72f6e10730a47be73d7f1c))
* **workflows:** preserve punctuation in filesystem source paths ([#521](https://github.com/morluto/rea/issues/521)) ([5b28a8b](https://github.com/morluto/rea/commit/5b28a8b331259e026678e681210e9c3c4f48f2fa))
* **workflows:** retain container presence in export shape comparisons ([#523](https://github.com/morluto/rea/issues/523)) ([3854458](https://github.com/morluto/rea/commit/385445804ab45605a47edcb996ebbc026e2f0a43))


### Code Refactoring

* **config:** take the environment as an input at every configuration read ([#554](https://github.com/morluto/rea/issues/554)) ([53fe7d6](https://github.com/morluto/rea/commit/53fe7d6d3b3630472124563ccafdad3f4964b4bc))
* **domain:** consolidate duplicated semantic member and literal helpers ([#550](https://github.com/morluto/rea/issues/550)) ([09830da](https://github.com/morluto/rea/commit/09830dad053f2b1440e0b1cde63747606684be4b))
* **domain:** own digest and prefixed identifier shapes in one module ([#547](https://github.com/morluto/rea/issues/547)) ([ea58834](https://github.com/morluto/rea/commit/ea5883494036ddb30d138fdb381d54b2d9808b49))
* **host:** inject platform and environment instead of reading them ambiently ([#549](https://github.com/morluto/rea/issues/549)) ([5b59b87](https://github.com/morluto/rea/commit/5b59b87726b459cf9887dd4edc176981ef4e6afc))
* simplify runtime tools and remove replay engines ([#572](https://github.com/morluto/rea/issues/572)) ([e07b816](https://github.com/morluto/rea/commit/e07b81649e96668e5ce166cfc6db3b59a7777697))


### Documentation

* add boundary contract guidance ([42e6a8a](https://github.com/morluto/rea/commit/42e6a8a6f6da4c3aebb10235a27d471dc2590954))
* add Discord community links to README ([79bf26f](https://github.com/morluto/rea/commit/79bf26f33f980c20367986080a16d4a9f7952048))
* align roadmap with direct tool use ([eba709e](https://github.com/morluto/rea/commit/eba709e5c096796b0afe3ce9203659df9eaf0a7d))
* align translated READMEs and clarify support guides ([5b383b2](https://github.com/morluto/rea/commit/5b383b2ddd4195cb15e412b81853955b38419721))
* clarify README wording and analysis tool support ([97822f2](https://github.com/morluto/rea/commit/97822f233be49a8b582b4c2aa982af3854ca0bb2))
* move README image above Discord community ([ad86d39](https://github.com/morluto/rea/commit/ad86d39d2cb4f2d1ce0da08a17d5f7948c0797ec))
* place community invitation below README navigation ([69a45e0](https://github.com/morluto/rea/commit/69a45e0bbc03d87624de866a821b976e4aaca069))
* place Discord community below setup command ([778e464](https://github.com/morluto/rea/commit/778e464c206ba75a2f94edaad3c05e8bf63bed10))
* place setup command above README image ([c6d3bdf](https://github.com/morluto/rea/commit/c6d3bdf597d9cd75a6f7396236e1a47f5ee4288d))


### Tests

* **setup:** isolate client fixtures across host platforms ([f73bb0f](https://github.com/morluto/rea/commit/f73bb0fe116678543a73d13f58eaa3b48133afc5))

## [3.2.1](https://github.com/morluto/rea/compare/rea-agents-3.2.0...rea-agents-3.2.1) (2026-10-03)


### Bug Fixes

* **release:** tolerate npm registry propagation delay ([726b730](https://github.com/morluto/rea/commit/726b730b84830b208725df50fa0251ece1fa199f))


### Tests

* **release:** accept guarded npm publishing ([b7bc855](https://github.com/morluto/rea/commit/b7bc8554928c8eca9c29842c77e4021c1e42e054))

## [3.2.0](https://github.com/morluto/rea/compare/rea-agents-3.1.0...rea-agents-3.2.0) (2026-10-03)


### Features

* **native:** add investigation features ([#486](https://github.com/morluto/rea/issues/486)) ([ed933d1](https://github.com/morluto/rea/commit/ed933d18933814e3957a920972ccf91117d4ed87))


### Bug Fixes

* **artifacts:** stabilize extraction approval ([7eb1a95](https://github.com/morluto/rea/commit/7eb1a9500c62b66716878c18ee442c324a715a88))
* **browser:** reject unknown Electron input fields ([1860d4f](https://github.com/morluto/rea/commit/1860d4f0e531919ee9b10bec7ad8db43e18a291b))
* **ci:** retain artifacts for delayed reruns ([07888ec](https://github.com/morluto/rea/commit/07888ec096f69753a1535703fb7b3c3070e786b7))
* **cli:** remove ignored result limits ([f3645aa](https://github.com/morluto/rea/commit/f3645aa51e55c5207f7b9b1f0156ffaef7aaed42))
* consolidate boundary ownership and cleanup failure paths ([#477](https://github.com/morluto/rea/issues/477)) ([2160d4f](https://github.com/morluto/rea/commit/2160d4fae581243990e539a9c401d1b8824e1763))
* **contracts:** align byte read schema with provider ([f580d9d](https://github.com/morluto/rea/commit/f580d9d07382bc9642bce896d431c827955339e4))
* **ghidra:** return complete native analysis results ([a66e43a](https://github.com/morluto/rea/commit/a66e43a99dda1604c8250c9eb73aa8ef000371c9))
* **managed:** retain every source location ([33b2099](https://github.com/morluto/rea/commit/33b20991c455306d66f8687a9f80ea22073d4207))
* **process:** capture complete host probe output ([6c68ff5](https://github.com/morluto/rea/commit/6c68ff565fe1196fd8c7a63598e8bd94098abc3c))
* **runtime:** make observed target role optional ([593a8e1](https://github.com/morluto/rea/commit/593a8e12ceac1cfe350493cfe6b0d1360eb85f7c))
* **runtime:** retain complete reconciled graph content ([bedd55a](https://github.com/morluto/rea/commit/bedd55a4b4ccc9a0c1441d3836138b323de6d126))


### Code Refactoring

* **analysis:** remove caller-selected result caps ([a8c58c6](https://github.com/morluto/rea/commit/a8c58c6605ac37a8b504167732affc5ce4fc772f))
* **analysis:** remove fixed result quotas ([20152a9](https://github.com/morluto/rea/commit/20152a9872dd035714beb5ef5b8898a9b4d1d6c4))
* **artifacts:** consolidate inventory into inspection ([0fe96d9](https://github.com/morluto/rea/commit/0fe96d92dfefbaf28d2abfd5e237f6d0e82eee7b))
* **artifact:** simplify extraction and inventory results ([07ff8b3](https://github.com/morluto/rea/commit/07ff8b30ee497d9f4477a0a9ae97f3f5addbb45a))
* **artifacts:** remove duplicate inventory wrapper ([aa6eee1](https://github.com/morluto/rea/commit/aa6eee1a712d1a319bbaed5387aa5f4429755a1f))
* **artifacts:** remove selectors and traversal quotas ([8c24272](https://github.com/morluto/rea/commit/8c24272ee7e6d30b1493ee7ccd63e45734fe2f95))
* **artifacts:** select extraction by logical path ([7ba3580](https://github.com/morluto/rea/commit/7ba3580c860463adcd5edc73b7a80f34b92480cf))
* **browser:** remove arbitrary capture ceilings ([5dd3b46](https://github.com/morluto/rea/commit/5dd3b4655e21222a6598bf8cbc0be90f3cbf5e0f))
* **browser:** return complete observation evidence ([0e2738f](https://github.com/morluto/rea/commit/0e2738ffb6aa35bb06fe01d0af864aec968570cf))
* **browser:** return complete scenario observations ([e80fe41](https://github.com/morluto/rea/commit/e80fe414b13294446f959b382cb240c806cfe000))
* **browser:** share authorized main-frame polling ([eec75ce](https://github.com/morluto/rea/commit/eec75ce918cbac576fd217847911793331aa32a0))
* **browser:** share canonical identity digest ([a6d9e49](https://github.com/morluto/rea/commit/a6d9e49ab46150c8b757f5bdd5f80d3a8ff52f26))
* **contracts:** remove duplicate schema aliases ([4593c29](https://github.com/morluto/rea/commit/4593c29b64d3f6c43ddb19228da6231f1055eba4))
* **contracts:** simplify workflows and drop readiness tool ([7acac61](https://github.com/morluto/rea/commit/7acac615ca2b8e3f4edd65fd8a08b237f85b5ac7))
* **coverage:** evaluate inline without workspaces ([9e76054](https://github.com/morluto/rea/commit/9e7605482acf2de77ad04c5c5e03ac4280a11d7f))
* **domain:** encode comparison and lifecycle states exactly ([#473](https://github.com/morluto/rea/issues/473)) ([d65730c](https://github.com/morluto/rea/commit/d65730c4c24ab6183426516d4564e6c25294b35d))
* **domain:** share AST property name reader ([4f4cc59](https://github.com/morluto/rea/commit/4f4cc59873ec704811649aeca8a49e3bcdbdf324))
* **electron:** retain complete active observations ([e8c56e0](https://github.com/morluto/rea/commit/e8c56e0c0aeb114e09636ad1841d8fd73720b5cc))
* **errors:** remove stale workspace failures ([f570d40](https://github.com/morluto/rea/commit/f570d40f50bc8621b32ba4e255660ed1b1398356))
* **evidence:** remove obsolete ID resolvers ([a3920e2](https://github.com/morluto/rea/commit/a3920e2abd915eba31b59413710315a85caf1afa))
* **evidence:** remove session ledger quotas ([dca293a](https://github.com/morluto/rea/commit/dca293a446fa86767fb4bed6fe734f09b6cfafde))
* **files:** use caller paths for local evidence files ([c34efca](https://github.com/morluto/rea/commit/c34efca4cd322d4816ab4cd526a7475489edc814))
* **ghidra:** remove redundant schema markers ([c2a6f4b](https://github.com/morluto/rea/commit/c2a6f4bc437671c25ba318d21b82818c8e6bf2ce))
* **javascript:** remove analysis ceilings ([9aec690](https://github.com/morluto/rea/commit/9aec6908b5c7ad50da6882415700cbe53c3f62ed))
* **managed:** derive inspection from PE CLI extents ([dfad09e](https://github.com/morluto/rea/commit/dfad09e3b5769b079bf2d07382aee310d682724f))
* **mcp:** simplify evidence and workflows ([6740ed5](https://github.com/morluto/rea/commit/6740ed5215578eaaf33c785d6245649d76a0411c))
* **mcp:** simplify tool inputs and inline results ([f55c2b9](https://github.com/morluto/rea/commit/f55c2b92676e4a7eb06efbc8d9a908a7de62541a))
* **mcp:** simplify workflow and observation scope ([34d00fd](https://github.com/morluto/rea/commit/34d00fd323c793278c6ed126308c58e2fc7efd54))
* **observation:** internalize capture budgets ([7b3c797](https://github.com/morluto/rea/commit/7b3c7972377c7f77b1328e7d1de3f54835bc1397))
* **observation:** retain complete tool results ([fa2b6c5](https://github.com/morluto/rea/commit/fa2b6c5a61adcb75c4c2773ed1c9f7dba83fc1d3))
* **observation:** return complete inventories ([c523c38](https://github.com/morluto/rea/commit/c523c38027f536e8319eb2acc1840274c5bc5986))
* **permission:** remove unused authorization helpers ([1b0ab75](https://github.com/morluto/rea/commit/1b0ab75a84ccdcf036ccfc019d1890b2d626699a))
* **process:** remove fixed scenario ceilings ([abf7c11](https://github.com/morluto/rea/commit/abf7c1142e759a291d2267fedf15b0dd444a5684))
* **process:** remove redundant schema version markers ([b3aca52](https://github.com/morluto/rea/commit/b3aca5289bf973ffb4072253eebe86e0acced347))
* **process:** remove request count ceilings ([f2dc749](https://github.com/morluto/rea/commit/f2dc749c862a16d056de53e95914a9a411592583))
* **process:** remove unused paired experiment ([e1d755f](https://github.com/morluto/rea/commit/e1d755f7cd574860f59965a6244dbd43f5032f2c))
* **prompts:** make tool workflows optional ([3fd9650](https://github.com/morluto/rea/commit/3fd96506f223889a2d327cc7c97a95bf48ccb594))
* **reference:** share graph index projections ([6ee87fb](https://github.com/morluto/rea/commit/6ee87fbf2defcb10a17352b36ebeed67c6ce6dc5))
* remove cross-version investigation workflow ([81996df](https://github.com/morluto/rea/commit/81996df7a59ae6efb0f7be6687af89e66c64cdcb))
* **replay:** share sandbox probe arguments ([9fca6c0](https://github.com/morluto/rea/commit/9fca6c0296ac360f9d2c838440b24d2ea79234b5))
* **replay:** simplify runtime value checks ([60cb68a](https://github.com/morluto/rea/commit/60cb68a276b012964b08c18e9d60af22e64c468f))
* return complete analysis results inline ([a2a3243](https://github.com/morluto/rea/commit/a2a3243ea874ee1662c62a83ced63be218e0218e))
* return complete tool results inline ([0d96275](https://github.com/morluto/rea/commit/0d96275b6887b72519d2bc54f72012db6a8e482c))
* **runtime:** retain complete reconciliation outputs ([79ea571](https://github.com/morluto/rea/commit/79ea571512a1f55200eb5520d6c56104dba54e5b))
* **schema:** remove data-only version markers ([5457f4a](https://github.com/morluto/rea/commit/5457f4a2bceccb9c40e19a9986964025f279fc91))
* **server:** remove registration alias ([8097ec4](https://github.com/morluto/rea/commit/8097ec456a14992b578057438be8a6e89a076cdf))
* **server:** use canonical elicitation type ([bb6a58c](https://github.com/morluto/rea/commit/bb6a58c2a7eec15fb5f224376230398b51d1b952))
* **test:** colocate pure-domain tests and reduce test debt ([#471](https://github.com/morluto/rea/issues/471)) ([e91c8c3](https://github.com/morluto/rea/commit/e91c8c39c2acddc4389ed0d01950d1954c472e47))
* **test:** keep coverage at behavioral boundaries ([#474](https://github.com/morluto/rea/issues/474)) ([d4dc940](https://github.com/morluto/rea/commit/d4dc940bd871089ffa1b42d3475798b2f4f9c992))
* **tools:** remove arbitrary workflow ceilings ([5f73cb0](https://github.com/morluto/rea/commit/5f73cb061b6fec532d1cccf5a8bce59855823fa4))
* **tools:** remove artificial analysis ceilings ([2f08c7c](https://github.com/morluto/rea/commit/2f08c7c932d3619a481709935f07da59de3d3b27))
* **tools:** remove redundant limits and acknowledgements ([bd0e341](https://github.com/morluto/rea/commit/bd0e34157239613aed7aa9315df0e97d03d8636c))
* **tools:** remove remaining arbitrary workflow caps ([ecf3ed8](https://github.com/morluto/rea/commit/ecf3ed8bdb9ef7a83e7a2fb23443eced6c3824b0))
* **tools:** return complete analysis results inline ([2a6eb41](https://github.com/morluto/rea/commit/2a6eb41147e496b9e044011fa3b755ef74388c51))
* **workflows:** simplify evidence reference inputs ([24e1fa9](https://github.com/morluto/rea/commit/24e1fa9a76e447cff318da9f48c7adb659a1f8ab))


### Documentation

* add REA tool design guidance ([#485](https://github.com/morluto/rea/issues/485)) ([36aeec9](https://github.com/morluto/rea/commit/36aeec95863ca28d3e3aa5bec75a45d3824e17f5))
* clarify aggregate context tools ([c7e207c](https://github.com/morluto/rea/commit/c7e207c290e376db5c2f210f9ac08fe170ef3ec4))
* clarify MCP tool design guidance ([36aeec9](https://github.com/morluto/rea/commit/36aeec95863ca28d3e3aa5bec75a45d3824e17f5))
* correct inline evidence and Hopper behavior ([bf9cce1](https://github.com/morluto/rea/commit/bf9cce1aef89a769320d217e82b895b086880e69))
* describe complete application analysis outputs ([271b162](https://github.com/morluto/rea/commit/271b1620e68f3a6bbc69f28aa4c4d18d5c453baf))
* generalize reverse-engineering workflow ([#488](https://github.com/morluto/rea/issues/488)) ([4ecc7a7](https://github.com/morluto/rea/commit/4ecc7a72f2d6d78b8d9c59a146e532fe552c40bb))
* improve GitHub issue and pull request templates ([c490d85](https://github.com/morluto/rea/commit/c490d85045de07488e01747db9c9f77d264b2e36))
* prioritize reusable analysis primitives ([#493](https://github.com/morluto/rea/issues/493)) ([9dd72c4](https://github.com/morluto/rea/commit/9dd72c4911841671594570677f5ba6e3992d076d))
* refresh managed conformance manifest ([23e56c5](https://github.com/morluto/rea/commit/23e56c517c08abcafe3a81919215433458aef27e))
* refresh tool catalog and cleanup audit fixtures ([53db3a4](https://github.com/morluto/rea/commit/53db3a476b2881f498a5d6c87195e783268c1988))
* regenerate tool and evidence catalogs ([2f604a3](https://github.com/morluto/rea/commit/2f604a3c3ad037a68da4c33a30cb5316983b070f))
* regenerate tool and evidence catalogs ([f2bbd59](https://github.com/morluto/rea/commit/f2bbd5957eccac6164b3f12db87921ffb09bdcf2))
* **tools:** clarify complete inline results ([3b64c81](https://github.com/morluto/rea/commit/3b64c813cf8bcd0cdd262d0a3d5950819f320a12))
* **tools:** clarify complete inline workflows ([4168174](https://github.com/morluto/rea/commit/41681742ccea83a7956e7bc303da4aa223ed4877))
* **tools:** describe uncapped tool behavior accurately ([4cea84d](https://github.com/morluto/rea/commit/4cea84d7cbb0508e6c0dde36a2a0542855681f95))
* **tools:** update inline workflow guidance ([4ad937c](https://github.com/morluto/rea/commit/4ad937c6caeec89ded592ea82dec4fa13ea17d8c))


### Tests

* **artifacts:** exercise argument-free extraction preflight ([a6d5b3e](https://github.com/morluto/rea/commit/a6d5b3ea9d1f53afeda33ef53fe50f42feac2343))
* **browser:** assert strict inputs without legacy fields ([9ddf22e](https://github.com/morluto/rea/commit/9ddf22e1962803bf06d54b2e577a0c03a3f3ad48))
* **browser:** cover complete screenshot output ([3f547ea](https://github.com/morluto/rea/commit/3f547eafa4c6f27b8264025c754392161687908e))
* **browser:** remove stale input field assertion ([60c110d](https://github.com/morluto/rea/commit/60c110d97b1b22c010b8597965b3ad09f4f51480))
* **cli:** consolidate duplicate setup journey ([9bd7e2c](https://github.com/morluto/rea/commit/9bd7e2cb459d0354ee2c406555de9e427c549086))
* **cli:** remove duplicate browser discovery case ([dcb0362](https://github.com/morluto/rea/commit/dcb036292e975c81780dbf7a711fd1a565a13a10))
* **conformance:** remove fixture generator test option ([ea853ce](https://github.com/morluto/rea/commit/ea853cebde5641dc9c12ef59005de84197463467))
* **contracts:** remove duplicate tool inventories ([0ae3c08](https://github.com/morluto/rea/commit/0ae3c0837b387e53686bcd6e8aa03cb29f80458a))
* **hopper:** name regex search assertion accurately ([9240bd8](https://github.com/morluto/rea/commit/9240bd8d166ffee93a90fd55c5de4b58d8ff6ad4))
* **hopper:** remove dossier identity assertion ([b5c0b5b](https://github.com/morluto/rea/commit/b5c0b5b53e2d15dd6da9d4e8b1d3c3c21a16c409))
* **mcp:** align workflow assertions with current guidance ([f8bb113](https://github.com/morluto/rea/commit/f8bb113c22cf23916a8cd8a5d77734ccaf63fd08))
* **mcp:** consolidate catalog inventory checks ([3afcd64](https://github.com/morluto/rea/commit/3afcd641462bbd99ebdc3bf2fc8264e2c3344c09))
* **mcp:** validate defaults at tool boundary ([21241d2](https://github.com/morluto/rea/commit/21241d2323d323f405b3cff4692e01364b6ddbde))
* remove duplicate export schema acceptance ([b783e7f](https://github.com/morluto/rea/commit/b783e7febef8c22b41817a61a7f8293393ac6425))
* remove obsolete schema version assertions ([fe342fa](https://github.com/morluto/rea/commit/fe342faa832ec9b17a6fb1dd85b1cf269b33cf1b))
* remove stale limits and handoff expectations ([acf33d6](https://github.com/morluto/rea/commit/acf33d6df272873728aaa7527c5d43fa2a13132b))
* remove vacuous and duplicate assertions ([56e2bf7](https://github.com/morluto/rea/commit/56e2bf7696e6ccbc3e4b5baf9249c6d4152f4a43))
* remove Vitest config test exports ([d6e545c](https://github.com/morluto/rea/commit/d6e545cc4832ed47cc98d974aa8e4aa9453afb98))
* replace brittle workflow and readme checks ([b3529aa](https://github.com/morluto/rea/commit/b3529aa327026472798a5f0971dcb325d221ddc6))
* replace implementation lock-in with behavioural assertions ([#498](https://github.com/morluto/rea/issues/498)) ([7ee3f23](https://github.com/morluto/rea/commit/7ee3f236a9f753dfc90d84f95f20598e4e45fd0d))
* **replay:** remove duplicate schema coverage ([4ec2343](https://github.com/morluto/rea/commit/4ec2343d91925e583b15d5404af2eabaf6ffed0f))

## [3.1.0](https://github.com/morluto/rea/compare/rea-agents-3.0.0...rea-agents-3.1.0) (2026-08-09)


### Features

* **electron:** add autonomous Electron runtime analysis ([#464](https://github.com/morluto/rea/issues/464)) ([8f229ed](https://github.com/morluto/rea/commit/8f229ede70c0a4e224c1cf71d61487e17b779d6a))


### Bug Fixes

* **ci:** guard Release Please PR branch parsing ([84cc819](https://github.com/morluto/rea/commit/84cc819284b9ce7ee648850c85d5daf3a33e5a24))
* **ci:** guard release PR branch parsing ([6838b6b](https://github.com/morluto/rea/commit/6838b6bff9ab5c400432caefd8c8737b86c41f07))
* harden evidence lifecycle and MCP contracts ([5155924](https://github.com/morluto/rea/commit/51559245d2e1c2d7550cfe489716950fe6154bd0))
* harden structured configuration comparisons ([#467](https://github.com/morluto/rea/issues/467)) ([6901edc](https://github.com/morluto/rea/commit/6901edc05d56063bdbe8be96511b1b21863630b5))
* **npm:** preserve explicit setup versions ([#465](https://github.com/morluto/rea/issues/465)) ([1783bf6](https://github.com/morluto/rea/commit/1783bf6dfdd4ec11e824870ce5b1a2f5a321450e))


### Code Refactoring

* **mcp:** make analysis states unrepresentable ([#468](https://github.com/morluto/rea/issues/468)) ([b8a9da0](https://github.com/morluto/rea/commit/b8a9da0c0f9f0b2b022a350d2c7c671d1fa3f886))


### Documentation

* clarify agent reverse-engineering promise ([ed4a628](https://github.com/morluto/rea/commit/ed4a62871f7924948e3774ae6cf880514a560ff4))
* clarify the agent reverse-engineering promise ([#466](https://github.com/morluto/rea/issues/466)) ([ed4a628](https://github.com/morluto/rea/commit/ed4a62871f7924948e3774ae6cf880514a560ff4))
* **npm:** simplify current setup command ([#469](https://github.com/morluto/rea/issues/469)) ([8b62b1a](https://github.com/morluto/rea/commit/8b62b1a71586e9409e4dd645f3d4947ef61e59b1))

## [3.0.0](https://github.com/morluto/rea/compare/rea-agents-2.7.0...rea-agents-3.0.0) (2026-08-01)


### ⚠ BREAKING CHANGES

* export_evidence_bundle now requires a filesystem path and no longer returns an inline bundle.

### Features

* make evidence bundles canonical MCP resources ([1712e6d](https://github.com/morluto/rea/commit/1712e6d821965ce5edc3880fe4ebab2e3cc02fd4))


### Bug Fixes

* address MCP resource review feedback ([f3b3fb0](https://github.com/morluto/rea/commit/f3b3fb07ded3d1ad72c0a4f24ca3147ef9722c5d))
* align aggregate tools with session capabilities ([ede91ff](https://github.com/morluto/rea/commit/ede91ff1f04563001f695ec3869daeb3c826154a))
* **ci:** align Vitest project worker budgets ([f47ee1a](https://github.com/morluto/rea/commit/f47ee1abb4fc8dbd5da3fa13c5870d6580b28bfa))
* **ci:** allow documented public type aliases ([97f6a0f](https://github.com/morluto/rea/commit/97f6a0f3fd2ebf8fa884d7f7ba6e1c66ecfe80e0))
* **ci:** make coverage report merging composable ([788f405](https://github.com/morluto/rea/commit/788f4057aee65dfae441249d2c9789bb996912a7))
* **ci:** stabilize Vitest project routing and shards ([f07acde](https://github.com/morluto/rea/commit/f07acde513d4c74d027b66e143cf5072246b412b))
* **errors:** preserve actionable analysis diagnostics ([0f96bf3](https://github.com/morluto/rea/commit/0f96bf365c330a7eb121a173bfa140cc2b652764))
* **mcp:** clarify routing and advertise input examples ([969519c](https://github.com/morluto/rea/commit/969519c00f31b5bc0f23dcffe8867e091461fda6))
* **mcp:** clarify target routing and caller diagnostics ([3e1e8cd](https://github.com/morluto/rea/commit/3e1e8cd3f829e6d3ac8b3c63d979f9db84dec826))
* **test:** bound boundary worker pressure ([935721d](https://github.com/morluto/rea/commit/935721df10d25d23621dbc2be90d334644e0858c))
* **test:** honor boundary ownership and public aliases ([92a1c33](https://github.com/morluto/rea/commit/92a1c33625ff88d81581554687e7708dd3c91e2d))
* **test:** retain subprocess coverage and cleanup ([7f46bb1](https://github.com/morluto/rea/commit/7f46bb18241bf3815e5e01816277d0cafe8f923b))
* **test:** retain subprocess coverage and cleanup ([dae2b9c](https://github.com/morluto/rea/commit/dae2b9cc4e8753827702ada6e51f2ee01811cfed))
* **test:** stabilize boundary timing ([f0d8cda](https://github.com/morluto/rea/commit/f0d8cdafa86bafdc6ad5d8c2d23a97ef583b53d5))
* **verify:** follow dynamic Hopper tool availability ([281e41f](https://github.com/morluto/rea/commit/281e41f7660066addcc7a204128fb1f49bf7a674))


### Code Refactoring

* preserve provider-neutral runtime seams ([a8161f0](https://github.com/morluto/rea/commit/a8161f0e5540f3261a08015dfe56a4254980c064))


### Documentation

* document resource snapshot workflow ([2a45d8d](https://github.com/morluto/rea/commit/2a45d8de7d52d0a234672d03c7dae794859f8ced))
* refresh generated SDK metadata ([c824db1](https://github.com/morluto/rea/commit/c824db1ab7aed2886e9050c1b7fe2136b77e3698))
* refresh managed completion manifest ([59d4659](https://github.com/morluto/rea/commit/59d465971ea86f933e9037fa32ac2787d935d076))


### Tests

* **contracts:** cover validation branches ([8ccdb33](https://github.com/morluto/rea/commit/8ccdb33dd25922e039140bcd1e3cbf3d5acee837))
* derive MCP SDK identity expectations ([ab4193c](https://github.com/morluto/rea/commit/ab4193c1f48020ff6baa42cb75e033110ee72b36))
* **eval:** cover navigation and address tool routing ([ba098f2](https://github.com/morluto/rea/commit/ba098f24e59efbd567ae8438f65e31af0f0b8050))
* overhaul deterministic suite architecture ([48053d1](https://github.com/morluto/rea/commit/48053d1032324cce6e2fe782ecba43d1b91a1bba))
* overhaul deterministic suite architecture ([513d9b1](https://github.com/morluto/rea/commit/513d9b15558f9174a8e2c0ab00e31cbc05dbaba7))
* **package:** verify npx upgrade on published releases ([7b6f7be](https://github.com/morluto/rea/commit/7b6f7becd257170cebf80f4f9f9c385b0000f074))
* **package:** verify npx upgrade on published releases ([1f8ad7b](https://github.com/morluto/rea/commit/1f8ad7bc68f50d396715116467f19524da7e05e6))


### Continuous Integration

* document deterministic suite ownership ([3c42403](https://github.com/morluto/rea/commit/3c42403b78b53e7b5358c2bca9bc156ef2c32efd))

## [2.7.0](https://github.com/morluto/rea/compare/rea-agents-2.6.0...rea-agents-2.7.0) (2026-07-28)


### Features

* **bytecode:** add JVM and Python bytecode providers ([1a75f8d](https://github.com/morluto/rea/commit/1a75f8dc236d8269a5fa07e042471ac79e79d728))
* **bytecode:** add JVM and Python bytecode providers ([4e0127d](https://github.com/morluto/rea/commit/4e0127d620377e5dc7e09444f9db0977e3d47ed1)), closes [#367](https://github.com/morluto/rea/issues/367)
* **conformance:** add portable conformance export package format ([91fb87d](https://github.com/morluto/rea/commit/91fb87d17e7885439762667c96167af79a2e044e))
* **conformance:** add portable conformance export package format ([4ee30e4](https://github.com/morluto/rea/commit/4ee30e4145db9b496158cd980af05e22010856a7))
* **metadata:** add deeper ObjC/Swift metadata and database save/licensing ([4602efd](https://github.com/morluto/rea/commit/4602efd27cbf8701c2dc15542042bc9d9ef76e7f))
* **metadata:** add deeper ObjC/Swift metadata and database save/licensing ([d7a0753](https://github.com/morluto/rea/commit/d7a07535b0fb61ee8f9ae648bb673dda23290653)), closes [#353](https://github.com/morluto/rea/issues/353)
* **mobile:** add Android APK/AAB/DEX and iOS IPA static investigation providers ([18624df](https://github.com/morluto/rea/commit/18624df5724a2c4d14a4e8e178660456424b2344))
* **mobile:** add Android APK/AAB/DEX and iOS IPA static investigation providers ([fdeeb27](https://github.com/morluto/rea/commit/fdeeb27f23041c19b5857fe7873106f0cd9c6244)), closes [#366](https://github.com/morluto/rea/issues/366)
* **package:** add MSIX/MSI/AppX package, resource, and signature analysis ([0ef1b91](https://github.com/morluto/rea/commit/0ef1b91cf31f6ca53991ee5ca60b4a22f430c01e))
* **package:** add MSIX/MSI/AppX package, resource, and signature analysis ([6c03f83](https://github.com/morluto/rea/commit/6c03f83b1bd55095d136aeb3700733383365ecc4)), closes [#363](https://github.com/morluto/rea/issues/363)
* **pe:** add broader PE/COFF/PDB static inspection ([f942558](https://github.com/morluto/rea/commit/f9425585736a89165390178f245b0f0f5d6cdacf))
* **pe:** add broader PE/COFF/PDB static inspection ([94e6600](https://github.com/morluto/rea/commit/94e6600faf89436e4e2689fda8050792307b268d)), closes [#362](https://github.com/morluto/rea/issues/362)
* **process:** replace procfs sampling with event-backed process-tree capture ([a5e355a](https://github.com/morluto/rea/commit/a5e355a3d52b19e89535449cd923c35e56ccc60d))
* **process:** replace procfs sampling with event-backed process-tree capture ([d5d2e56](https://github.com/morluto/rea/commit/d5d2e56d0461cb0debba540bc658a9938ac30599)), closes [#332](https://github.com/morluto/rea/issues/332)
* **protocol:** add custom TCP/UDP/IPC/XPC and auth-flow capture ([1fb22b4](https://github.com/morluto/rea/commit/1fb22b4c21e3a5581f3928003cc32ddc1cc9530b))
* **protocol:** add custom TCP/UDP/IPC/XPC and auth-flow capture ([6fa6f9b](https://github.com/morluto/rea/commit/6fa6f9b6d9595a480a590766dadcfebb8e7111b5)), closes [#365](https://github.com/morluto/rea/issues/365)
* **protocol:** add gRPC/Protobuf and JSON-RPC/MessagePack capture ([54153ed](https://github.com/morluto/rea/commit/54153ed62cb4f55d1efd4794490c2481ab34e212))
* **protocol:** add gRPC/Protobuf and JSON-RPC/MessagePack capture ([3f336fe](https://github.com/morluto/rea/commit/3f336fefb132971bc6bb37b2b59aa01a5e3be5ca)), closes [#364](https://github.com/morluto/rea/issues/364)


### Bug Fixes

* **catalog:** digest provider projections ([645668b](https://github.com/morluto/rea/commit/645668b70dfdff74582d4ac26cda417947231764))
* **catalog:** digest provider projections ([c4cd033](https://github.com/morluto/rea/commit/c4cd0330e00eeb8e272abbf6ecc6ce961e72f317))

## [2.6.0](https://github.com/morluto/rea/compare/rea-agents-2.5.1...rea-agents-2.6.0) (2026-07-26)


### Features

* complete evidence-backed roadmap workflows ([1a0931b](https://github.com/morluto/rea/commit/1a0931b630587701d495d1634fbafe3638ad5516))
* **hopper:** report bridge progress diagnostics ([7a43420](https://github.com/morluto/rea/commit/7a434200297df85c62c02bb103cf870d14f202f7))
* **native:** inspect API boundaries with evidence ([521139d](https://github.com/morluto/rea/commit/521139d4a57a8ab2e25bb262d2a1fd09fd06be92))


### Bug Fixes

* **setup:** refresh stale local npx bootstrap ([6d37efe](https://github.com/morluto/rea/commit/6d37efe8fa1fb9b09c8eaa3a1ed6b6f63188ae22))
* **setup:** refresh stale local npx bootstrap ([90bb161](https://github.com/morluto/rea/commit/90bb1610f56448846adf85b31d9ae96be12dfb4a))


### Performance Improvements

* **mcp:** reduce cold-start work ([8ec9bb1](https://github.com/morluto/rea/commit/8ec9bb1bfea8bc57441bec72f3fcfbe93cf5d4f4))
* **mcp:** reduce cold-start work ([fecddc0](https://github.com/morluto/rea/commit/fecddc0549a31e99a5ea72cbda84e448b1a961d5))


### Tests

* add critical provider workflow coverage ([4716fa2](https://github.com/morluto/rea/commit/4716fa2ece954f5e53bdda9d1f33afad57d2e151))
* **hopper:** remove brittle diagnostic source assertion ([40bf55b](https://github.com/morluto/rea/commit/40bf55b74ca6b2c90b3243a29018cb75879ba081))
* **investigation:** prove multi-version fixture closure ([5184816](https://github.com/morluto/rea/commit/5184816199895ceff6a489810e12fba0c2c41eb7))
* **mcp:** stabilize lazy-loading verification ([7157ab0](https://github.com/morluto/rea/commit/7157ab0b70833cc8237271e8625ccb7965c318c3))
* **package:** prove artifact cleanup and identity ([9522adf](https://github.com/morluto/rea/commit/9522adf19ac915247e2c74b18d3ef5cab95befc5))

## [2.5.1](https://github.com/morluto/rea/compare/rea-agents-2.5.0...rea-agents-2.5.1) (2026-07-25)


### Bug Fixes

* **ci:** normalize generated release metadata ([d43a461](https://github.com/morluto/rea/commit/d43a461958c7bef56a61f75d7f7da73b43e7c387))
* **ci:** normalize release pull request metadata ([119954c](https://github.com/morluto/rea/commit/119954c701533491ccbc4de649592e059f3f5d39))


### Performance Improvements

* **browser:** lazy-load Playwright sessions ([305e729](https://github.com/morluto/rea/commit/305e72995bd52caee7ad8b42aae531b8924e7d0d))
* **dotnet:** reuse authenticated artifact snapshots ([c5e8871](https://github.com/morluto/rea/commit/c5e8871bda737c52d6b09303f9c95e225bf845f2))
* eliminate repeated work in analysis hot paths ([fbe442b](https://github.com/morluto/rea/commit/fbe442b1e2395b93d1bffa2c192ea5ac9a0fab34))
* **evidence:** validate ledger mutations incrementally ([809dfbf](https://github.com/morluto/rea/commit/809dfbfe4868478bf62be40e5f9db35d1b52f6be))
* **javascript:** reuse parsed source across analyses ([adc4852](https://github.com/morluto/rea/commit/adc4852f3aea5bd2847ce9efb53fe43ad030dde6))
* **server:** cache advertised JSON schemas ([6743644](https://github.com/morluto/rea/commit/674364443dc12b89fe6444fdfb364f1b53086f90))

## [2.5.0](https://github.com/morluto/rea/compare/rea-agents-2.4.0...rea-agents-2.5.0) (2026-07-24)


### Features

* add runtime reconstruction roadmap workflows ([1dbb157](https://github.com/morluto/rea/commit/1dbb15734f484db5f4945bd1d1805d8763bfef0e))
* **analysis:** add bounded memory and call tracing ([8e7709d](https://github.com/morluto/rea/commit/8e7709d35ae0ab49392418106b67c2eaa9ea82dc))
* **artifacts:** add provider-neutral inspection ([d997728](https://github.com/morluto/rea/commit/d9977286f95090b5db3afab78573fa29841f7e90))
* **browser:** capture controlled Playwright scenarios ([1ac3118](https://github.com/morluto/rea/commit/1ac3118aa29d846c266edd1e8cd504c4707cf4df))
* **browser:** compare scenario and storage evidence ([f27dd74](https://github.com/morluto/rea/commit/f27dd745b8e398bba544a97374eed9a45aa4b688))
* **javascript:** compare source with shipped bundles ([697be94](https://github.com/morluto/rea/commit/697be942e8780f3b94aaa6e9fd37432c0bb31b47))
* **javascript:** recover runtime semantic effects ([38c883b](https://github.com/morluto/rea/commit/38c883bbc8a8d059ef21cdd85272e6f31a9ee45c))
* **process:** support explicit stdin closure ([205bf15](https://github.com/morluto/rea/commit/205bf1529bf0679095f817ef2bc82c9e8166a669))
* **reconstruction:** add obligation ledgers ([9d48ca7](https://github.com/morluto/rea/commit/9d48ca788cacabb5bc329e9cc0467784359c5d6d))
* **reconstruction:** evaluate end-to-end readiness ([38ff741](https://github.com/morluto/rea/commit/38ff7418efc3299150f3a8a1eab65e8314ef7aa3))
* **runtime:** add passive V8 Inspector observation ([8271650](https://github.com/morluto/rea/commit/82716509451fff1d0b1f91d8e9479b9c7d94ec20))
* **server:** advertise available tools dynamically ([035e114](https://github.com/morluto/rea/commit/035e1144b0295434c6f3c7295d4b576ef72de396))


### Bug Fixes

* **analysis:** report call-edge truncation ([6039b92](https://github.com/morluto/rea/commit/6039b92be7af50e9f94095b4c6b375293ae38df4))
* **browser:** close scenario containment gaps ([1bd65f6](https://github.com/morluto/rea/commit/1bd65f68bc632345b74a62bffe4394c84415a7f2))
* **browser:** contain scenario pages and preserve inputs ([24b3dc4](https://github.com/morluto/rea/commit/24b3dc41dff1862405d6926aa618a60d06c737b1))
* **browser:** require storage fingerprint approval ([f0069cb](https://github.com/morluto/rea/commit/f0069cbee4551e7988cfc4865ccf03dda48dc0dd))
* **ci:** allow slower real browser startup ([095c75d](https://github.com/morluto/rea/commit/095c75df2349b9da5b8a2222eecd8fec67149f0c))
* **ci:** propagate readiness verifier failures ([9f9f9c3](https://github.com/morluto/rea/commit/9f9f9c39688f9201fbb5dfa2826e576873c2e3d8))
* **ci:** repair cross-platform package verification ([1c9e508](https://github.com/morluto/rea/commit/1c9e50814e3e3a7797c463e00e06afeb6afd0e20))
* **comparison:** preserve uncertainty and v1 inputs ([b9217dc](https://github.com/morluto/rea/commit/b9217dcd746a842f92c0ae0012b35fb8ab9fa310))
* **hopper:** add bounded analysis recovery ([e0bc7fd](https://github.com/morluto/rea/commit/e0bc7fd973b26448fb2192a2059ab1229bec0817))
* **javascript:** keep digestless bundle matches unknown ([5a76aaf](https://github.com/morluto/rea/commit/5a76aaffde3c728f8984e917ff53aa2a628f5941))
* **process:** expose launcher identity mismatch ([62ac73c](https://github.com/morluto/rea/commit/62ac73cdd79bee708d50b17a2dde8c23e0b66f1e))
* **process:** normalize macOS launcher identity ([9c3aec8](https://github.com/morluto/rea/commit/9c3aec81317cd6caf627f13ebb0c6dc0f6735516))
* **process:** tolerate exit during ownership revalidation ([a0f8b72](https://github.com/morluto/rea/commit/a0f8b72b7a4c90184390d5412690d3df20da047d))
* **reconstruction:** authenticate obligation proof boundaries ([7b1e3bd](https://github.com/morluto/rea/commit/7b1e3bda00e4f9737a8882983b8750345eb7e1e2))
* **reconstruction:** bind proof evidence to claims ([83b3368](https://github.com/morluto/rea/commit/83b3368d8debf95df29095ef53a4112ca666bcb2))
* **runtime:** preserve deterministic context identity ([9bd2ac5](https://github.com/morluto/rea/commit/9bd2ac590c00703826283ef11b35a0ba2149bfa1))
* **test:** use direct Node launcher on macOS ([13f3372](https://github.com/morluto/rea/commit/13f3372a8beaa165473bd7ecaccaa2997dcbf2ab))


### Performance Improvements

* **test:** speed up local and CI validation ([1546a8d](https://github.com/morluto/rea/commit/1546a8db029a56ed705e5246a6bf7020227234ce))
* **test:** speed up local and CI validation ([42fbbb2](https://github.com/morluto/rea/commit/42fbbb297b8f40bcfbbfa219a1de098f3d0780ad))


### Code Refactoring

* **application:** reuse graph evidence resolution ([4e8aa98](https://github.com/morluto/rea/commit/4e8aa98267bb837033bf0ced58afc52d24f42492))
* **browser:** centralize scenario metadata budgeting ([e79e367](https://github.com/morluto/rea/commit/e79e36785b51cf8c27a27516280a8f83a9ebd2cc))
* **browser:** clarify inspector capture identifiers ([ca035a7](https://github.com/morluto/rea/commit/ca035a75eb6b7d1a79a928cdde572b9cb1df0d54))
* **browser:** reuse CDP endpoint parsing ([00abf45](https://github.com/morluto/rea/commit/00abf45d2085464fd6090a44f786a53669111177))
* **javascript:** centralize source range comparison ([c9500d3](https://github.com/morluto/rea/commit/c9500d32f69e8076255d4206203a41e39bab8dcb))
* **javascript:** share semantic call-site lookup ([94a2c60](https://github.com/morluto/rea/commit/94a2c6013da122899f3d9aefbe5a0bf608033076))
* **reconstruction:** isolate ledger coverage ([4f62695](https://github.com/morluto/rea/commit/4f62695a5cfc9e627387b0a04c1cebe253debbc8))
* **server:** reuse availability policy type ([eeb4349](https://github.com/morluto/rea/commit/eeb4349f1f130b2bde9b0f89382d36a66553cbf1))


### Documentation

* document roadmap analysis workflows ([f29f683](https://github.com/morluto/rea/commit/f29f6834230fd0d3850c558c28af8a43746533c5))
* refresh generated roadmap metadata ([f904668](https://github.com/morluto/rea/commit/f904668fbcba9a7866c6cde21e9628cfa2afe7aa))


### Tests

* **browser:** use neutral scenario fixture identifiers ([fd25a7e](https://github.com/morluto/rea/commit/fd25a7e15aa2eba0bef01269e5061254b607bfdd))
* **package:** stabilize fake Hopper ownership ([0b70131](https://github.com/morluto/rea/commit/0b7013134c58085b72177f2954e55534be053ebe))


### Continuous Integration

* verify runtime observation and readiness ([9349ff5](https://github.com/morluto/rea/commit/9349ff5921fbd1bc7ac8b8d1d27bef0f36b76d92))

## [2.4.0](https://github.com/morluto/rea/compare/rea-agents-2.3.0...rea-agents-2.4.0) (2026-07-23)


### Features

* **artifacts:** support MSIX and AppX packages ([6e6cce1](https://github.com/morluto/rea/commit/6e6cce1bf3cbd9c48799bee9969c53d66c42162e))
* expand reactive capture and package analysis ([9da1794](https://github.com/morluto/rea/commit/9da179425e83df9f255597437320c1ab6ff5c5c2))
* **process:** add reactive capture scenarios ([69761e9](https://github.com/morluto/rea/commit/69761e95b63ec7617aa161f7a1b4e3c8847a6175))


### Bug Fixes

* **capabilities:** expose typed availability codes ([b906def](https://github.com/morluto/rea/commit/b906defbff28885a1d39f78da7c2b7170a7108c6))

## [2.3.0](https://github.com/morluto/rea/compare/rea-agents-2.2.0...rea-agents-2.3.0) (2026-07-23)


### Features

* complete REA remediation program ([d25e98c](https://github.com/morluto/rea/commit/d25e98c3f9f16e1758ee2a7b5ea44ed6d9534351))
* **evidence:** generate verifier completion ledgers ([c02d33f](https://github.com/morluto/rea/commit/c02d33f381b42028186dcf76e3fb1976a42488bf))
* **evidence:** generate verifier completion ledgers ([f5b3e22](https://github.com/morluto/rea/commit/f5b3e22e720011fa346ee17acaaa927e3379499f))
* **javascript:** add bounded semantic relation graph ([b3939ea](https://github.com/morluto/rea/commit/b3939ea9ffc79a6f0998af76b0f6c9f166d2963b))
* **javascript:** add bounded semantic tracing ([56c1a66](https://github.com/morluto/rea/commit/56c1a669d7edb295ecfce1d348ef7c043ee48390))
* **javascript:** add local semantic call flow ([a26a1c7](https://github.com/morluto/rea/commit/a26a1c73df019e060a5ca50208e71dad1eb55f1e))
* **javascript:** expose bounded semantic tracing ([508a9cc](https://github.com/morluto/rea/commit/508a9ccde9c4beef2fa4dbd39093a1030287e967))
* **process:** add bounded reactive scenario domain ([42f3b9c](https://github.com/morluto/rea/commit/42f3b9c2ec46f48fa680489259fce4841d3ddc0b))
* **process:** add bounded reactive scenario domain ([d34463c](https://github.com/morluto/rea/commit/d34463c27c9b5d71c9e2e3b33cdaef2eab5b99de))
* **process:** add direct replay machine runner ([3df9a07](https://github.com/morluto/rea/commit/3df9a074136faf9c279c9ea936de33f25b6dd447))
* **process:** compare declared concurrent traces ([d81745c](https://github.com/morluto/rea/commit/d81745cb95b1564b94bf260d4f737d03b4625849))
* **process:** coordinate reactive capture effects ([b874efd](https://github.com/morluto/rea/commit/b874efd96824e98ac2120b93368e30a921dcf872))
* **process:** coordinate reactive capture effects ([db9a831](https://github.com/morluto/rea/commit/db9a83190b841c8195da0b3036644831770ba369))
* **process:** record global capture event order ([8bcdb98](https://github.com/morluto/rea/commit/8bcdb986893becd151c4dbb825f69bb6ced8b52e))
* **process:** record provider and verifier run lineage ([02b01d4](https://github.com/morluto/rea/commit/02b01d4193a78a1180e5dd467a4e85838546fcde))
* **process:** record provider and verifier run lineage ([513fa29](https://github.com/morluto/rea/commit/513fa294a49cd5059d4039e1d267e003b0234fad))
* **process:** run finite-state replay during capture ([820af60](https://github.com/morluto/rea/commit/820af60c25cb342d74a06d733b8eac8be814ef6b))
* **process:** run finite-state replay during capture ([34c583a](https://github.com/morluto/rea/commit/34c583a170782b4b28d16a2ec33223922608008d))


### Bug Fixes

* **browser:** redact transitional target titles ([f6095cb](https://github.com/morluto/rea/commit/f6095cb6ba9db4e69e7bcd64643c59c8ac129a4c))
* **cli:** retain bundled skill and bias setup wizard toward apply ([5692b3f](https://github.com/morluto/rea/commit/5692b3f809a6868c7c1e4b6f17ca03ad84557427))
* **cli:** retain bundled skill and bias setup wizard toward apply ([fec5c3c](https://github.com/morluto/rea/commit/fec5c3ce7fc8899bf312a67da2c39e8615781748))
* **cli:** route JavaScript applications from analyze ([737940c](https://github.com/morluto/rea/commit/737940c90c7507a1b0ede3e839598c922ca7a81e))
* **cli:** route JavaScript applications from analyze ([74965d9](https://github.com/morluto/rea/commit/74965d9088cca6e048a62352567b95c63c6621d2))
* **javascript:** preserve candidate trace ambiguity ([8678b57](https://github.com/morluto/rea/commit/8678b57b5e03b0fb103803eb0a9e9ebda3124647))
* **knip:** ignore ps binary and in-file schema exports ([9960982](https://github.com/morluto/rea/commit/99609823ef496245c18c9630dc9ef82fc748ef1a))
* **mcp:** preserve investigation input policy ([5a908a0](https://github.com/morluto/rea/commit/5a908a03a673fe499421283a9309c52164d14a9d))
* **mcp:** preserve investigation input policy ([f4156d9](https://github.com/morluto/rea/commit/f4156d9663a1847d5b3bbe29f98036b9c76606b4))
* **process:** bound trace comparison semantics ([b4df565](https://github.com/morluto/rea/commit/b4df565b779c4f38ebf1c784dad73bf7f3de68eb))
* **process:** normalize resize frame timestamps ([74d1c7b](https://github.com/morluto/rea/commit/74d1c7b2748a88341b98bd463be3ad227501c4f4))
* **process:** normalize resize frame timestamps ([77696df](https://github.com/morluto/rea/commit/77696dff9144fd6c110247711bbff144ec63b19b))
* **process:** preserve nonconforming differences ([f1cc485](https://github.com/morluto/rea/commit/f1cc48558122a922365a1b71dbf4fb196b037825))
* **process:** preserve replay event causality ([d895e49](https://github.com/morluto/rea/commit/d895e49145222eb02eb34cd7de93c5212884f5cc))
* **process:** protect unrelated Hopper during cleanup ([81539c4](https://github.com/morluto/rea/commit/81539c47fb5dbebec83e83526685b0f6b85095aa))
* **process:** protect unrelated Hopper during cleanup ([e4ee4c9](https://github.com/morluto/rea/commit/e4ee4c963547f026defe3f5e5e2978c1ab2e6f21))


### Code Refactoring

* **process:** extract capture journal recorder ([a32b988](https://github.com/morluto/rea/commit/a32b988a35a31d0fbabaa861eddb6e3bbb363943))
* **process:** split trace comparison domain logic ([75d5a87](https://github.com/morluto/rea/commit/75d5a8705498bf567a9860eef9eecdf4521c9cc6))
* **process:** split trace comparison helpers ([6d8ecd2](https://github.com/morluto/rea/commit/6d8ecd2b88ddd4868ee55bef84bf88a542d4616b))


### Documentation

* **cli:** clarify setup consent comment ([e869137](https://github.com/morluto/rea/commit/e8691378a07b083277e3b963c5f6d179e12d7626))
* refresh Node 24 TypeDoc output ([846193c](https://github.com/morluto/rea/commit/846193c60305242b27f39c69715f332627ba1725))


### Tests

* **browser:** stabilize real shape capture ([bb2e243](https://github.com/morluto/rea/commit/bb2e2432a5ff4634b4f54eff7834b6da826f725f))


### Continuous Integration

* remove redundant typecheck, lint, and format compatibility jobs ([eb27f01](https://github.com/morluto/rea/commit/eb27f01aeef0f531eebeb0342eba6cc507dfa6f4))
* remove redundant typecheck, lint, and format compatibility jobs ([aeb5cb3](https://github.com/morluto/rea/commit/aeb5cb3adb0e43c45017cf61d2a95bac200024ae))
* shard coverage tests and skip docs-only suites ([c736317](https://github.com/morluto/rea/commit/c7363178e7c8c1f8db1e69085bcd0826293e3814))
* shard coverage tests and skip docs-only suites ([fa58082](https://github.com/morluto/rea/commit/fa58082bf0268b9f9f6c7aac2d6871576e7d5fae))

## [2.2.0](https://github.com/morluto/rea/compare/rea-agents-2.1.0...rea-agents-2.2.0) (2026-07-20)


### Features

* **artifacts:** project mobile application inventories ([c6a1a93](https://github.com/morluto/rea/commit/c6a1a93a9aff1efa06a39aae9911f6c704c350f5))
* **artifacts:** project mobile application inventories ([d36b385](https://github.com/morluto/rea/commit/d36b38537821dd2d74d99a9e49eccd569cfaf341))
* **process:** add bounded replay state machines ([fea965b](https://github.com/morluto/rea/commit/fea965b1b82a858fe423df2ef8fb004524f1934e))
* **process:** add bounded replay state machines ([dc0c2e5](https://github.com/morluto/rea/commit/dc0c2e5ac31387138ec47b027bac6a4cbf007ba0))
* **process:** compare repeatable paired experiments ([e9899c0](https://github.com/morluto/rea/commit/e9899c003b72c2799c67d74bd9553c9a03d083dd))
* **process:** compare repeatable paired experiments ([9ab7aa3](https://github.com/morluto/rea/commit/9ab7aa320c2f234e86d16ff8535b11768a0e080e))
* streamline agent integration and MCP routing ([02cb20b](https://github.com/morluto/rea/commit/02cb20b54682bc334077d8e247841e179a26abd7))
* streamline agent integration and MCP routing ([3e3d458](https://github.com/morluto/rea/commit/3e3d45856ede849371027b62ad1a7b0687798951))


### Bug Fixes

* align session filters and Hopper verification ([d7d6bdf](https://github.com/morluto/rea/commit/d7d6bdf474a1672a9b33888044a38672d28ab0ee))
* **artifacts:** align projection provider targets ([560dbda](https://github.com/morluto/rea/commit/560dbda76d9a07ea9291c00bec8a383456ad0e03))
* **artifacts:** bound mobile projection candidates ([0cc9d46](https://github.com/morluto/rea/commit/0cc9d468c4d6f3036b5888d12173157b487371c3))
* **ci:** keep tool kind type internal ([b9bead2](https://github.com/morluto/rea/commit/b9bead2809eca4448ac28f3e2465f8021a109983))
* **ci:** retry published package verification ([0810486](https://github.com/morluto/rea/commit/0810486f636a99b492f26758f6cd0fa65935f5aa))
* **ci:** retry published package verification ([c379455](https://github.com/morluto/rea/commit/c379455da7b32069c861addfbf8d19bb432ddb84))


### Documentation

* refresh generated API links ([a2089a4](https://github.com/morluto/rea/commit/a2089a40671b3edae7db98ce37587da87f093d1b))
* update application projection API ([b0cb28a](https://github.com/morluto/rea/commit/b0cb28a9bf04f849e792346306bb42ed4fac6b29))
* update paired process experiment API ([a222327](https://github.com/morluto/rea/commit/a222327f304555104b51370d0955dc6c8ca4d0ce))
* update replay machine API ([d74f897](https://github.com/morluto/rea/commit/d74f89754fe4e5c19a757893a3fe388f2c64372f))


### Tests

* budget CLI output variant subprocesses ([8d3587b](https://github.com/morluto/rea/commit/8d3587bbcac18e90652cc95e5853158a4f9aef18))
* cap workers across all hosts ([bc80359](https://github.com/morluto/rea/commit/bc8035918b1d6a3eac7fc2307867d4dc2787d3b5))
* inherit root options in Vitest projects ([168100e](https://github.com/morluto/rea/commit/168100e5326958fc89431a26a1f3cca762516133))
* isolate slow filesystem and CLI suites ([c2e134b](https://github.com/morluto/rea/commit/c2e134b8e46d780b61faab1021772704380e6a37))
* stabilize subprocess-heavy integration suites ([a556e94](https://github.com/morluto/rea/commit/a556e945096fd9430fc48217a2f4b6dc3d06518c))

## [2.1.0](https://github.com/morluto/rea/compare/rea-agents-2.0.0...rea-agents-2.1.0) (2026-07-18)


### Features

* add managed characterization and coverage closure ([1943496](https://github.com/morluto/rea/commit/194349683a19ee8b35c1bd9b124d032e83e6867a))
* add managed characterization and reconstruction coverage ([02c913b](https://github.com/morluto/rea/commit/02c913bcdab5904e1b6ce8a24940b75ddc20c826))
* **cli:** add explicit package-runner setup wizard ([891a11f](https://github.com/morluto/rea/commit/891a11f315d02628bbf04f290d211e48d1916a1d))
* **cli:** improve setup onboarding ([4851449](https://github.com/morluto/rea/commit/4851449f715af122d02e5517b4f6b925962f2a01))
* **cli:** improve setup onboarding ([16002ff](https://github.com/morluto/rea/commit/16002ff3c216ecd91e9c28bab8de288f3b553e57))
* **cli:** support package-name setup wizard ([1b90e7f](https://github.com/morluto/rea/commit/1b90e7f992276e4e05644823583f77c27ccac702))
* **doctor:** admit the Windows x64 Ghidra boundary ([32dda0c](https://github.com/morluto/rea/commit/32dda0c19eee5ddf91a35d9e21374f9cb111b07d))
* **dotnet:** add BYO ILSpy oracle diagnostics ([aa200ce](https://github.com/morluto/rea/commit/aa200ce8ca5690113a39259e91ab1ae9edc0b436))
* **ghidra:** add authenticated Windows loopback transport ([629ffc3](https://github.com/morluto/rea/commit/629ffc3872cdf2f3dabbe053890ac6a4103fdd1c))
* **ghidra:** bind imports to admitted target bytes ([be19c3f](https://github.com/morluto/rea/commit/be19c3fd12da55df84d92c5ec2641fe739df0438))
* **ghidra:** define the Windows P0 admission boundary ([6b1fd16](https://github.com/morluto/rea/commit/6b1fd166b0a6d37af9d42c38c5fd587fe3989659))
* **ghidra:** inspect Windows headless installations ([86e44be](https://github.com/morluto/rea/commit/86e44bef08d36cc1b56e44b7b544d5d6d21d141d))
* **ghidra:** launch bounded Windows headless sessions ([bc0fb45](https://github.com/morluto/rea/commit/bc0fb45f16db97d3f79860d850c9f2fe0f6b7b22))
* harden authority and runtime conformance boundaries ([b537ebf](https://github.com/morluto/rea/commit/b537ebfa3460f782c2aee4996ced2e726f7d6328))
* **javascript:** add binding and constant-value semantic IR ([3ea8523](https://github.com/morluto/rea/commit/3ea852323aa9a0509691105d47f5e5622c24050b))
* **javascript:** add binding and constant-value semantic IR ([3d71bb5](https://github.com/morluto/rea/commit/3d71bb551e3353df23afa5832883e5074fe0f2d0))
* **javascript:** add webpack and rspack runtime adapters ([7bccb7c](https://github.com/morluto/rea/commit/7bccb7c6ae2f48a37e053cfd871309971e81bbc4))
* **javascript:** add webpack and rspack runtime adapters ([44c7017](https://github.com/morluto/rea/commit/44c70176b845e2900244151aaadb7a4dc3f8b302))
* **javascript:** recover commonjs and esm module relationships ([9766fc0](https://github.com/morluto/rea/commit/9766fc04c13a366fa449f60cccabb1c97d68e84d))
* **javascript:** recover commonjs and esm module relationships ([6c41791](https://github.com/morluto/rea/commit/6c41791519069811d0be0115c450801432f96660))
* **permissions:** add scoped process capture elicitation ([e6cfce3](https://github.com/morluto/rea/commit/e6cfce3902a8f0c403caa07e2c597e8156aa5498))
* **skill:** rename skill to reverse-engineer-anything ([9356634](https://github.com/morluto/rea/commit/9356634ccba8d913a376798dae47bb3c4a86c07a))
* **target:** classify Windows PE admission metadata ([24274fe](https://github.com/morluto/rea/commit/24274fe6b694c5bf08ae21fd7f4afa1846f67ef2))
* **windows:** define native authority boundary ([a1a6b42](https://github.com/morluto/rea/commit/a1a6b4200ed638b1ea4d186ae1253805032d002a))


### Bug Fixes

* **build:** preserve native generated-file line endings ([00a3078](https://github.com/morluto/rea/commit/00a3078148e90a2d45648891f96158378c2561ce))
* **ci:** remove retired native rebuild steps ([2d22731](https://github.com/morluto/rea/commit/2d22731ebb3f81483ec8a561ed8b1cb313b4eac1))
* **ci:** validate packaged Windows CLI commands exactly ([43418ee](https://github.com/morluto/rea/commit/43418ee9112358d81d56d78b5cbe1ca37f6099be))
* **cli:** require explicit setup selections ([992ec50](https://github.com/morluto/rea/commit/992ec505b279114dcb13230fcd008db8668578af))
* **contracts:** make agent-facing schemas self-describing ([0df11dd](https://github.com/morluto/rea/commit/0df11dd4d1de4cb1c4fab6562d874e3be285aeec))
* **dotnet:** admit real CLI GUID and fat CIL bodies ([735973b](https://github.com/morluto/rea/commit/735973b08b364d45a8e2a551e17ad96c31b039c9))
* **dotnet:** correct CLI pointer and byref signatures ([1387be0](https://github.com/morluto/rea/commit/1387be08dd398ca8ef92410307fe35faa8936ed5))
* **dotnet:** correct CLI pointer and byref signatures ([fb9ff56](https://github.com/morluto/rea/commit/fb9ff5659dffb6af5185c9465ddac6e86eca7dd2))
* **dotnet:** downgrade truncated CIL identity and coverage ([736a4e1](https://github.com/morluto/rea/commit/736a4e1480fb34df12b00372c697acc327b0046c))
* **dotnet:** downgrade truncated CIL identity and coverage ([dae6807](https://github.com/morluto/rea/commit/dae6807c4a4aad7a20c4b9da085e39dcfb58430a))
* **electron:** keep missing unpacked ASAR entries unavailable ([fb6964a](https://github.com/morluto/rea/commit/fb6964a74ea60751560a6d10366bfdad3dab4535))
* **electron:** resolve package and dirname entrypoints by context ([4847fc4](https://github.com/morluto/rea/commit/4847fc4fc14114cbb15350a23f6db4a2ad7962fe))
* **electron:** resolve package and dirname entrypoints by context ([1ac9a09](https://github.com/morluto/rea/commit/1ac9a09ce1574b202d98177392628ba468a568df))
* **ghidra:** preserve native endpoint diagnostics ([5970a71](https://github.com/morluto/rea/commit/5970a7182481656e30a8ad51e4855d4c8e50eed7))
* **ghidra:** preserve Windows batch invocation semantics ([0ac418d](https://github.com/morluto/rea/commit/0ac418dd8be62357f852767a64f0d5b5c78495cc))
* **ghidra:** validate Windows control characters explicitly ([4dccbec](https://github.com/morluto/rea/commit/4dccbecf064b56b0d33c7d8c926772353667c739))
* **managed:** emit valid x64 conformance PE ([dcd94f1](https://github.com/morluto/rea/commit/dcd94f1472cbdfd5fff90eb26bbac68f5fb2b06b))
* **managed:** emit valid x64 conformance PE ([c52a822](https://github.com/morluto/rea/commit/c52a8223c62ab85373eb86a68dbdc626648aa40f))
* **managed:** preserve page incompleteness in graph and comparison ([a6f02a0](https://github.com/morluto/rea/commit/a6f02a05a48254e46a6485cedfadda426ab60e21))
* **managed:** preserve page incompleteness in graph and comparison ([8ee0f04](https://github.com/morluto/rea/commit/8ee0f04562814e44f77fd8a0f19184c127bcf92e))
* **mcp:** clarify advertised schema fields ([1581e40](https://github.com/morluto/rea/commit/1581e40fce733c19e11b460b47722e4121e9fd0e))
* **npm:** use latest entry points without install scripts ([34252f5](https://github.com/morluto/rea/commit/34252f55e963fcd63c0fd127dc249ba2c8398082))
* **npm:** use latest entry points, remove install scripts, and rename skill ([bf85ee6](https://github.com/morluto/rea/commit/bf85ee62c976dd06fdc47429a9b3c7f3d99b7f3b))
* preserve optional unknown filters ([db1efef](https://github.com/morluto/rea/commit/db1efef9d285d1726f56c288593161434b9f322f))
* remove unused boundary exports ([49f1ec1](https://github.com/morluto/rea/commit/49f1ec14fe4f5b67345ff9dde8af8ef1066fb3c8))
* satisfy dead-code and generated-doc checks ([b15a9ec](https://github.com/morluto/rea/commit/b15a9ecfef55dec00b92babf92883f6dedaa2209))
* **setup:** preserve onboarding after refactor ([da48033](https://github.com/morluto/rea/commit/da48033c191f491f47b9933f65806f0f0a223643))
* **skill:** disclose retired skill cleanup ([4c69e61](https://github.com/morluto/rea/commit/4c69e6120a2c0a630272e845cda2112724c4be7b))


### Code Refactoring

* **adapters:** split oversized provider workflows ([1a99a60](https://github.com/morluto/rea/commit/1a99a60a29c231c7a104c5900c2c20a7d10268d5))
* **app:** split session and CLI workflows ([c6ee004](https://github.com/morluto/rea/commit/c6ee0049c4bffe2880ddb8cf5a2a6c4195ae18f6))
* **domain:** split analysis boundaries ([e2c868c](https://github.com/morluto/rea/commit/e2c868c4bdd4f83f1e33a50bca0e3d91d4605387))
* finish lint cleanup ([2bea405](https://github.com/morluto/rea/commit/2bea40571d47f8b3454cdb9b467839521d3174b4))
* **managed:** split metadata analysis ([20c88dd](https://github.com/morluto/rea/commit/20c88dd5676a3081e13bef26cfa38d8a69856842))
* **setup:** keep planner helpers private ([2d1f961](https://github.com/morluto/rea/commit/2d1f9616b76b9e383d0196b820a377573def836d))
* simplify authorization boundaries ([2e5b443](https://github.com/morluto/rea/commit/2e5b44365fd1ea3c515efd03b56fee0083a20a31))
* simplify doctor and error projections ([37f4ac6](https://github.com/morluto/rea/commit/37f4ac6d7073693fb4d2290b5aff6bcb6b36cd19))
* **skill:** keep only the canonical skill identity ([a7c1e87](https://github.com/morluto/rea/commit/a7c1e87365cec0333bc9431ec5d7418cb7a54be1))
* **skill:** remove legacy skill compatibility ([8cf0dd2](https://github.com/morluto/rea/commit/8cf0dd2bf645d18afe6a9c8493178bdd905c0647))
* split oversized analysis workflows ([af2399e](https://github.com/morluto/rea/commit/af2399eeacbca5f1af344c7d7ef747f3d976bcf7))
* split oversized analysis workflows ([3e61a63](https://github.com/morluto/rea/commit/3e61a63a104859e1c8ca3bcdc6bad0511d1f1735))
* **windows:** keep capability outcomes module-private ([585f523](https://github.com/morluto/rea/commit/585f52389107c79cea99ecd26ea87cbcda08d245))


### Documentation

* **cli:** describe every command input ([d4be3e7](https://github.com/morluto/rea/commit/d4be3e7f9a609050303c82aa83d4884bb6daae77))
* **ghidra:** define the experimental Windows P0 ([8b5ae41](https://github.com/morluto/rea/commit/8b5ae417f3a69e679ad69574f13d1d179ebb22c3))
* **managed:** align normalized CIL claims with shipped v1 semantics ([9a92a79](https://github.com/morluto/rea/commit/9a92a7958cceedafe184b48ca93ab094386401a7))
* **managed:** align normalized CIL claims with shipped v1 semantics ([3f788e9](https://github.com/morluto/rea/commit/3f788e9065d5ce457ba174c13bc8e4e0b74d5156))
* normalize inherited source paths ([d33213a](https://github.com/morluto/rea/commit/d33213a99c824b5834323c924dac6b7852df5831))
* preserve generated source links ([2ea375f](https://github.com/morluto/rea/commit/2ea375f8ea413aba05baab0d9af3e3401d8b2956))
* prioritize agent usability in tool design ([ad17fe7](https://github.com/morluto/rea/commit/ad17fe7aa71f5cbffcdff3e27b08bc4538e73c7d))
* refresh Electron path resolution API ([734a4ef](https://github.com/morluto/rea/commit/734a4ef04fce7bbff76b3fbf9c3f1250d7ab8963))
* refresh generated API reference ([f5f653b](https://github.com/morluto/rea/commit/f5f653bd8dba8d441efe13f2404b8677dc6dd8f3))
* regenerate managed coverage API with Node 24 ([e47c00e](https://github.com/morluto/rea/commit/e47c00ef04b537bd67caff69d27f48a81bdf04e3))


### Tests

* add limit monotonicity and partial-evidence regressions ([2cce98c](https://github.com/morluto/rea/commit/2cce98cca29ab8752c34281c4b439a0150308b2c))
* add limit monotonicity and partial-evidence regressions ([4afd970](https://github.com/morluto/rea/commit/4afd97029c3eebc0c755b0c9dee2fd74217a1305))
* **ci:** guard Windows Ghidra workflow isolation ([81ed68f](https://github.com/morluto/rea/commit/81ed68f67d8332b3013131dc6d86a001d1dc55a3))
* **ci:** guard Windows Ghidra workflow isolation ([98540c8](https://github.com/morluto/rea/commit/98540c8a12722aaa005102518746916018107ccb))
* **cli:** cover package-name binary alias ([40e2f94](https://github.com/morluto/rea/commit/40e2f943a52cbf957db2ae898c3624e5ac5faec6))
* **hopper:** add semantic runtime conformance ([da1da3b](https://github.com/morluto/rea/commit/da1da3bfb83e2fdd2a7a0a84a6a70aa73a4a68d6))
* **package:** align setup preflight contract ([b33ebb1](https://github.com/morluto/rea/commit/b33ebb1627423a09fa56b628284362118e68ca40))


### Continuous Integration

* **ghidra:** add Windows P0 acceptance and real-engine lanes ([0b35510](https://github.com/morluto/rea/commit/0b3551076d591be04efbb829d3eb1d17bcc828a9))

## [2.0.0](https://github.com/morluto/rea/compare/rea-agents-1.7.0...rea-agents-2.0.0) (2026-07-16)


### ⚠ BREAKING CHANGES

* **mcp:** require Evidence for managed reconstruction
* **mcp:** comparison tools now require session-owned Evidence IDs or approved bundle paths, and structured Evidence results use compact references.

### Features

* **application:** add cross-layer graph workflows ([778b995](https://github.com/morluto/rea/commit/778b995bbfd4b4bb28ace9bf0f7428e50cd1be50))
* **application:** add isolated JavaScript replay ([d86231a](https://github.com/morluto/rea/commit/d86231ad33e750c2a6ef60a33d833ac8db9219be))
* **dotnet:** add managed artifact triage ([c251c38](https://github.com/morluto/rea/commit/c251c38aa2ead24e4aaeb95678a10dddaa212dc4))
* **dotnet:** add managed member comparison ([55794d6](https://github.com/morluto/rea/commit/55794d6083d6746fa2c7ad08a5f548c05272b1ae))
* **dotnet:** add managed member inspection ([98cad37](https://github.com/morluto/rea/commit/98cad3788d05ae31d86bb448d6fa8e5ebb1c742c))
* **dotnet:** add managed native boundary inspection ([466b1bb](https://github.com/morluto/rea/commit/466b1bbebee8c9266708de885b5e5405d23d0b7c))
* **dotnet:** add managed runtime correlation planning ([5f66cfd](https://github.com/morluto/rea/commit/5f66cfd57aeec39bb3337cbbbc2b7c3c8460df54))
* **dotnet:** import managed reconstructions ([c506664](https://github.com/morluto/rea/commit/c5066647445f3a8be0a9df4ff0f41b7e478f79b5))
* **dotnet:** verify managed native boundaries ([8cbc125](https://github.com/morluto/rea/commit/8cbc125b9393f3cc84a8a1b4e1cb160714c833ad))
* **electron:** map static process and IPC boundaries ([3fa2304](https://github.com/morluto/rea/commit/3fa2304bc70beb96cf30feb51bb6d7ac4fb7a2b0))
* **electron:** reconcile static artifacts with passive runtime ([8c67dbd](https://github.com/morluto/rea/commit/8c67dbd49e74b2f304a03845a8a55e6a433cc915))
* **managed:** project static evidence into application graph ([6194c1a](https://github.com/morluto/rea/commit/6194c1a781a97043dbd02f0f6717c17598459abe))
* **managed:** project static evidence into application graph ([77178bb](https://github.com/morluto/rea/commit/77178bba543ed40b5cb29d301ad930e698a1968c))
* **mcp:** harden contracts and evidence references ([ee1cd40](https://github.com/morluto/rea/commit/ee1cd40405405097b9d5f9686cbcc765ab03d96a))
* **mcp:** require Evidence for managed reconstruction ([d36af5d](https://github.com/morluto/rea/commit/d36af5d0f708637f514f356521242b2b1066c8ed))
* **setup:** verify installed skill catalog identity ([b2d1f2a](https://github.com/morluto/rea/commit/b2d1f2affdc7faa0e1c56feefe596eb39dea0612))


### Bug Fixes

* **deps:** run freshness check from escaped paths ([8a1c128](https://github.com/morluto/rea/commit/8a1c128b67ee41ce054fe984946a5d7bfcc1a3b4))
* **mcp:** align runtime unknown argument validation ([d1e7220](https://github.com/morluto/rea/commit/d1e72207f48609e3214a66c2a248c70a2a1abd6c))
* **mcp:** hide managed workflows without a session ([412bbaf](https://github.com/morluto/rea/commit/412bbaf05e0d6fa5add68303c83325628cc2e7da))
* **mcp:** integrate managed contracts after rebase ([9c4a93d](https://github.com/morluto/rea/commit/9c4a93d9b1be36155bd9c0a39d8b541ec3986c64))
* **mcp:** normalize inferred field descriptions ([a807471](https://github.com/morluto/rea/commit/a807471e4e612e215ef82ebd2d16a1c454d5ad31))
* **mcp:** parse adapter inputs exactly once ([37c0f39](https://github.com/morluto/rea/commit/37c0f399544c9424c55e468d6784da61426a458e))
* **mcp:** remove arbitrary schema byte gate ([fd08025](https://github.com/morluto/rea/commit/fd08025dcd21cc31fa1e7356c90e76b4863b1af2))
* **mcp:** remove schema byte compaction ([f728295](https://github.com/morluto/rea/commit/f728295bd00585623b9597cf5702051aefa8ddc9))
* **package:** accept expected doctor diagnostics ([0f2d013](https://github.com/morluto/rea/commit/0f2d01300a4bc9fc534114a6913ec8dfcd5fa457))
* **test:** make host fixtures portable ([f23f529](https://github.com/morluto/rea/commit/f23f52903cb6df4eed6fec0e09f79c82ad9825dc))


### Code Refactoring

* **mcp:** remove obsolete managed evidence parser ([f7aa191](https://github.com/morluto/rea/commit/f7aa19154d9bc24b3ccdb8bde40ee926f06049a1))


### Documentation

* **analysis:** define managed-code evidence boundary ([80faff3](https://github.com/morluto/rea/commit/80faff3e5bf8baa65b0b18e03594e86753a76ac6))
* **api:** refresh managed reconstruction contracts ([2b06433](https://github.com/morluto/rea/commit/2b064335ea63db4484d16b35544dd5e8024ecf6d))
* **dotnet:** refresh managed reconstruction api ([cc1e47c](https://github.com/morluto/rea/commit/cc1e47c615bbbb6d2f7dc24ec1710c39e4b96bf4))
* refresh application workflow API links ([4a30820](https://github.com/morluto/rea/commit/4a30820a93a33f4ebb7b69202890c5c6a114ba0f))
* refresh managed native verification api ([849c052](https://github.com/morluto/rea/commit/849c05290aced212505c2621f208e89266c3ea96))
* refresh managed runtime api docs ([798631a](https://github.com/morluto/rea/commit/798631ade628464b6b233d240e53b7eea44721a0))
* refresh runtime reconciliation API ([87b2348](https://github.com/morluto/rea/commit/87b23482e28ed4e43674c4b9a775da4b16cb4636))
* **security:** define controlled replay authority ([461990d](https://github.com/morluto/rea/commit/461990da3f8e4ec573217432943f04311d577524))
* stabilize replay API source links ([a8c1057](https://github.com/morluto/rea/commit/a8c1057279d529d9f16ab9b093b0f6518915b6fa))


### Tests

* **dotnet:** add managed conformance verifier ([2b75fcf](https://github.com/morluto/rea/commit/2b75fcfaac8432b08b2d88cd95492333df2674d4))
* **dotnet:** verify managed app graph manifests ([5be4051](https://github.com/morluto/rea/commit/5be405169ef752e34199022e97c5fa4896693472))
* **dotnet:** verify managed app graph manifests ([a5e5c68](https://github.com/morluto/rea/commit/a5e5c68d117cdef33a47291ed4f641c9a89045f3))
* **dotnet:** verify managed app manifests ([793a948](https://github.com/morluto/rea/commit/793a948c1b6a61ce3ba2860fe977b19180c6fa9b))
* **hopper:** avoid scheduler-sensitive exit timing ([6e6827c](https://github.com/morluto/rea/commit/6e6827cd76fc080a959695ab19bfcc34b80c270c))
* **mcp:** cover strict compact wire contracts ([8de25d0](https://github.com/morluto/rea/commit/8de25d02302e7a03c1a0c6ab19ccb459758973ca))
* **mcp:** derive sessionless managed inventory ([cab7c4a](https://github.com/morluto/rea/commit/cab7c4a5212eb5bf2b233c835ac57b5764a4e0f3))
* **replay:** use portable seam executables ([3183f47](https://github.com/morluto/rea/commit/3183f47c0f785bdda52f9db6613932440094c522))

## [1.7.0](https://github.com/morluto/rea/compare/rea-agents-1.6.0...rea-agents-1.7.0) (2026-07-15)


### Features

* **artifact:** reconstruct JavaScript application structure ([aa46abf](https://github.com/morluto/rea/commit/aa46abfe1b59ecab160029c88b0c925ff68d6033))
* **domain:** add versioned JavaScript Application Graph ([2ca5672](https://github.com/morluto/rea/commit/2ca56724e4be7429372904ad26fe97fa5943bcf4))
* **ghidra:** add function analysis and conformance ([d8321de](https://github.com/morluto/rea/commit/d8321defd77c57df424b2635a4a70d38fe9a1fae))
* **ghidra:** add private headless provider session ([f0e625d](https://github.com/morluto/rea/commit/f0e625d7ee5a3f79158514aa93f89fca81a2da6a))
* **ghidra:** implement read-only inventory operations ([b1c07dd](https://github.com/morluto/rea/commit/b1c07dd9c6fe8c4dd109fefe67f4b16fdd1115d1))
* **session:** add explicit provider registry and target binding ([941d710](https://github.com/morluto/rea/commit/941d7101dd3c8b7cdd790724c55ff00a90f42270))


### Bug Fixes

* address setup, upgrade, and process test regressions ([960d759](https://github.com/morluto/rea/commit/960d759cc1979a32ae416c50e6095abfd629fbe7))
* address setup, upgrade, and process test regressions ([02f12b9](https://github.com/morluto/rea/commit/02f12b927a17615150d6e1126d1b841c5dca648b))
* **cli:** make clean source checkouts start reliably ([ed17e76](https://github.com/morluto/rea/commit/ed17e764733c819a1123372ad64d4122ba0c06e3))
* **cli:** make clean source checkouts start reliably ([6ba9765](https://github.com/morluto/rea/commit/6ba97656ca73e97ae1dbecc15a86a193978298b6))
* **setup:** replace managed Hopper on reinstall ([0ca93f9](https://github.com/morluto/rea/commit/0ca93f9779bc6c576479561c488982963fbb9167))


### Code Refactoring

* **domain:** remove provider-specific target and snapshot state ([21da71e](https://github.com/morluto/rea/commit/21da71ec6d30a63e497b871d16a69ab02f5b210b))
* **process:** extract reusable provider lifecycle primitives ([70e1a0f](https://github.com/morluto/rea/commit/70e1a0f5326fa1598e4f4e673a4ba1545cef5b65))


### Documentation

* **api:** refresh profile source anchors ([bd3cf96](https://github.com/morluto/rea/commit/bd3cf964d62bea2571559cfde6bdfe686922255f))
* **api:** refresh provider source anchors ([a7621c2](https://github.com/morluto/rea/commit/a7621c263392a92c63162febf511824c9c788548))
* **architecture:** define provider selection and analysis profiles ([75f8696](https://github.com/morluto/rea/commit/75f8696a57cf25a2a72a2a337d8076214f04ece4))
* **architecture:** define provider selection and analysis profiles ([f9f2fbe](https://github.com/morluto/rea/commit/f9f2fbe2fc04bd202d9fd580fc54c30529809fc0))
* reconcile product documentation with shipped behavior ([addc208](https://github.com/morluto/rea/commit/addc208f12790e3b0e48697c75e978e08814d303))
* reconcile product documentation with shipped behavior ([54056a9](https://github.com/morluto/rea/commit/54056a9782f3f51f8f1b510d8b9c1bf4c3c9f067))
* refresh Ghidra inventory API links ([a45de27](https://github.com/morluto/rea/commit/a45de27d9e97b8c7a76b3e6da12b0b4efdfa5dcb))
* regenerate JavaScript graph API with Node 24 ([da4817a](https://github.com/morluto/rea/commit/da4817abd10fe2d6b68bf4d393d067ce42ece910))


### Tests

* keep package setup verification read-only ([acaf030](https://github.com/morluto/rea/commit/acaf03056d6b457d85c6b7744565d6c7d56c424c))

## [1.6.0](https://github.com/morluto/rea/compare/rea-agents-1.5.0...rea-agents-1.6.0) (2026-07-14)


### Features

* add web and Electron reverse-engineering workflows ([be76f80](https://github.com/morluto/rea/commit/be76f8090b5195680cdf73a8c21f65e6516efc92))


### Bug Fixes

* **application:** add explicit investigation replay ([7112e1e](https://github.com/morluto/rea/commit/7112e1e6bf33bccd605bf3ee5541b83a522831e5))
* **application:** add explicit investigation replay ([a6b5ca4](https://github.com/morluto/rea/commit/a6b5ca4135ac2cf168470b47e97a05d8b67f3147))
* **browser:** keep page endpoint type internal ([3743962](https://github.com/morluto/rea/commit/37439620710d4c47bf48f1df0b099eab0c115446))
* **browser:** observe direct target disconnects ([9be24f8](https://github.com/morluto/rea/commit/9be24f8de14edc04cdd3649e0ea66d53edb72328))
* **browser:** preserve operation-aware cancellation errors ([0aac8aa](https://github.com/morluto/rea/commit/0aac8aaba5a5097d99277d7501dae6fdd017f2d0))
* **browser:** support page-scoped CDP transports ([c4930f4](https://github.com/morluto/rea/commit/c4930f4820dbf114da6fa850500f1415d0d6b7a9))
* **browser:** support page-scoped CDP transports ([bf96192](https://github.com/morluto/rea/commit/bf9619267b45f2383ebdd648dea05a7d2e3945a6))
* **browser:** support relative source map URLs ([5231e95](https://github.com/morluto/rea/commit/5231e95c19d309113a4335fe44a5793e3924219a))
* **cli:** confirm project grant revocation ([6397e54](https://github.com/morluto/rea/commit/6397e54169a55b4fcab7ad92f42bbd8f8c616810))
* **cli:** confirm project grant revocation ([7a4cfb4](https://github.com/morluto/rea/commit/7a4cfb4fbd96df34f5502adbf70f5bfb12bbc56c))
* **cli:** restrict production MCP dispatch ([8bd0e5f](https://github.com/morluto/rea/commit/8bd0e5f1ea7f36b23f83113ef285c31a36ff315c))
* **cli:** restrict production MCP dispatch ([190e5d3](https://github.com/morluto/rea/commit/190e5d3282f0f1bc980ad488a7774a500ae3e87d))
* **doctor:** honor explicit Hopper launcher ([c69fe2c](https://github.com/morluto/rea/commit/c69fe2c897b8f567e1607424690e9d59aaefadf1))
* **doctor:** honor explicit Hopper launcher ([9208592](https://github.com/morluto/rea/commit/9208592f41ed920c32206c78fcf43c8d7db77f22))
* **evidence:** enforce the combined record limit ([c791802](https://github.com/morluto/rea/commit/c7918024bc89995f4054bd499fef88a34a3e24d7))
* **evidence:** enforce the combined record limit ([834c70c](https://github.com/morluto/rea/commit/834c70cf4b9c8dca000c7a20491215d1acc0db89))
* **hopper:** cancel startup before closing ([f471a63](https://github.com/morluto/rea/commit/f471a63c87679eff9564553741d9967724c57f0a))
* **hopper:** cancel startup before closing ([6cc2fdf](https://github.com/morluto/rea/commit/6cc2fdf80ce2d0220fe996ddbed2f0378f5397cd))
* **hopper:** select verified Linux demo mode explicitly ([46e4052](https://github.com/morluto/rea/commit/46e40520285c2338bd1ffedd16599977c333befb))
* **hopper:** select verified Linux demo mode explicitly ([04c5fd6](https://github.com/morluto/rea/commit/04c5fd63b72e6e497363ecbde5e24088eef639cd))
* **native:** harden command capture edge cases ([c2e64a4](https://github.com/morluto/rea/commit/c2e64a42c84bd245f3df4eb8b61039c8594704f8))
* **native:** harden command capture edge cases ([d39f98d](https://github.com/morluto/rea/commit/d39f98d06dd53cdfd427e75e2f45f2c8b8792f50))
* preserve setup diagnostics and clean Knip config ([2d1e021](https://github.com/morluto/rea/commit/2d1e021782dc903faaa401207dad47278bfb57b2))
* preserve setup diagnostics and clean Knip config ([5a7ccef](https://github.com/morluto/rea/commit/5a7ccefc68e3d7359bfd9a6262701641da380d37))
* **process:** gate sampling on initialized PTY root ([57938a8](https://github.com/morluto/rea/commit/57938a8465add2d6e89dae13e66059bad7f72a45))
* **process:** gate sampling on initialized PTY roots ([e831a41](https://github.com/morluto/rea/commit/e831a41375148336d72beadd5d13405047c82e67))
* **process:** keep validation detail internal ([614a119](https://github.com/morluto/rea/commit/614a1197f5b699b61c46d82a24e0564bf0d87829))
* **process:** restrict cleanup to captured group leaders ([40c6f60](https://github.com/morluto/rea/commit/40c6f60ac9a4b86f4cbe28a72e7692e1acf761b1))
* **process:** settle exited zombie groups ([072ce5a](https://github.com/morluto/rea/commit/072ce5aede03a2dab59ce8776a04063218448925))
* **process:** settle exited zombie groups ([4828326](https://github.com/morluto/rea/commit/482832607910a6e872bccc27c956eeaf55dd6056))
* **process:** stabilize and speed up the test suite ([a3b7de9](https://github.com/morluto/rea/commit/a3b7de9fa5e89808a3c01a5623779709edb7c691))
* **reference:** preserve distinct parse failures ([e02cb2f](https://github.com/morluto/rea/commit/e02cb2f877e8fd9874245ee6e15f68666afaeb46))
* **reference:** preserve distinct parse failures ([543510f](https://github.com/morluto/rea/commit/543510f62fd257b42e6a7dfc876112dda0e0ea01))
* rollup batch of fixes ([b348b2c](https://github.com/morluto/rea/commit/b348b2c98772b3d38b33e6aa4d14ae7dce78a4b9))
* **runtime:** apply permission reloads atomically ([49e843e](https://github.com/morluto/rea/commit/49e843e8ff2eb87bf1c6174823191cc97ad1ced8))
* **runtime:** apply permission reloads atomically ([3ae7109](https://github.com/morluto/rea/commit/3ae7109faa29175e84ef695b296ad4db14097a37))
* **runtime:** serialize permission reloads ([7e53dd6](https://github.com/morluto/rea/commit/7e53dd6ad321f9b75dbe458f9e116da7637d740c))
* **runtime:** unregister shutdown handlers ([71072d8](https://github.com/morluto/rea/commit/71072d86b161530d523a10e920e5d67ca220a7e9))
* **runtime:** unregister shutdown handlers ([f9e3c23](https://github.com/morluto/rea/commit/f9e3c23987bdf37be07d6c4602666c6ac90ae0ed))
* **session:** isolate availability observers ([43766fd](https://github.com/morluto/rea/commit/43766fda699f5498909af21e386ae4817159e4cf))
* **session:** isolate availability observers ([e5a80d4](https://github.com/morluto/rea/commit/e5a80d4f06cd0d4bf64e6b94b50f7430829c336a))
* **session:** reopen replaced targets ([e98413c](https://github.com/morluto/rea/commit/e98413c3d5b0adae72ac9f3814f401ad9eec2bb6))
* **session:** reopen replaced targets ([5c55999](https://github.com/morluto/rea/commit/5c559998e14bcb9be1e589a1266e31296a8f2af8))
* **setup:** configure every detected client ([69744a4](https://github.com/morluto/rea/commit/69744a421a28bad525fe95697938b99d7ffcf5b6))
* **setup:** configure every detected client ([24f9a1f](https://github.com/morluto/rea/commit/24f9a1ff11e4d1a6361071739fa937d88159fb33))
* **setup:** omit aligned client configurations from plan ([a86da4f](https://github.com/morluto/rea/commit/a86da4ff3f9279e4ca3fc792e6f18542fee9e0ce))
* **setup:** omit aligned skill from plan ([d81687f](https://github.com/morluto/rea/commit/d81687f38393128b0a91ca83deb9b250190fb509))
* **setup:** omit aligned skill from plan ([2984fa7](https://github.com/morluto/rea/commit/2984fa74acfb6f7cbb504677a348e20bff85b806))
* **setup:** preserve client config symlinks ([85285f1](https://github.com/morluto/rea/commit/85285f1563d8d24bb934e1fe227cb91fe36c6dd4))
* **setup:** preserve client config symlinks ([df87544](https://github.com/morluto/rea/commit/df87544a5dcee13f15aa6e435c2b61fb3b220397))
* **test:** adapt mainReload shutdown seam to registerShutdown signature ([0a430c1](https://github.com/morluto/rea/commit/0a430c12c158cf7f1ef04cdf537d5277c08c6106))
* **tooling:** isolate concurrent repository checks ([fb17156](https://github.com/morluto/rea/commit/fb17156499c592b5e18ffae996c55c372e3727d0))
* **tooling:** isolate concurrent repository checks ([ab8c5c1](https://github.com/morluto/rea/commit/ab8c5c1e13041690e07896f2f2f0dfa2134ad97e))
* **upgrade:** prevent version downgrades ([a204840](https://github.com/morluto/rea/commit/a2048406302b808e4f897eabd6c00ce64c529c16))
* **upgrade:** prevent version downgrades ([1d1d234](https://github.com/morluto/rea/commit/1d1d234eedd3b73108cd2fb41878680ca107bb7c))
* **verify:** reconcile PR-212/215/228 package E2E expectations ([cfa110c](https://github.com/morluto/rea/commit/cfa110ccb4021d383cc8be1caa17fef923edc183))


### Performance Improvements

* **application:** scan version artifacts in parallel ([528c05e](https://github.com/morluto/rea/commit/528c05e2faa557e17b6b83ccd7e1b0e779ba892a))
* **application:** scan version artifacts in parallel ([c00739b](https://github.com/morluto/rea/commit/c00739bb1f1ae3cb6f00464e8fd9f5b5f7dc6b6e))


### Tests

* **application:** verify packaged MCP replay ([6601e0c](https://github.com/morluto/rea/commit/6601e0cb7e57fe94cf0ae65bf0d04de25a3a7b49))
* **browser:** harden Chrome startup on CI ([74c5121](https://github.com/morluto/rea/commit/74c512130c5bc25d6c119eda72a86e73fcc9f1ff))
* **browser:** route discovery sockets through proxy ([e363f0e](https://github.com/morluto/rea/commit/e363f0eab8325a9f83568295d4669d70e7d47a2d))
* **browser:** verify page-scoped Chrome transport ([c252536](https://github.com/morluto/rea/commit/c252536494c15f36e69978eaf068eae176e71688))
* **cli:** verify packaged policy revocation ([3d71737](https://github.com/morluto/rea/commit/3d71737dc9ba8b449c0d174da90c3f1df54789d2))
* **hopper:** cover verified Linux rejection ([db202c2](https://github.com/morluto/rea/commit/db202c2b6ac9ce771c401cc558c56ecf6d2e51ee))
* **hopper:** retry after cancelled startup ([6de726f](https://github.com/morluto/rea/commit/6de726ffddc54ea354e6970f022eaab2f0863586))
* **hopper:** verify alternate Linux launcher path ([d93257b](https://github.com/morluto/rea/commit/d93257b50fae81272cbd2da28ba24d03647c2c99))
* **package:** cover aligned setup plan ([a597639](https://github.com/morluto/rea/commit/a5976396eb424933232844e161cdab84b452b361))
* **package:** cover config symlink lifecycle ([d1ef7a5](https://github.com/morluto/rea/commit/d1ef7a54394ff2ed4316ba01cfe0aa4aac313aed))
* **package:** preserve unrelated symlink config ([c50e51e](https://github.com/morluto/rea/commit/c50e51eb6fe5686ad9d680abe0d96b3e4b58dc78))
* reduce test suite runtime ([2223da1](https://github.com/morluto/rea/commit/2223da19166a3ec485d98a0d005113a9d0358f37))
* **reference:** cover failure normalization ([3d5041f](https://github.com/morluto/rea/commit/3d5041fb2f8964c30f0273615b4f039620eef0bf))
* **runtime:** cover idempotent handler cleanup ([1bdb59e](https://github.com/morluto/rea/commit/1bdb59e201a26b53f5ed8b2eb870941ca4b788f7))
* serialize subprocess-heavy integrations ([f46fc7f](https://github.com/morluto/rea/commit/f46fc7f1f3a265123c69d007c64c928a8974d98f))
* **session:** reopen replaced target through MCP ([1c32880](https://github.com/morluto/rea/commit/1c32880e56450b610d766c5a6c1bee6873ee6323))
* **setup:** cover later clients after failure ([8f73112](https://github.com/morluto/rea/commit/8f7311285b2ba7a1ed427d61e437dd2665e20d12))

## [1.5.0](https://github.com/morluto/rea/compare/rea-agents-1.4.0...rea-agents-1.5.0) (2026-07-14)


### Features

* add passive website reverse engineering ([9986971](https://github.com/morluto/rea/commit/998697155dcc733be73e75bc77c069638942f111))
* add passive website reverse engineering ([2c1ceab](https://github.com/morluto/rea/commit/2c1ceabbf1f117daafe166e1134b47737b38e1f6))


### Bug Fixes

* **browser:** drop disallowed redirect evidence ([8481be9](https://github.com/morluto/rea/commit/8481be9c9709b13f572fefefcf8508d9e2605386))
* **browser:** scope CDP events and fail closed ([5279d77](https://github.com/morluto/rea/commit/5279d7755c74df579028ce51b4bc53b089bb2749))
* **browser:** scope workers and binary frame sizes ([dfc06cf](https://github.com/morluto/rea/commit/dfc06cf0ad4a39719ef74846cb83f05e7b6f6289))
* harden PTY events and configured roots ([ae8b1c5](https://github.com/morluto/rea/commit/ae8b1c5ca9c2d122d7fc30ebfa25e08d57ca7a51))
* harden PTY events and configured roots ([31b40f3](https://github.com/morluto/rea/commit/31b40f39e4c29a077deebefbe29e90c30e50cd0c))
* **permission:** defer cache write grants ([6a3fd5b](https://github.com/morluto/rea/commit/6a3fd5b4cec7569eebfe8a7ca6a7c0c1e3a7340d))
* **permission:** defer cache write grants ([f840e70](https://github.com/morluto/rea/commit/f840e70749ffadfe34cf8b7e464b54e8ffebd816))
* resolve triaged correctness issues ([2575b30](https://github.com/morluto/rea/commit/2575b30dfcb79c2e26ed16311f780a8723578c6a))
* resolve triaged correctness issues ([e8ed307](https://github.com/morluto/rea/commit/e8ed3073ac915e32b5ea630446ed6e14bc788119))
* resolve validation and artifact edge cases ([2468682](https://github.com/morluto/rea/commit/246868232e4196394fbc6e67cfae4d3ca214fe60))
* resolve validation and artifact edge cases ([ef7f2f9](https://github.com/morluto/rea/commit/ef7f2f93747f0a4d9f70c9fc2e252456d20843f3))


### Documentation

* add Hopper screenshot to README ([a699fdd](https://github.com/morluto/rea/commit/a699fdd6a5cc9c9812c7d78fd98b51469488866f))
* add Hopper screenshot to README ([08981a3](https://github.com/morluto/rea/commit/08981a31b5e9b76e15914c0570244158d491e047))


### Tests

* **cli:** allow cold-start integration timing ([7d5621d](https://github.com/morluto/rea/commit/7d5621dfbc4333f99846cbe52227d3b4f53ee0cd))

## [1.4.0](https://github.com/morluto/rea/compare/rea-agents-1.3.0...rea-agents-1.4.0) (2026-07-14)


### Features

* **core:** add typed policy and integrity contracts ([190efca](https://github.com/morluto/rea/commit/190efcaf1728743a02fb65a35319abdc14ea2227))
* **identity:** derive MCP surface metadata ([2722722](https://github.com/morluto/rea/commit/2722722425cb7e7f5954de95ea4641ba2f1ae03b))
* **mcp:** expose progress resources and availability ([da59299](https://github.com/morluto/rea/commit/da59299a8a83241e6912a062cf8d5744993cad9e))
* **mcp:** land policy, resources, and typed contracts ([8f79ee7](https://github.com/morluto/rea/commit/8f79ee771e362f69001a483dcbdb59f4c7b89af0))


### Bug Fixes

* **ci:** keep generated error docs with their owner ([3e60e38](https://github.com/morluto/rea/commit/3e60e38a147eafa0445e4f9935ede279b4aab688))
* **ci:** preserve stacked integration changes ([cf8e5cf](https://github.com/morluto/rea/commit/cf8e5cf5e61fe00731768107790e715958a96fc8))
* **cli:** return nonzero status for operation failures ([#121](https://github.com/morluto/rea/issues/121)) ([00c187e](https://github.com/morluto/rea/commit/00c187e32b3d2add37245a48f21185c2bd4fc22a))
* **cli:** return nonzero status for operation failures ([#122](https://github.com/morluto/rea/issues/122)) ([964620a](https://github.com/morluto/rea/commit/964620a0a108c3c671d982da37b5d4c05c4ef035))
* **hopper:** complete owned Linux shutdown ([#116](https://github.com/morluto/rea/issues/116)) ([fb51874](https://github.com/morluto/rea/commit/fb51874bb9ee1d5144c897e0de4c7e083ba4d390))
* **mcp:** preserve migrated revisions and valid links ([4149472](https://github.com/morluto/rea/commit/414947243963fed5f769a124758424dda371dcd7))
* preserve actionable artifact diagnostics ([#119](https://github.com/morluto/rea/issues/119)) ([7385220](https://github.com/morluto/rea/commit/73852202d42743fe5589fd9477f0d0991d87c060))
* **workspace:** migrate legacy integrity identities ([d092d4c](https://github.com/morluto/rea/commit/d092d4c97a51882f7cdbc0e3dd167cea309b8adf))


### Tests

* **identity:** defer live MCP integration proof ([74db3fc](https://github.com/morluto/rea/commit/74db3fcd4259f3c09fb29cc7762952320b99ae71))

## [1.3.0](https://github.com/morluto/rea/compare/rea-agents-1.2.0...rea-agents-1.3.0) (2026-07-13)


### Features

* add guided MCP workflow prompts ([08d5b91](https://github.com/morluto/rea/commit/08d5b913b00a382af6e9e8c847459608e2f2384e))
* add guided MCP workflow prompts ([24c3adb](https://github.com/morluto/rea/commit/24c3adb553407fb9ac696e8e7c8d6eea643d14d6))
* add persistent cross-version investigation workspaces ([c52eb46](https://github.com/morluto/rea/commit/c52eb4600a275fe080d8ba1f27fd6cef95f85850))
* add persistent cross-version investigation workspaces ([41366ed](https://github.com/morluto/rea/commit/41366edd566ba17cce81cd0cc3b503065775febc))
* **analysis:** add provider-neutral persistent snapshots ([c439b9e](https://github.com/morluto/rea/commit/c439b9e7787f3947eced0126a9c7b4d091584363))
* **analysis:** persist snapshots and close Hopper reliably ([c6407ef](https://github.com/morluto/rea/commit/c6407ef3d66d78e7635ec1b082144cd38068f93a))
* **errors:** add caller-safe typed error projections ([3be439c](https://github.com/morluto/rea/commit/3be439cbf3db2c53c766bf93a4e247fdfb8242ae))
* **mcp:** return structured typed tool results ([eb38e4c](https://github.com/morluto/rea/commit/eb38e4c4024a7d66001b3e69f8309c85492f05c0))


### Bug Fixes

* **bridge:** bound regex search work ([733a382](https://github.com/morluto/rea/commit/733a382b3020c4953747d7c6e2caf73883a6274c))
* **bridge:** bound regex search work ([65682ee](https://github.com/morluto/rea/commit/65682ee65c9f899875be5a785c0ec688bc4eda14))
* **ci:** remove unused setup type export ([c5728af](https://github.com/morluto/rea/commit/c5728af0b4574631d056f7ed1eb7785e80d80111))
* **cli:** render actionable analysis errors ([af8c4ef](https://github.com/morluto/rea/commit/af8c4efb4a415e4bdeae0151a8d29cd71af61916))
* **copy:** use agent terminology ([12060f6](https://github.com/morluto/rea/commit/12060f6d8dd3ed61fbd1d07fa604652c6b0a93e2))
* **errors:** improve recovery guidance ([77454dc](https://github.com/morluto/rea/commit/77454dc8f412e8431bbceff1a4c90ee8f636c9c7))
* **errors:** return actionable caller-safe failures ([fb0da03](https://github.com/morluto/rea/commit/fb0da031cf6305f5aaec5e9ec8178f08fd664479))
* **hopper:** cancel analysis and close documents reliably ([179870e](https://github.com/morluto/rea/commit/179870e8256419402464f02c918146865c6fbb93))
* **hopper:** return addresses for procedure relationships ([2c707ab](https://github.com/morluto/rea/commit/2c707abb66433f9065733398a0e5ea9af04cfb96))
* **linux:** start Hopper demo sessions headlessly ([32c5080](https://github.com/morluto/rea/commit/32c5080a26cae603f02dce9dc5777e98d1e5fc75))
* **linux:** start Hopper demo sessions headlessly ([75818d1](https://github.com/morluto/rea/commit/75818d119e3eb3b8df5acdbd554a2b86b82af23a))
* **security:** restrict investigation artifact inputs ([a2076b4](https://github.com/morluto/rea/commit/a2076b47a6b43d9c80396ee4a5954af590d65088))


### Tests

* **linux:** verify setup through CLI and MCP ([67504d2](https://github.com/morluto/rea/commit/67504d2d51151fd9eed76b12c9bae67c70817432))
* **package:** preserve unsupported host verification ([977119f](https://github.com/morluto/rea/commit/977119f91b4af39ea208a5e63d9445bf366b2eeb))
* strengthen MCP prompt acceptance coverage ([05fb9b1](https://github.com/morluto/rea/commit/05fb9b17c91b2ed7bfb58c3399499e0fb9e3f73e))

## [1.2.0](https://github.com/morluto/rea/compare/rea-agents-1.1.0...rea-agents-1.2.0) (2026-07-13)


### Features

* **artifacts:** add approved native DMG traversal ([24d000a](https://github.com/morluto/rea/commit/24d000a76e3fb98c69d47ab26ac1322a4c87f901))
* **process:** add deterministic capture v3 ([d0e21f9](https://github.com/morluto/rea/commit/d0e21f923158b7a3de73d06edf57462869022556))
* **process:** add deterministic capture v3 ([5a361a6](https://github.com/morluto/rea/commit/5a361a67258e1f89507497eafd5fc487e54d5820))
* **process:** introduce evidence-safe capture v4 ([ee4d284](https://github.com/morluto/rea/commit/ee4d284597a32b4acc4279b74083d9bf4e32d08b))


### Bug Fixes

* **artifacts:** diagnose unpacked ASAR integrity failures ([a504342](https://github.com/morluto/rea/commit/a504342d2b7e5ed87620d449f78102282054e063))
* **ci:** remove redundant process exports ([19bb231](https://github.com/morluto/rea/commit/19bb2317d1bd6773e5fa3f61e32cbf3d6d257830))
* **process:** harden capture validation and cleanup ([ac78de0](https://github.com/morluto/rea/commit/ac78de0a74b09a01efd91d9f88a16fde4f0ed9d9))


### Code Refactoring

* **artifacts:** simplify inventory traversal ([c8d762e](https://github.com/morluto/rea/commit/c8d762e6ffe0a2e23fb539590d7b1850ef1ce2a7))
* **setup:** split setup and CLI registration ([07e1b5a](https://github.com/morluto/rea/commit/07e1b5ac5f6a1724b1064c47ea05f04ccffcb4f3))


### Documentation

* document capture v4 and native mounts ([aca518b](https://github.com/morluto/rea/commit/aca518bb885825b912567eba95eb64a776a5624c))
* document process capture v3 ([50f4a29](https://github.com/morluto/rea/commit/50f4a298f44bf56dc78d5717cb23d69db5df4265))
* **process:** preserve capture invariants ([841990b](https://github.com/morluto/rea/commit/841990bde158a996be65feabcef4aa5e18fc3a4b))
* **skill:** document capture v4 and DMG mounts ([f0a9a3c](https://github.com/morluto/rea/commit/f0a9a3cd258d60046dcd74feea243956489c60dc))


### Tests

* **process:** use deterministic hang fixture ([ba15d16](https://github.com/morluto/rea/commit/ba15d16c5869ef29e85a0e9bacff3ac07edda3a2))

## [1.1.0](https://github.com/morluto/rea/compare/rea-agents-1.0.0...rea-agents-1.1.0) (2026-07-13)


### Features

* **setup:** make installation explicit and safe ([29d92ca](https://github.com/morluto/rea/commit/29d92cac5ab23a4e6a5286b0871224abbe705642))
* **setup:** make installation explicit and safe ([3793889](https://github.com/morluto/rea/commit/3793889ce8662ca8e1e92af1bb5c6ee854848467))


### Bug Fixes

* preserve requested evidence paths on macOS ([0c0e2b8](https://github.com/morluto/rea/commit/0c0e2b8a1efb3f56672b9c95fda5c5ab5746284b))
* preserve requested evidence paths on macOS ([3d0ad79](https://github.com/morluto/rea/commit/3d0ad799c4deb1d3627d8721c31bc76be3f3abd2))


### Documentation

* **api:** regenerate TypeDoc reference ([0a66cae](https://github.com/morluto/rea/commit/0a66cae16ef8e2a243bbed502bbb7cdbd12a965f))
* define REA contributor priorities ([5df4ef6](https://github.com/morluto/rea/commit/5df4ef67a4676f46900aa6022c1af2224efa8761))
* explain the installation workflow ([1c83263](https://github.com/morluto/rea/commit/1c83263bbb79aa050d1e560d17da66557afdbad2))

## [1.0.0](https://github.com/morluto/rea/compare/rea-agents-0.5.0...rea-agents-1.0.0) (2026-07-13)


### ⚠ BREAKING CHANGES

* **contracts:** batch_decompile, get_call_graph, and find_xrefs_to_name now return structured discriminated output shapes.

### Features

* **cli:** add self-upgrade command ([c004220](https://github.com/morluto/rea/commit/c004220a2699ac60a67a9c7edf1f96cad8a31d3e))
* **cli:** add self-upgrade command ([0d77a9f](https://github.com/morluto/rea/commit/0d77a9f1350056a7d2c43771d579e0461029f5b5))


### Bug Fixes

* **contracts:** keep error schema internal ([ac8cc66](https://github.com/morluto/rea/commit/ac8cc668fb6b9305d2dc9014f7a6006d96b18ba6))
* **contracts:** return structured workflow failures ([4c54ff6](https://github.com/morluto/rea/commit/4c54ff6bcaac02f39c6620a54ac29690a121f33d))
* **native:** classify pre-aborted analysis first ([dfd598f](https://github.com/morluto/rea/commit/dfd598f76505af978f2d11afffb5e1f362d3a769))


### Documentation

* list upgrade in CLI reference ([8a24088](https://github.com/morluto/rea/commit/8a24088c2bffd34050ea6f6f0e103f64a3f67a64))

## [0.5.0](https://github.com/morluto/rea/compare/rea-agents-0.4.0...rea-agents-0.5.0) (2026-07-13)


### Features

* **analysis:** harden agent workflows and evidence boundaries ([883db91](https://github.com/morluto/rea/commit/883db912da6e38e1078286997cc9048471e03896))
* **cli:** align terminal workflows with MCP ([b1912b1](https://github.com/morluto/rea/commit/b1912b18e1723c594a030b16acf01341f083455b))


### Bug Fixes

* **analysis:** accept valid final dossier pages ([7c36f36](https://github.com/morluto/rea/commit/7c36f3631862e67a0751967c84abc4f423f5475c))
* **bridge:** harden bounded Hopper boundaries ([f8e8ea3](https://github.com/morluto/rea/commit/f8e8ea35ff08ce5071acbccab188df808708b71c))
* **cli:** preserve function provider provenance ([c630f41](https://github.com/morluto/rea/commit/c630f410b6a81864bf90211a088c715bfe234722))
* **lifecycle:** validate owned Hopper process identity ([898d6b0](https://github.com/morluto/rea/commit/898d6b0192126030cedd7e5c2cb76f40568cda05))
* **process:** default capture networking to loopback ([bce3398](https://github.com/morluto/rea/commit/bce3398dbe3a3b20952f37573a656aa77b168977))
* **process:** keep network approval fail-closed ([9526389](https://github.com/morluto/rea/commit/9526389f815f0937fc01198ff3a8a850c6c1c81a))


### Code Refactoring

* **cli:** share direct analysis tool types ([329fdf6](https://github.com/morluto/rea/commit/329fdf6fe8f3a2bf9679b13a8ce5cb16cf946129))


### Documentation

* correct pull request tool inventory ([d806480](https://github.com/morluto/rea/commit/d806480e41bcb623448a258ddffeb75082fe1e1f))
* document CLI safety and provider evaluation ([efc9bd2](https://github.com/morluto/rea/commit/efc9bd270f58a5aaba15edb07cee135d2c54db83))


### Tests

* **docs:** keep localized claims and tool counts aligned ([a7b84a9](https://github.com/morluto/rea/commit/a7b84a9b4b7ea4336c0f327e13b2948a8d94fba9))
* **verification:** strengthen conformance and real-Hopper checks ([0d36976](https://github.com/morluto/rea/commit/0d369762770d2d92dd72c7dcb2f2f90a64b206ff))

## [0.4.0](https://github.com/morluto/rea/compare/rea-agents-0.3.0...rea-agents-0.4.0) (2026-07-12)


### Features

* add cross-platform installation lifecycle ([cc6a955](https://github.com/morluto/rea/commit/cc6a9557e1fdd8c057902e9c0fcfbba2561cbcd7))
* add cross-platform installation lifecycle ([e651cb6](https://github.com/morluto/rea/commit/e651cb65db87b6d9df9fb13b66a6e5e76f0965e0))


### Documentation

* document installation and Linux support ([034563a](https://github.com/morluto/rea/commit/034563a4c015c69e878054d4fd06e0e9fa630e24))
* simplify REA onboarding ([e1dfe86](https://github.com/morluto/rea/commit/e1dfe8613e5a986d5ee64764851f0abcc901398b))
* simplify REA onboarding ([d85b661](https://github.com/morluto/rea/commit/d85b661be80bd19d477c46ebe0501839c7b63ee7))


### Tests

* add package installation end-to-end coverage ([993356b](https://github.com/morluto/rea/commit/993356b85adc72036ba44cd87b9335e2ec172a32))
* stabilize artifact pagination coverage ([f56bdde](https://github.com/morluto/rea/commit/f56bdde27679e1f05b34d2cf5efbc6e49bd4c2ca))


### Continuous Integration

* enforce conventional pull request titles ([07a0b98](https://github.com/morluto/rea/commit/07a0b984f2bdbc4fe1ce18d5db13500aa8f3992f))
* enforce conventional pull request titles ([3a21f16](https://github.com/morluto/rea/commit/3a21f16c1832430765083636511a8c12dbccf2dd))
* verify installed package with Linux Hopper ([4f97f69](https://github.com/morluto/rea/commit/4f97f699e4d5471557d1ce0ff91e144065d06a61))

## [0.3.0](https://github.com/morluto/rea/compare/rea-0.2.1...rea-agents-0.3.0) (2026-07-12)


### Features

* add evidence-backed process investigations ([cc8681a](https://github.com/morluto/rea/commit/cc8681a856dacb296f835112d0a27133d4c05ad1))
* **cli:** add guided local onboarding ([8ca3db8](https://github.com/morluto/rea/commit/8ca3db829f90f99dcaa57bbfc44fb3fe6a6b60c0))
* evolve REA analysis platform ([4f18e26](https://github.com/morluto/rea/commit/4f18e26ee58f616de788e07639f5b2f91d37ef11))
* **identity:** rename package and CLI to REA ([3d70812](https://github.com/morluto/rea/commit/3d70812c373ca7ef9a41146555605455515998dd))
* **mcp:** add typed bounded analysis tools ([893d2e2](https://github.com/morluto/rea/commit/893d2e2d0550271297c452b418f80bdf8ae21514))
* **session:** add dynamic binary lifecycle ([f32e718](https://github.com/morluto/rea/commit/f32e718cc741bba4deb0162c1a9b93f127e7741a))


### Bug Fixes

* **boundaries:** reject unsafe local inputs ([15e8cf3](https://github.com/morluto/rea/commit/15e8cf3234bd3b5ee929db84c5c71e9a18441eb6))
* **doctor:** require an executable Hopper launcher ([aee9cb8](https://github.com/morluto/rea/commit/aee9cb8e4e919d28ae851987f6555cfceee46977))
* **hopper:** launch analysis without stealing focus ([ff321dc](https://github.com/morluto/rea/commit/ff321dc574cd510e036fe5910fba79058e5c015b))
* **hopper:** make loader selection non-interactive ([2b7ef86](https://github.com/morluto/rea/commit/2b7ef8610df3cbee5fe0a4600dce5381cce77793))
* keep execution options internal ([167a824](https://github.com/morluto/rea/commit/167a824f9131a60d07fca3e99301eecc98d5d5e9))
* **setup:** persist detected Hopper launcher ([b2866e4](https://github.com/morluto/rea/commit/b2866e4706f939ffebf65645f5e3feaf4b4095fd))
* **setup:** preserve consent and startup target kind ([a67054f](https://github.com/morluto/rea/commit/a67054f81500033c0a5b8d87f7f009ed2adda6e3))
* **setup:** preserve invalid MCP configuration ([88f5edc](https://github.com/morluto/rea/commit/88f5edc2365da92673c184ad0d2a9b218ba22f91))
* **targets:** cancel startup and probe PE offsets ([66b8d6e](https://github.com/morluto/rea/commit/66b8d6ea90dabc01162c7d42e37056ea3501939e))
* **verify:** tolerate exited Hopper helpers ([b167bd7](https://github.com/morluto/rea/commit/b167bd7e13ad2e4889f721235fd6b6e3d8e3b08c))


### Code Refactoring

* **cli:** share runtime between CLI and MCP ([97541d8](https://github.com/morluto/rea/commit/97541d8dad96e640ffd9ce5f0587dee0b5fbf6c1))


### Documentation

* document frictionless binary workflow ([ee6d539](https://github.com/morluto/rea/commit/ee6d539a407493617c1a58816e0329d600495217))
* document the 43-tool workflow ([1f235cb](https://github.com/morluto/rea/commit/1f235cb52f61c08b65ecb674cac649c34005bc66))
* record runtime and release constraints ([62ede51](https://github.com/morluto/rea/commit/62ede515b7c7e092714fa936575fd54d282deb93))
* redesign and localize README ([051b6db](https://github.com/morluto/rea/commit/051b6db65687fd14826b6462cd623feb2504f123))
* redesign and localize README ([910eda6](https://github.com/morluto/rea/commit/910eda6f323ba1151b0771fe5de6c60a91e3d46d))


### Tests

* add source-built Hopper conformance fixtures ([d648bcd](https://github.com/morluto/rea/commit/d648bcd2e41ec0b45bc02a69dee0d7206fc64f8f))

## [0.2.1](https://github.com/morluto/rea/compare/rea-0.2.0...rea-0.2.1) (2026-07-12)


### Documentation

* redesign and localize README ([051b6db](https://github.com/morluto/rea/commit/051b6db65687fd14826b6462cd623feb2504f123))
* redesign and localize README ([910eda6](https://github.com/morluto/rea/commit/910eda6f323ba1151b0771fe5de6c60a91e3d46d))

## [0.2.0](https://github.com/morluto/rea/releases/tag/rea-0.2.0) (2026-07-12)


### Features

* **cli:** add guided local onboarding ([8ca3db8](https://github.com/morluto/rea/commit/8ca3db829f90f99dcaa57bbfc44fb3fe6a6b60c0))
* **identity:** rename package and CLI to REA ([3d70812](https://github.com/morluto/rea/commit/3d70812c373ca7ef9a41146555605455515998dd))
* **session:** add dynamic binary lifecycle ([f32e718](https://github.com/morluto/rea/commit/f32e718cc741bba4deb0162c1a9b93f127e7741a))


### Bug Fixes

* **boundaries:** reject unsafe local inputs ([15e8cf3](https://github.com/morluto/rea/commit/15e8cf3234bd3b5ee929db84c5c71e9a18441eb6))
* **doctor:** require an executable Hopper launcher ([aee9cb8](https://github.com/morluto/rea/commit/aee9cb8e4e919d28ae851987f6555cfceee46977))
* **hopper:** launch analysis without stealing focus ([ff321dc](https://github.com/morluto/rea/commit/ff321dc574cd510e036fe5910fba79058e5c015b))
* **hopper:** make loader selection non-interactive ([2b7ef86](https://github.com/morluto/rea/commit/2b7ef8610df3cbee5fe0a4600dce5381cce77793))
* **setup:** persist detected Hopper launcher ([b2866e4](https://github.com/morluto/rea/commit/b2866e4706f939ffebf65645f5e3feaf4b4095fd))
* **setup:** preserve consent and startup target kind ([a67054f](https://github.com/morluto/rea/commit/a67054f81500033c0a5b8d87f7f009ed2adda6e3))
* **setup:** preserve invalid MCP configuration ([88f5edc](https://github.com/morluto/rea/commit/88f5edc2365da92673c184ad0d2a9b218ba22f91))
* **targets:** cancel startup and probe PE offsets ([66b8d6e](https://github.com/morluto/rea/commit/66b8d6ea90dabc01162c7d42e37056ea3501939e))
* **verify:** tolerate exited Hopper helpers ([b167bd7](https://github.com/morluto/rea/commit/b167bd7e13ad2e4889f721235fd6b6e3d8e3b08c))


### Code Refactoring

* **cli:** share runtime between CLI and MCP ([97541d8](https://github.com/morluto/rea/commit/97541d8dad96e640ffd9ce5f0587dee0b5fbf6c1))


### Documentation

* document frictionless binary workflow ([ee6d539](https://github.com/morluto/rea/commit/ee6d539a407493617c1a58816e0329d600495217))
* record runtime and release constraints ([62ede51](https://github.com/morluto/rea/commit/62ede515b7c7e092714fa936575fd54d282deb93))
