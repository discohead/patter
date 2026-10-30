declare namespace Cloudflare {
  interface Env {
    AI: Ai;
    PatterAgent: DurableObjectNamespace<import('./agent').PatterAgent>;
    PatchLibrary: DurableObjectNamespace<import('./library').PatchLibrary>;
    OnAir: DurableObjectNamespace<import('./on-air').OnAir>;
    LISTEN_LIMIT: RateLimit;
    SAMPLES: R2Bucket;
    AI_GATEWAY: string;
    ACCESS_TEAM: string;
    ACCESS_AUD: string;
    ALLOWED_EMAILS: string;
    ACCESS_MODE: string;
  }
}
interface Env extends Cloudflare.Env {}
