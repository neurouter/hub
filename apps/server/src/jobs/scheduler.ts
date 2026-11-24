import { Cron } from 'croner';
import type { Logger } from 'pino';
import type { CoordinationStore } from '../coordination/types.js';

export interface JobDefinition {
  /** Also the lease name, so only one replica runs it (backend §17 jobs registry). */
  name: string;
  /** cron pattern (croner syntax, seconds optional) */
  schedule: string;
  /** Lease TTL; must exceed the job's expected duration. */
  leaseMs?: number;
  /** Run once at start (after registration). */
  runOnStart?: boolean;
  run(ctx: { signal: AbortSignal }): Promise<void>;
}

export type JobRunResult = 'ok' | 'skipped_lease' | 'skipped_running' | 'error';

/** croner + lease-based leadership. Each tick, the replica that takes the lease runs the job. */
export class JobScheduler {
  private readonly jobs = new Map<string, JobDefinition>();
  private readonly crons: Cron[] = [];
  private readonly running = new Set<string>();
  private readonly abort = new AbortController();

  constructor(
    private readonly coord: CoordinationStore,
    private readonly holder: string,
    private readonly log: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>,
  ) {}

  register(job: JobDefinition): void {
    if (this.jobs.has(job.name)) throw new Error(`Job ${job.name} already registered`);
    // validate the pattern eagerly
    new Cron(job.schedule, { paused: true }).stop();
    this.jobs.set(job.name, job);
  }

  list(): string[] {
    return [...this.jobs.keys()];
  }

  /** Runs one tick of a job (lease → run → release). Exposed for tests and on-demand runs. */
  async runOnce(name: string): Promise<JobRunResult> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Unknown job ${name}`);
    if (this.running.has(name)) return 'skipped_running';
    const leaseName = `job:${name}`;
    if (!(await this.coord.acquireLease(leaseName, this.holder, job.leaseMs ?? 60_000))) return 'skipped_lease';
    this.running.add(name);
    const started = Date.now();
    try {
      await job.run({ signal: this.abort.signal });
      this.log.debug({ job: name, ms: Date.now() - started }, 'job finished');
      return 'ok';
    } catch (err) {
      this.log.error({ job: name, err }, 'job failed');
      return 'error';
    } finally {
      this.running.delete(name);
      await this.coord.releaseLease(leaseName, this.holder).catch(() => {});
    }
  }

  start(): void {
    for (const job of this.jobs.values()) {
      this.crons.push(new Cron(job.schedule, { protect: true, catch: true }, () => void this.runOnce(job.name)));
      if (job.runOnStart) void this.runOnce(job.name);
    }
    if (this.jobs.size) this.log.info({ jobs: this.list() }, 'job scheduler started');
  }

  async stop(): Promise<void> {
    for (const c of this.crons.splice(0)) c.stop();
    this.abort.abort(new Error('shutting down'));
    const deadline = Date.now() + 10_000;
    while (this.running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  }
}
