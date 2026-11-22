export const VALID_BUILD_SCREENSHOT = {
  data: "aW1hZ2U=",
  bytes: Buffer.from("image"),
};

export const INVALID_BUILD_SCREENSHOTS = [
  { name: "invalid-alphabet", data: "aW1hZ2U=!" },
  { name: "noncanonical-padding-bits", data: "aW1hZ2V=" },
  { name: "empty-image", data: "" },
] as const;
