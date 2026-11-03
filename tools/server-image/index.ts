// palctl builds the guarded server image on each host from these files; its tag includes a hash of their contents.
export const serverImageContext = {
  dir: import.meta.dirname,
  files: ["Dockerfile", "open-pal-guard.sh"],
} as const;
