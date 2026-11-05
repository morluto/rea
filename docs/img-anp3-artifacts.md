# IMG v2 archives and ANP3 animation packages

REA recognizes two asset formats of a legacy game engine by their byte
signatures, independently of the file extension. Inspection uses portable
Node.js file reads; it needs neither the engine nor a modding tool, and nothing
is executed.

- **IMG version 2** is a sector-based archive container that starts with
  `VER2`. It holds assets such as models, textures and animation packages.
- **ANP3** is a keyframed skeletal animation package that starts with `ANP3`.
  It ships on its own and as a member of IMG archives.

```bash
rea inspect-artifact assets.img --json
rea extract-artifact assets.img --json
rea inspect-artifact actor.anim --json
```

Through MCP, call `open_binary` with the local path, then `inspect_artifact`.
Use `extract_artifact` to materialize members in the fresh directory named by
its result. The caller owns that successful extraction directory.

## IMG version 2

The header is `VER2` and a little-endian u32 entry count. Each 32-byte
directory row holds a u32 offset, a u16 streaming size and a u16 archive size,
all in 2048-byte sectors, and a NUL-terminated 24-byte name. Archives commonly
leave the archive size at 0; REA then uses the streaming size.

The root occurrence's `format_metadata` (`kind: "img-v2"`) reports the entry
count, sector size and directory end. Every member occurrence carries its name,
physical offset and size, and `kind: "img-v2-entry"` metadata with the declared
`offset_sectors`, `streaming_sectors` and `archive_sectors`. Follow
`artifact_id` to the node's observed SHA-256.

Member sizes are whole sectors, so member bytes include the zero padding after
the stored file. Members are classified by their bytes: an ANP3 member reports
`artifact_format: "anp3"`, and inspection then suggests extracting it.
Inventory does not expand nested members; extract the ANP3 member, then open
and inspect it as below.

A directory that cannot fit in the file, a member that leaves the file or
starts inside the directory, and an empty, unterminated or multi-component
name are refused as malformed instead of repaired. A directory above 65,536
entries exceeds the 64 MiB retained metadata budget and is refused with a
memory limit.

## ANP3

The header is `ANP3`, a u32 end offset, a 24-byte package name and a u32
animation count. Each animation record has a 24-byte name, an object count, a
declared frame-data size and a flags field. Each object has a 24-byte bone
name, a frame type, a keyframe count and a bone id, followed by its keyframes:

| Frame type | Keyframe                                   | Bytes |
| ---------- | ------------------------------------------ | ----- |
| 1          | float rotation quaternion, float time      | 20    |
| 2          | type 1 plus a float translation            | 32    |
| 3          | 16-bit quaternion (/4096) and time (/60 s) | 10    |
| 4          | type 3 plus a 16-bit translation (/1024)   | 16    |

The root `format_metadata` (`kind: "anp3"`) reports the package name,
declared end offset, animation count and any trailing bytes, such as IMG sector
padding. Each animation is one occurrence named
`animations/<index>-<name>.bin` that covers its record bytes. Its
`kind: "anp3-animation"` metadata holds the stored name, object count,
keyframe count, duration and one row per object with the bone name, bone id,
frame type and keyframe count. Characters outside `A-Z`, `a-z`, `0-9`, `.`, `_`
and `-` are replaced with `_` in the path only.

The duration is the latest final keyframe time across objects. It is `null`
for an animation without keyframes, and for one whose final float time is not
finite, which inventory also reports as a limitation.

Keyframe values are not decoded beyond each object's final time, and bone ids
are not resolved against a skeleton. Truncated records and unknown frame types
are refused with their byte offset. Packages are parsed in memory; a package
above 16 MiB is refused with a fixed memory limit and no runtime override.

## Supported boundary

IMG version 1 (a headerless `.img` with a separate `.dir` file), IMG version 3,
and the earlier ANPK and ANP2 animation package layouts are not recognized.
Model, texture and collision streams stored as IMG members are not decoded.

Source-owned byte fixtures verify detection, inventory metadata, extraction,
nested classification of an ANP3 member, and malformed inputs through the
public MCP workflow. These checks do not establish compatibility with every
modified archive.
