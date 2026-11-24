import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ServerIcon } from './server-icon';

const img = (c: HTMLElement) => c.querySelector('img');

describe('ServerIcon', () => {
  it('renders the same-origin proxied icon, decorative', () => {
    const { container } = render(<ServerIcon server={{ id: 's1', name: 'GitHub', iconUrl: '/api/servers/s1/icon?v=abc' }} />);
    expect(img(container)).toHaveAttribute('src', '/api/servers/s1/icon?v=abc');
    expect(img(container)).toHaveAttribute('alt', '');
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('falls back to initials when there is no icon or it fails to load', () => {
    const none = render(<ServerIcon server={{ id: 's1', name: 'GitHub', iconUrl: null }} />);
    expect(img(none.container)).toBeNull();
    expect(none.container).toHaveTextContent('Gi');
    const broken = render(<ServerIcon server={{ id: 's2', name: 'Linear', iconUrl: '/api/servers/s2/icon' }} />);
    fireEvent.error(img(broken.container)!);
    expect(img(broken.container)).toBeNull();
    expect(broken.container).toHaveTextContent('Li');
  });

  it('without an iconUrl field (a plain server ref) tries the icon proxy path', () => {
    const { container } = render(<ServerIcon server={{ id: 'a b', name: 'Notion' }} />);
    expect(img(container)).toHaveAttribute('src', '/api/servers/a%20b/icon');
  });
});
