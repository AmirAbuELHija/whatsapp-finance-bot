/**
 * Renders the "@bot summary" dashboard the way the Market Summary artifact looks: a headless Chromium opens
 * assets/templates/market-summary.html, fills it with live numbers and takes a 1920×1080 screenshot per slide.
 *
 * Safety: the page can't reach the network (every request but the template's own files is aborted, plus a
 * Content-Security-Policy in the template), all text goes in as plain text, and Chromium runs only for the
 * render and is closed right after. One render at a time keeps memory in check on a small VM.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Browser } from 'playwright-core';
import type { MarketSnapshot, MarketStory, OutgoingFile, SummaryRenderer } from '../../core/types.js';
import { summaryView, type SummaryView } from './summary-view.js';

const ASSETS = fileURLToPath(new URL('../../../assets/', import.meta.url));
const TEMPLATE = `${ASSETS}templates/market-summary.html`;
const SLIDES = ['wrap', 'more'] as const;

/** Where Chromium usually is: Google Chrome, then the Debian package (the bot's Docker image sets CHROMIUM_PATH). */
const KNOWN_BROWSERS = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

/**
 * Ubuntu's /usr/bin/chromium is only a launcher for the Snap package, which can't start headless from a service
 * or a test runner (it hangs until the launch times out). Skip it.
 */
export function isSnapLauncher(path: string): boolean {
  try {
    if (realpathSync(path).includes('/snap/')) return true;
    if (statSync(path).size > 64 * 1024) return false; // a real browser binary
    return readFileSync(path, 'utf8').includes('/snap/');
  } catch {
    return false;
  }
}

export function findChromium(configured?: string): string | null {
  if (configured) return existsSync(configured) ? configured : null;
  return KNOWN_BROWSERS.find((p) => existsSync(p) && !isSnapLauncher(p)) ?? null;
}

export interface BrowserSummaryOptions {
  executablePath: string;
  timeoutMs?: number;
}

export class BrowserSummaryRenderer implements SummaryRenderer {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: BrowserSummaryOptions) {}

  summarySlides(snapshot: MarketSnapshot, story: MarketStory, timeZone: string): Promise<OutgoingFile[]> {
    const view = summaryView(snapshot, story, timeZone);
    const day = snapshot.takenAt.toISOString().slice(0, 10);
    const run = this.queue.then(() => this.render(view, day));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async render(view: SummaryView, day: string): Promise<OutgoingFile[]> {
    const { chromium } = await import('playwright-core');
    const timeout = this.options.timeoutMs ?? 30_000;
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({
        executablePath: this.options.executablePath,
        headless: true,
        timeout,
        // Containers have no user namespaces for Chrome's sandbox; the page runs only our own template.
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
      });
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        javaScriptEnabled: true,
        offline: true,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      const allowed = pathToFileURL(ASSETS).href;
      await page.route('**/*', (route) =>
        route.request().url().startsWith(allowed) ? route.continue() : route.abort('blockedbyclient'),
      );
      await page.goto(pathToFileURL(TEMPLATE).href, { waitUntil: 'load' });
      await page.evaluate(
        (v) => (globalThis as unknown as { renderSummary(v: unknown): Promise<boolean> }).renderSummary(v),
        view,
      );
      const files: OutgoingFile[] = [];
      for (const [i, id] of SLIDES.entries()) {
        const data = await page.locator(`#${id}`).screenshot({ type: 'png', animations: 'disabled' });
        files.push({
          fileName: `market-summary-${day}-${i + 1}.png`,
          mimeType: 'image/png',
          data: new Uint8Array(data),
        });
      }
      return files;
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }
}

/** Tries the browser look first; if it fails (no Chromium, crash, timeout) falls back to the built-in SVG slides. */
export class FallbackSummaryRenderer implements SummaryRenderer {
  constructor(
    private readonly primary: SummaryRenderer,
    private readonly fallback: SummaryRenderer,
    private readonly logger?: { warn(obj: object, msg: string): void },
  ) {}

  async summarySlides(snapshot: MarketSnapshot, story: MarketStory, timeZone: string): Promise<OutgoingFile[]> {
    try {
      return await this.primary.summarySlides(snapshot, story, timeZone);
    } catch (error) {
      this.logger?.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'browser summary render failed, using the built-in slides',
      );
      return this.fallback.summarySlides(snapshot, story, timeZone);
    }
  }
}
