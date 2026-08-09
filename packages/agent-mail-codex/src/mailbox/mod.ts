export type {
  MailboxCursor,
  MailboxSource,
  ReadPage,
  SkippedFile,
  SkipReason,
  SourceScope,
} from "./types.ts";
export {
  DOMAIN_SCHEMA_VERSION,
  eventIdFor,
  MailboxError,
  parseAckFrontmatter,
  parseMailboxFilename,
  resolveSlugs,
  slugForProject,
  SUBJECT_MAX_BYTES,
  toMailEvent,
} from "./types.ts";
export { FakeMailboxSource } from "./fake.ts";
export type { FakeMailboxOptions, FakeMailRecord } from "./fake.ts";
export { FsMailboxSource } from "./fs.ts";
export type { FsMailboxOptions } from "./fs.ts";
export { runMailboxSourceContract } from "./contract.ts";
export type { MailboxFactory } from "./contract.ts";
