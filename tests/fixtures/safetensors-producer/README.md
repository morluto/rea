# Safetensors producer storage oracle

`oracle.json` contains the complete inert bytes emitted by **safetensors 0.7.0**
([released source](https://github.com/huggingface/safetensors/tree/v0.7.0)), encoded
as base64 so no binary fixture is committed. Its expected declarations come from
the package's Rust `deserialize`, independently of REA's JSON reader and dtype
table. Python's JSON reader records the emitted wire offsets; each span is also
checked against the bytes returned by Rust. The producer verifies every decoded
payload against its self-authored input, without interpreting model behavior.

One 1,934-byte model contains 20 tensors and 18 emitted dtypes: integer, boolean,
bfloat16, float16/32/64, complex64, three float8 forms and packed F4, plus a scalar
and an empty tensor. The Python API's `float4_e2m1fn_x2` input shape `[2, 3]`
becomes wire dtype `F4`, shape `[2, 6]` and six bytes. That result comes from the
producer, not a transcription of REA's bit-width mapping. Literal metadata and
names containing JSON Pointer delimiters qualify provenance alongside storage.

The compiled CLI regression checks both header-only and full-file hash modes,
all tensor declarations and physical ranges, exact metadata, totals, and the
existing distinction between consistent storage and uninterpreted tensor data.
CI runs the recorded bytes without Python, NumPy, Torch or model weights.

Reproduce with a user-owned Python environment:

```sh
python3 -m venv /tmp/rea-safetensors-oracle
/tmp/rea-safetensors-oracle/bin/pip install safetensors==0.7.0
/tmp/rea-safetensors-oracle/bin/python tests/fixtures/safetensors-producer/produce.py --check
```

Omit `--check` to regenerate intentionally, then format the JSON with the
repository formatter and review the changed bytes and facts. `--check` compares
JSON values, including the exact encoded file bytes, rather than JSON whitespace.

Current production is correct for this sample. On main `da91bbd4e`, temporarily
changing `F8_E8M0: 8` to `F8_E8M0: 16` in `ModelTensorTypes.ts` left all **161 tests
in the four existing model boundary/CLI suites passing**. This new public CLI
regression rejects the mutated behavior: the valid producer tensor is reported
as having a mismatched byte length. The mutation was restored byte-for-byte
before final checks. This qualifies a missing regression guard, not a production
bug fix, model inference, tensor values, GPU execution or every future dtype.
