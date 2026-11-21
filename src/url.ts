// Prefix internal links with the site's base path, so the site works both at
// https://<user>.github.io/ and at https://<user>.github.io/<repo>/
const base = import.meta.env.BASE_URL.replace(/\/$/, "");
export const url = (path: string) => `${base}${path.startsWith("/") ? path : `/${path}`}`;
