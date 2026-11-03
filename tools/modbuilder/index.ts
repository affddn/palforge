// The image is built on each server from these files; its tag is a hash of their contents.
export const modbuilderContext = {
  dir: import.meta.dirname,
  files: [
    "Dockerfile",
    "uasset-json/Program.cs",
    "uasset-json/UAssetJson.csproj",
    "uasset-json/packages.lock.json",
  ],
} as const;
