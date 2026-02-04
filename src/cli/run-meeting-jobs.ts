import axios, { AxiosError } from 'axios';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs/promises';
import yaml from 'js-yaml';
import path from 'path';

type MeetingProvider = 'google' | 'microsoft' | 'zoom';

interface MeetingJob {
  provider: MeetingProvider;
  payload: Record<string, unknown>;
}

interface MeetingJobsFile {
  env?: Record<string, string | number | boolean>;
  jobs: MeetingJob[];
}

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_START_TIMEOUT_MS = 120000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const jobsFilePath = process.env.MEETING_JOBS_FILE ?? 'meeting-jobs.yml';
const startServer = process.env.MEETING_JOBS_START_SERVER !== 'false';
const baseUrl = process.env.MEETING_BOT_BASE_URL ?? DEFAULT_BASE_URL;
const pollIntervalMs = parseNumber(
  process.env.MEETING_JOBS_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS
);
const startTimeoutMs = parseNumber(
  process.env.MEETING_JOBS_START_TIMEOUT_MS,
  DEFAULT_START_TIMEOUT_MS
);
const requestTimeoutMs = parseNumber(
  process.env.MEETING_JOBS_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS
);
const jobTimeoutMs = parseNumber(
  process.env.MEETING_JOBS_JOB_TIMEOUT_MS,
  0
);

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const normalizeEnv = (
  env: Record<string, string | number | boolean> | undefined
): Record<string, string> => {
  if (!env) {
    return {};
  }

  return Object.entries(env).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      if (value === undefined || value === null) {
        return acc;
      }

      acc[key] = String(value);
      return acc;
    },
    {}
  );
};

const parseJobsFile = (
  fileContents: string,
  filePath: string
): MeetingJobsFile => {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === '.json') {
    return JSON.parse(fileContents) as MeetingJobsFile;
  }

  return yaml.load(fileContents) as MeetingJobsFile;
};

const loadJobsFile = async (filePath: string): Promise<MeetingJobsFile> => {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const fileContents = await fs.readFile(absolutePath, 'utf-8');
  const parsed = parseJobsFile(fileContents, absolutePath);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('meeting-jobs file must be an object');
  }

  if (!Array.isArray(parsed.jobs)) {
    throw new Error('meeting-jobs file must include a jobs array');
  }

  parsed.jobs.forEach((job, index) => {
    if (!job || typeof job !== 'object') {
      throw new Error(`Job at index ${index} must be an object`);
    }

    if (!job.provider || typeof job.provider !== 'string') {
      throw new Error(`Job at index ${index} must include provider`);
    }

    if (!job.payload || typeof job.payload !== 'object') {
      throw new Error(`Job at index ${index} must include payload`);
    }
  });

  return parsed;
};

const startServerProcess = async (
  envOverrides: Record<string, string>
): Promise<ChildProcess> => {
  const distServerPath = path.resolve(process.cwd(), 'dist', 'index.js');
  const srcServerPath = path.resolve(process.cwd(), 'src', 'index.ts');

  const serverEnv = {
    ...process.env,
    ...envOverrides,
  };

  const nodeExec = process.execPath;
  let args: string[];

  if (await fileExists(distServerPath)) {
    args = [distServerPath];
  } else {
    args = ['-r', 'ts-node/register', srcServerPath];
  }

  const child = spawn(nodeExec, args, {
    env: serverEnv,
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`Meeting bot server exited with code ${code}`);
    }
  });

  return child;
};

const waitForServerReady = async (): Promise<void> => {
  const deadline = Date.now() + startTimeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await axios.get(`${baseUrl}/health`, {
        timeout: requestTimeoutMs,
      });
      if (response.status === 200) {
        return;
      }
    } catch {
      // ignore and retry
    }

    await sleep(2000);
  }

  throw new Error(
    `Server did not become healthy within ${startTimeoutMs}ms`
  );
};

const getBusyStatus = async (): Promise<number> => {
  const response = await axios.get(`${baseUrl}/isbusy`, {
    timeout: requestTimeoutMs,
  });
  const payload = response.data as { success: boolean; data: number };

  if (!payload || typeof payload.data !== 'number') {
    throw new Error('Unexpected /isbusy response');
  }

  return payload.data;
};

const waitForBusyState = async (
  desiredState: 0 | 1,
  timeoutMs: number
): Promise<void> => {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;

  while (true) {
    const busyState = await getBusyStatus();
    if (busyState === desiredState) {
      return;
    }

    if (deadline && Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for isbusy=${desiredState} after ${timeoutMs}ms`
      );
    }

    await sleep(pollIntervalMs);
  }
};

const waitForJobCompletion = async (): Promise<void> => {
  await waitForBusyState(1, startTimeoutMs);
  await waitForBusyState(0, jobTimeoutMs);
};

const submitJob = async (job: MeetingJob): Promise<void> => {
  const endpoint = `${baseUrl}/${job.provider}/join`;

  while (true) {
    try {
      await axios.post(endpoint, job.payload, {
        timeout: requestTimeoutMs,
      });
      return;
    } catch (error) {
      if (
        error instanceof AxiosError &&
        error.response &&
        error.response.status === 409
      ) {
        await sleep(pollIntervalMs);
        continue;
      }

      throw error;
    }
  }
};

const stopServerProcess = async (child: ChildProcess): Promise<void> => {
  if (child.killed || child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 10000);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill('SIGTERM');
  });
};

const run = async () => {
  const jobsFile = await loadJobsFile(jobsFilePath);
  const envOverrides = normalizeEnv(jobsFile.env);

  let serverProcess: ChildProcess | null = null;

  try {
    if (startServer) {
      serverProcess = await startServerProcess(envOverrides);
      await waitForServerReady();
    }

    for (let index = 0; index < jobsFile.jobs.length; index += 1) {
      const job = jobsFile.jobs[index];
      console.log(`Submitting job ${index + 1}/${jobsFile.jobs.length}`);
      await submitJob(job);
      await waitForJobCompletion();
    }
  } finally {
    if (serverProcess) {
      await stopServerProcess(serverProcess);
    }
  }
};

run().catch((error) => {
  console.error('Failed to run meeting jobs:', error);
  process.exitCode = 1;
});
