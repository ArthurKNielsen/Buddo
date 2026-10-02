// The app can be served from a sub-path (e.g. GitHub Pages: /Buddo/). BASE_URL always ends with "/".
export const BASE = import.meta.env.BASE_URL;
export const href = (p = '/') => BASE + p.replace(/^\/+/, '');
