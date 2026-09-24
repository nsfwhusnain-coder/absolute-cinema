/**
 * The only media-operator secrets a household has to supply.
 *
 * Catalog (posters, titles, search) needs TMDB. Premium debrid sources need
 * a Real-Debrid token. Scrapers, the player, and HLS proxy are built in —
 * TorBox, CinePro, and the Cloudflare worker are optional extras, never
 * required for the default click-play path.
 */

export const OPERATOR_TMDB_SETTING_KEY = "tmdb_api_key";
export const OPERATOR_TMDB_ENV = "TMDB_API_KEY";
export const OPERATOR_DEBRID_SETTING_KEY = "realdebrid_token";
export const OPERATOR_DEBRID_ENV = "REAL_DEBRID_API_TOKEN";

export const REQUIRED_OPERATOR_MEDIA_ENV = [OPERATOR_TMDB_ENV] as const;
export const OPTIONAL_OPERATOR_MEDIA_ENV = [OPERATOR_DEBRID_ENV] as const;

export const NOT_REQUIRED_OPERATOR_ENV = [
  "TORBOX_API_KEY",
  "CINEPRO_URL",
  "WORKER_PROXY_SECRET",
  "WORKER_PROXY_ENABLED",
] as const;
