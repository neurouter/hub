/** Full-page navigations (OIDC, logout, upstream OAuth). Wrapped so tests can stub them. */
export const browserNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
  replace(url: string): void {
    window.location.replace(url);
  },
};
