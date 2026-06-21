export interface RawMigrationFile {
  path: string;
  domain: string;
  filename: string;
  mime: string;
  bytes: number;
}

export interface RawMigrationOptions {
  baseUrl?: string;
  key?: string;
  input?: string;
  manifest?: string;
  objectRoot?: string;
  domain?: string;
  inferSchema?: boolean;
  applySchema?: boolean;
  queueIngest?: boolean;
  runId?: string;
  dryRun?: boolean;
}

export function normalizeMigrationInput(options: RawMigrationOptions): Promise<RawMigrationFile[]>;
export function migrateRawFiles(options: RawMigrationOptions): Promise<Record<string, unknown>>;
