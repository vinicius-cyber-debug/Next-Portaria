declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    PORTO_JOB_TOKEN?: string;
    PORTO_ALLOW_HTTP_LAN?: string;
  }
}
