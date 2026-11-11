// Browser origins allowed to call the API. The built-in list covers local
// development and the Aplisay sites. CORS_ORIGINS adds to it: a comma
// separated list of origins, for a front end served from another origin.
const builtIn = [
  'http://localhost:3000', 'http://localhost:3001', 'http://localhost:3030', 'http://localhost:5001',
  /^https:\/\/([a-z0-9-]+\.)*aplisay\.com$/,
  'https://feature-registration-db--playground-next.netlify.app',
];

export function corsOrigins(env = process.env) {
  const extra = (env.CORS_ORIGINS || '')
    .split(',')
    // An origin has no path, so a trailing slash would never match.
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return [...builtIn, ...extra];
}
