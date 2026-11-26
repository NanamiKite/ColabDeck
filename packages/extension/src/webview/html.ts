export interface DashboardHtmlOptions {
  readonly indexHtml: string;
  readonly assetBaseUri: string;
  readonly cspSource: string;
  readonly nonce: string;
}

export function buildDashboardHtml(options: DashboardHtmlOptions): string {
  const csp = [
    "default-src 'none'",
    `img-src ${options.cspSource} https: data:`,
    `style-src ${options.cspSource} 'unsafe-inline'`,
    `font-src ${options.cspSource}`,
    `script-src 'nonce-${options.nonce}'`,
    `connect-src ${options.cspSource}`,
  ].join('; ');
  const withCsp = options.indexHtml.replace(
    '<head>',
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );
  const withAssets = withCsp
    .replaceAll('src="./assets/', `src="${options.assetBaseUri}/assets/`)
    .replaceAll('href="./assets/', `href="${options.assetBaseUri}/assets/`);
  return withAssets.replaceAll('<script ', `<script nonce="${options.nonce}" `);
}
