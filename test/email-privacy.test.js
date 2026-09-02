import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../public/assets/email-privacy.js', import.meta.url), 'utf8');
const context = { window: { location: { href: 'https://mail.example/' } } };
vm.runInNewContext(source, context);
const stripCssImports = context.window.EmailPrivacy.stripCssImports;

describe('email privacy CSS sanitizer', () => {
  it.each([
    ['quoted import', '@import "https://tracker.example/mail.css"; .message { color: black; }'],
    ['url import', '@import url("https://tracker.example/mail.css") screen; .message { color: black; }'],
    ['data import', '@import url(data:text/css;base64,YQ==); .message { color: black; }'],
    ['comment-obfuscated import', '@/**/im/**/port "https://tracker.example/mail.css"; .message { color: black; }'],
    ['escaped import', String.raw`@\69mport "https://tracker.example/mail.css"; .message { color: black; }`],
  ])('removes %s while preserving following rules', (_name, css) => {
    const result = stripCssImports(css);

    expect(result.removed).toBe(1);
    expect(result.css).not.toContain('tracker.example');
    expect(result.css).toContain('.message { color: black; }');
  });

  it('removes every import in a style block', () => {
    const result = stripCssImports('@import "one.css"; @import \'two.css\'; p { margin: 0; }');

    expect(result.removed).toBe(2);
    expect(result.css).toContain('p { margin: 0; }');
  });

  it('does not treat strings or comments as import rules', () => {
    const css = '.note::before { content: \'@import "fake.css";\'; } /* @import "fake.css"; */';
    const result = stripCssImports(css);

    expect(result.removed).toBe(0);
    expect(result.css).toBe(css);
  });
});
