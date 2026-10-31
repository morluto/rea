import { artifactReaderLifecycleCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { buildGodotPck } from "../../tests/fixtures/godotPck.js";
import { GodotPckArtifactReader } from "./GodotPckArtifactReader.js";

artifactReaderLifecycleCases({
  image: () =>
    buildGodotPck(4, [{ path: "res://member.txt", data: "member bytes" }]),
  createReader: (path, admitted) => new GodotPckArtifactReader(path, admitted),
});
