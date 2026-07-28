export type Importance = "low" | "normal" | "high" | "urgent";

export interface MailFixture {
  id: number;
  created: string;
  from: string;
  to: string[];
  subject: string;
  body?: string;
  importance?: Importance;
  ackRequired?: boolean;
  malformed?: "filename" | "frontmatter";
}

export interface WrittenFixture extends MailFixture {
  path: string;
  writtenAtNs: bigint;
}

export interface EvidenceRecord {
  sequence: number;
  atNs: bigint;
  channel: "fixture" | "process" | "stdout" | "stderr" | "json-rpc" | "transcript";
  direction?: "in" | "out";
  value: string;
}

export interface ProcessEvidence {
  command: string[];
  code: number;
  success: boolean;
  stdout: string;
  stderr: string;
  startedAtNs: bigint;
  endedAtNs: bigint;
}

export interface HarnessOptions {
  root: string;
  project: string;
  agent: string;
  nowNs?: () => bigint;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function timestampToken(created: string): string {
  return created.replaceAll(":", "-").replace(/\.\d+(?=Z$)/, "");
}

function subjectToken(subject: string): string {
  return subject.toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-+|-+$/g, "") ||
    "no-subject";
}

function monthPath(created: string): string {
  const match = created.match(/^(\d{4})-(\d{2})-/);
  if (!match) throw new Error(`created must be an ISO timestamp: ${created}`);
  return `${match[1]}/${match[2]}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

/** Shared Phase-0 evidence harness. It writes only beneath its configured fixture root. */
export class CodexIngressHarness {
  readonly records: EvidenceRecord[] = [];
  readonly inbox: string;
  #sequence = 0;
  #nowNs: () => bigint;

  constructor(readonly options: HarnessOptions) {
    if (!options.root || !options.project || !options.agent) {
      throw new Error("root, project, and agent are required");
    }
    this.inbox = `${options.root}/projects/${slug(options.project)}/agents/${options.agent}/inbox`;
    this.#nowNs = options.nowNs ?? (() => Temporal.Now.instant().epochNanoseconds);
  }

  record(
    channel: EvidenceRecord["channel"],
    value: string,
    direction?: EvidenceRecord["direction"],
  ): EvidenceRecord {
    const item = { sequence: ++this.#sequence, atNs: this.#nowNs(), channel, direction, value };
    this.records.push(item);
    return item;
  }

  async writeMail(fixture: MailFixture): Promise<WrittenFixture> {
    const directory = `${this.inbox}/${monthPath(fixture.created)}`;
    await Deno.mkdir(directory, { recursive: true });
    const normalName = `${timestampToken(fixture.created)}__${subjectToken(fixture.subject)}__` +
      `${fixture.id}.md`;
    const filename = fixture.malformed === "filename" ? `malformed-${fixture.id}.md` : normalName;
    const path = `${directory}/${filename}`;
    const frontmatter = {
      ack_required: fixture.ackRequired ?? false,
      attachments: [],
      created: fixture.created,
      from: fixture.from,
      id: fixture.id,
      importance: fixture.importance ?? "normal",
      project: this.options.project,
      project_slug: slug(this.options.project),
      subject: fixture.subject,
      to: fixture.to,
    };
    const raw = fixture.malformed === "frontmatter"
      ? "---json\n{broken-json\n---\n\n"
      : `---json\n${JSON.stringify(frontmatter, null, 2)}\n---\n\n${fixture.body ?? ""}\n`;
    await Deno.writeTextFile(path, raw);
    const writtenAtNs = this.record("fixture", path).atNs;
    return { ...fixture, path, writtenAtNs };
  }

  async writeBurst(fixtures: readonly MailFixture[]): Promise<WrittenFixture[]> {
    const out: WrittenFixture[] = [];
    for (const fixture of fixtures) out.push(await this.writeMail(fixture));
    return out;
  }

  captureJsonRpc(direction: "in" | "out", rawFrame: string): unknown {
    this.record("json-rpc", rawFrame, direction);
    return JSON.parse(rawFrame);
  }

  transcript(value: string): void {
    this.record("transcript", value);
  }

  async runProcess(command: string[], env?: Record<string, string>): Promise<ProcessEvidence> {
    if (!command.length) throw new Error("process command must not be empty");
    const startedAtNs = this.record("process", stableJson({ event: "start", command })).atNs;
    const output = await new Deno.Command(command[0], {
      args: command.slice(1),
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (stdout) this.record("stdout", stdout);
    if (stderr) this.record("stderr", stderr);
    const endedAtNs = this.record(
      "process",
      stableJson({ event: "exit", code: output.code }),
    ).atNs;
    return {
      command: [...command],
      code: output.code,
      success: output.success,
      stdout,
      stderr,
      startedAtNs,
      endedAtNs,
    };
  }

  evidenceJson(): string {
    return JSON.stringify(
      this.records.map((record) => ({ ...record, atNs: record.atNs.toString() })),
      null,
      2,
    );
  }
}

export function standardMailScenarios(): MailFixture[] {
  const base = {
    from: "GoldenLake",
    to: ["CobaltJaguar"],
    body: "fixture body",
  };
  return [
    {
      ...base,
      id: 1,
      created: "2026-07-28T20:00:00.000000Z",
      subject: "ordered one",
    },
    {
      ...base,
      id: 2,
      created: "2026-07-28T20:00:00.010000Z",
      subject: "ordered two",
    },
    {
      ...base,
      id: 3,
      created: "2026-07-28T20:00:00.020000Z",
      subject: "urgent",
      importance: "urgent",
    },
    {
      ...base,
      id: 4,
      created: "2026-07-28T20:00:00.030000Z",
      subject: "ack required",
      ackRequired: true,
    },
    {
      ...base,
      id: 5,
      created: "2026-07-28T20:00:00.040000Z",
      subject: "malformed frontmatter",
      malformed: "frontmatter",
    },
  ];
}
