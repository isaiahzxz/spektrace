/** Documented limits for repository-context import and excerpt export (stage 4A). */
export const REPOSITORY_CONTEXT_LIMITS = {
  maxFilesPerImport: 40,
  maxFileBytes: 128_000,
  maxTotalBytes: 512_000,
  maxRelativePathLength: 240,
  maxRepositoryLabelLength: 200,
  maxCommitShaLength: 64,
  minCommitShaLength: 7,
  maxExcerptsPerRetrieval: 6,
  maxExcerptLines: 24,
  maxExcerptUtf8Bytes: 4_000,
  maxAggregateExcerptUtf8Bytes: 12_000,
  maxExcerptContextLines: 4,
} as const;

export const REPOSITORY_CONTEXT_FORMAT_VERSION = 1;
