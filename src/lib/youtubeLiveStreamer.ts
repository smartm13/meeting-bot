import { spawn, ChildProcess } from 'child_process';
import { Logger } from 'winston';

type YouTubeLiveOptions = {
  rtmpUrl: string;
  ffmpegPath?: string;
};

export class YouTubeLiveStreamer {
  private readonly rtmpUrl: string;
  private readonly ffmpegPath: string;
  private readonly logger: Logger;
  private process: ChildProcess | null = null;

  constructor(options: YouTubeLiveOptions, logger: Logger) {
    this.rtmpUrl = options.rtmpUrl;
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
    this.logger = logger;
  }

  async start(): Promise<void> {
    if (this.process) return;

    return new Promise((resolve, reject) => {
      try {
        const args = [
          '-loglevel', 'info',
          '-fflags', '+genpts',
          '-f', 'webm',
          '-i', 'pipe:0',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-tune', 'zerolatency',
          '-g', '50',
          '-keyint_min', '50',
          '-sc_threshold', '0',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',
          '-ac', '2',
          '-f', 'flv',
          this.rtmpUrl,
        ];

        this.logger.info('Starting ffmpeg for YouTube Live', { args: args.join(' ') });

        this.process = spawn(this.ffmpegPath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderrBuffer = '';
        const startTime = Date.now();

        this.process.stdout?.on('data', (data) => {
          this.logger.debug('ffmpeg stdout:', data.toString());
        });

        this.process.stderr?.on('data', (data) => {
          const output = data.toString();
          stderrBuffer += output;
          const isStartup = (Date.now() - startTime) < 5000;
          if (output.includes('error') || output.includes('Error') || output.includes('Invalid') || output.includes('Failed')) {
            this.logger.error('ffmpeg error:', output.trim());
          } else if (isStartup) {
            this.logger.info('ffmpeg startup:', output.trim().substring(0, 200));
          } else {
            this.logger.debug('ffmpeg progress:', output.trim().substring(0, 150));
          }
        });

        let settled = false;

        this.process.on('exit', (code, signal) => {
          this.logger.info('ffmpeg live process exited', { code, signal });
          if (code !== 0 && code !== null) {
            const trimmed = stderrBuffer.trim();
            this.logger.error('ffmpeg live exited with error', { code, details: trimmed || 'no stderr output' });
            if (!settled) {
              settled = true;
              reject(new Error(`ffmpeg live exited with code ${code}`));
            }
          }
          this.process = null;
        });

        this.process.on('error', (error) => {
          this.logger.error('ffmpeg live process error:', error);
          if (!settled) {
            settled = true;
            reject(error);
          }
        });

        setTimeout(() => {
          if (settled) return;
          if (this.process && !this.process.killed && this.process.exitCode === null) {
            settled = true;
            resolve();
          } else {
            settled = true;
            reject(new Error('ffmpeg live failed to start'));
          }
        }, 2000);
      } catch (error) {
        reject(error);
      }
    });
  }

  async writeChunk(chunk: Buffer): Promise<void> {
    if (!this.process || !this.process.stdin) {
      throw new Error('ffmpeg live process is not running');
    }

    return new Promise((resolve, reject) => {
      try {
        const canWrite = this.process!.stdin!.write(chunk);
        if (canWrite) {
          resolve();
          return;
        }
        this.process!.stdin!.once('drain', () => resolve());
      } catch (error) {
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    return new Promise((resolve) => {
      const proc = this.process;
      if (!proc) {
        resolve();
        return;
      }

      try {
        proc.stdin?.write('q\n');
        proc.stdin?.end();
      } catch (error) {
        this.logger.warn('Failed to send quit signal to ffmpeg live', error as any);
        proc.kill('SIGTERM');
      }

      const timeout = setTimeout(() => {
        if (proc && !proc.killed) {
          this.logger.warn('ffmpeg live did not exit, sending SIGTERM');
          proc.kill('SIGTERM');
        }
      }, 15000);

      proc.on('exit', () => {
        clearTimeout(timeout);
        this.process = null;
        resolve();
      });
    });
  }
}
