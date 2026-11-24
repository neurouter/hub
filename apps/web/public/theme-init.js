/*
 * Pre-paint theme script (FOUC guard, frontend plan §7). Loaded synchronously from <head> as an
 * external file so the CSP needs no 'unsafe-inline'. Mirrors src/components/theme/theme-core.ts:
 * reads `neurouter-theme` (light | dark | system, default system) and sets `.dark` + color-scheme.
 */
(function () {
  var theme = 'system';
  try {
    var stored = window.localStorage.getItem('neurouter-theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') theme = stored;
  } catch (e) {
    /* storage unavailable: follow the system */
  }
  var dark = theme === 'dark';
  if (theme === 'system') {
    try {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {
      dark = false;
    }
  }
  var root = document.documentElement;
  if (dark) root.classList.add('dark');
  else root.classList.remove('dark');
  root.style.colorScheme = dark ? 'dark' : 'light';
  // table density (src/lib/display-prefs.ts), applied before paint so tables don't jump
  try {
    var display = JSON.parse(window.localStorage.getItem('neurouter-display') || '{}');
    root.dataset.density = display && display.density === 'compact' ? 'compact' : 'comfortable';
  } catch (e) {
    root.dataset.density = 'comfortable';
  }
})();

/*
 * Zod CSP mode (W11). The CSP has script-src 'self' without 'unsafe-eval'; zod 4 otherwise probes
 * `new Function('')` when the shared schemas are constructed, which the browser reports as a CSP
 * violation even though zod catches it. zod reads `globalThis.__zod_globalConfig` when it loads, so
 * this classic script (which runs before the module bundle) turns its JIT off first.
 */
(function () {
  var g = window.__zod_globalConfig || (window.__zod_globalConfig = {});
  g.jitless = true;
})();
