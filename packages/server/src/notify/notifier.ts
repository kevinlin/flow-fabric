import { spawn } from 'node:child_process';

export interface Notifier {
  notify(title: string, body: string, link?: string): Promise<void>;
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.once('error', () => resolve(false)); // ENOENT etc.
    child.once('close', (code) => resolve(code === 0));
  });
}

/** macOS notifications: terminal-notifier, then osascript fallback. Never throws. */
export class MacNotifier implements Notifier {
  async notify(title: string, body: string, link?: string): Promise<void> {
    const args = ['-title', title, '-message', body, ...(link ? ['-open', link] : [])];
    if (await run('terminal-notifier', args)) return;
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
    await run('osascript', ['-e', script]);
  }
}
