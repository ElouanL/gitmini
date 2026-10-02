// Build flags default to disabled unless explicitly enabled.
export const featureFlags = {
  githubLogin: import.meta.env.VITE_GITMINI_GITHUB_LOGIN === '1',
} as const;
