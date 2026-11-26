import { describe, expect, it } from 'vitest';
import { buildDashboardHtml } from './html.js';

describe('buildDashboardHtml', () => {
  it('rewrites assets and injects CSP with a nonce', () => {
    const html = buildDashboardHtml({
      indexHtml:
        '<html><head></head><body><script type="module" src="./assets/index.js"></script><link rel="stylesheet" href="./assets/index.css"></body></html>',
      assetBaseUri: 'https://file+.vscode-resource.example.com/webview',
      cspSource: 'https://file+.vscode-resource.example.com',
      nonce: 'abc123',
    });
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("script-src 'nonce-abc123'");
    expect(html).toContain('src="https://file+.vscode-resource.example.com/webview/assets/index.js"');
    expect(html).toContain('href="https://file+.vscode-resource.example.com/webview/assets/index.css"');
    expect(html).toContain('<script nonce="abc123"');
  });
});
