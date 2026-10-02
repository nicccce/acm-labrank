import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { QojHumanInput } from '@acm/core/server';

/** Local operator channel contains confirmation only, never passwords, Cookie or CAPTCHA text. */
export function qojHumanInput(options: { image: string; confirmationFile?: string }) {
  return async (input: QojHumanInput, screenshot: (path: string) => Promise<void>) => {
    const id = randomUUID();
    const image = resolve(options.image);
    await mkdir(dirname(image), { recursive: true });
    let imageCreated = false;
    if (input.kind === 'cloudflare') { await screenshot(image); imageCreated = true; }
    console.log(JSON.stringify({ event: 'human_input_required', id, kind: input.kind, url: input.url, ...(input.kind === 'cloudflare' ? { image } : {}), confirmationFile: options.confirmationFile ? resolve(options.confirmationFile) : undefined, message: 'Complete the actual page manually. Confirm only when done; Worker will verify identity and rerequest the original page.' }));
    try {
      if (options.confirmationFile) {
        while (!input.signal.aborted) {
          try {
            const confirmation = JSON.parse(await readFile(options.confirmationFile, 'utf8'));
            if (confirmation.id === id && confirmation.confirmed === true) { await rm(options.confirmationFile); return true; }
          } catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          await new Promise<void>((resolve, reject) => {
            const cancel = () => { clearTimeout(timer); reject(input.signal.reason); };
            const timer = setTimeout(() => { input.signal.removeEventListener('abort', cancel); resolve(); }, 500);
            input.signal.addEventListener('abort', cancel, { once: true });
            if (input.signal.aborted) cancel();
          });
        }
        input.signal.throwIfAborted();
      }
      if (!process.stdin.isTTY) return false;
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try { await terminal.question('Complete the dedicated browser page, then press Enter: ', { signal: input.signal }); return true; }
      finally { terminal.close(); }
    } finally { if (imageCreated) await rm(image, { force: true }); }
  };
}
