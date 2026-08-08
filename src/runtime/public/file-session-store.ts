import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertPersistedKeyPolicy } from "../../persisted-key-policy.js";
import { createAtomicWriteTempPath } from "../../session/persistence/atomic-write.js";
import { parseSessionRecord } from "../../session/persistence/parse.js";
import { serializeSessionRecordForDisk } from "../../session/persistence/serialize.js";
import type { AcpFileSessionStoreOptions, AcpSessionRecord, AcpSessionStore } from "./contract.js";

function safeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

class FileSessionStore implements AcpSessionStore {
  constructor(private readonly stateDir: string) {}

  private get sessionDir(): string {
    return path.join(this.stateDir, "sessions");
  }

  private filePath(sessionId: string): string {
    return path.join(this.sessionDir, `${safeSessionId(sessionId)}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
  }

  async load(sessionId: string): Promise<AcpSessionRecord | undefined> {
    await this.ensureDir();
    let payload: string;
    try {
      payload = await fs.readFile(this.filePath(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return undefined;
    }
    return parseSessionRecord(parsed) ?? undefined;
  }

  async save(record: AcpSessionRecord): Promise<void> {
    await this.ensureDir();
    const persisted = serializeSessionRecordForDisk(record);
    assertPersistedKeyPolicy(persisted);

    const file = this.filePath(record.acpxRecordId);
    const tempFile = createAtomicWriteTempPath(file);
    const payload = JSON.stringify(persisted, null, 2);
    await fs.writeFile(tempFile, `${payload}\n`, "utf8");
    await fs.rename(tempFile, file);
  }

  async rebind(sourceSessionId: string, record: AcpSessionRecord): Promise<void> {
    await this.ensureDir();
    if (sourceSessionId === record.acpxRecordId) {
      await this.save(record);
      return;
    }

    const sourceFile = this.filePath(sourceSessionId);
    const targetFile = this.filePath(record.acpxRecordId);
    const persisted = serializeSessionRecordForDisk(record);
    assertPersistedKeyPolicy(persisted);

    const tempFile = `${targetFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(persisted, null, 2);
    await fs.writeFile(tempFile, `${payload}\n`, { encoding: "utf8", flag: "wx" });
    try {
      // link() is an atomic create-if-absent operation. Unlike rename(), it
      // cannot silently overwrite a real session that already owns targetFile.
      await fs.link(tempFile, targetFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`ACP session already exists: ${record.acpxRecordId}`, { cause: error });
      }
      throw error;
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }

    try {
      await fs.unlink(sourceFile);
    } catch (error) {
      // Do not leave a duplicate target if the source could not be retired.
      await fs.unlink(targetFile).catch(() => {});
      throw error;
    }
  }
}

export function createFileSessionStore(options: AcpFileSessionStoreOptions): AcpSessionStore {
  return new FileSessionStore(path.resolve(options.stateDir));
}
