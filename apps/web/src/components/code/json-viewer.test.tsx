import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JsonViewer } from './json-viewer';

describe('JsonViewer', () => {
  it('renders redaction markers as REDACTED pills and never the raw value', () => {
    render(<JsonViewer label="params" value={{ sql: 'SELECT 1', connection_string: { $redacted: 'secret-values' }, headers: { 'x-api-key': { $redacted: 'token-keys' } }, n: 3, ok: true, none: null }} />);
    const pre = screen.getByLabelText('params');
    expect(pre).toHaveTextContent('"sql": "SELECT 1"');
    expect(screen.getByText('REDACTED · secret-values')).toBeInTheDocument();
    expect(screen.getByText('REDACTED · token-keys')).toBeInTheDocument();
    expect(pre).not.toHaveTextContent('$redacted');
    expect(pre).toHaveTextContent('"n": 3');
  });

  it('collapses long payloads behind "Show more"', async () => {
    const value = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    render(<JsonViewer label="big" value={value} collapseAfter={10} />);
    expect(screen.getByRole('button', { name: /show 12 more lines/i })).toBeInTheDocument();
  });
});
