/**
 * The pre-paint theme stamp.
 *
 * `theme.css` defines the dark palette under both `prefers-color-scheme` and
 * `[data-theme='dark']`, so the app is themed correctly with no JavaScript at
 * all. This exists for the third case: a reader whose *explicit* choice
 * disagrees with their operating system. Resolving that in an effect means one
 * frame of the wrong theme on every navigation, so it is resolved here, in a
 * blocking inline script, before the first paint.
 *
 * A plain module rather than part of the toggle component: the root layout is a
 * server component and should not pull a client module in to read one string.
 */
export const THEME_KEY = 'wizard-ads.theme';

export const THEME_SCRIPT = [
  'try{',
  `var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});`,
  "if(t!=='light'&&t!=='dark'){",
  "t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';",
  '}',
  "document.documentElement.setAttribute('data-theme',t);",
  "}catch(e){document.documentElement.setAttribute('data-theme','light');}",
].join('');
