// The image is built on each server from these files; its tag is a hash of their contents.
export const saveToolContext = {
  dir: import.meta.dirname,
  files: ["Dockerfile", "requirements.txt", "savetool.py"],
} as const;
