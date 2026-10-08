import { defaultPreferences, parsePreferences, serializePreferences, validatePreferences, resolvedTheme, effectiveMotion } from '/design-system/preferences.js';

const storageKey = 'flowqa-display-preferences';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const systemReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const panel = document.getElementById('display-preferences');
const toggle = document.getElementById('theme-toggle');
const { t, onChange } = window.FlowQAI18n;
const themeNames = { system: 'display.themeSystemShort', light: 'display.themeLightShort', dark: 'display.themeDarkShort' };
const accentNames = { cobalt: 'settings.accentCobalt', forest: 'settings.accentForest', coral: 'settings.accentCoral' };
let preferences;
try { preferences = parsePreferences(localStorage.getItem(storageKey)); }
catch { preferences = { ...defaultPreferences }; }

function apply() {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme(preferences.theme, systemDark.matches);
  root.dataset.themePreference = preferences.theme;
  root.dataset.accent = preferences.accent;
  root.dataset.density = preferences.density;
  root.dataset.corners = preferences.corners;
  root.dataset.motion = effectiveMotion(preferences.motion, systemReduced.matches);
  for (const input of panel.querySelectorAll('input[type="radio"]')) {
    input.checked = preferences[input.name] === input.value;
  }
  const theme = t(themeNames[preferences.theme]);
  toggle.textContent = t('display.themeButton', { theme });
  toggle.setAttribute('aria-label', t('display.currentTheme', { theme }));
  document.getElementById('preferences-status').textContent = `${theme} · ${t(accentNames[preferences.accent])}${systemReduced.matches ? ` · ${t('display.motionSystemReduced')}` : ''}`;
}

function update(next) {
  preferences = validatePreferences(next);
  try { localStorage.setItem(storageKey, serializePreferences(preferences)); } catch { /* Current tab still works without storage. */ }
  apply();
}

panel.addEventListener('change', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'radio' || !Object.hasOwn(defaultPreferences, input.name)) return;
  update({ ...preferences, [input.name]: input.value });
});
toggle.addEventListener('click', () => {
  const themes = ['system', 'light', 'dark'];
  update({ ...preferences, theme: themes[(themes.indexOf(preferences.theme) + 1) % themes.length] });
});
document.getElementById('reset-preferences').addEventListener('click', () => update({ ...defaultPreferences }));
window.addEventListener('storage', (event) => {
  if (event.key !== storageKey && event.key !== null) return;
  preferences = parsePreferences(event.newValue);
  apply();
});
systemDark.addEventListener('change', apply);
systemReduced.addEventListener('change', apply);
onChange(apply);
apply();
