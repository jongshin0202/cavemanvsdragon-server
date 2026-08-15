export interface Env {
  DB: D1Database;
  BACKUP_DB: D1Database;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
  PUBLIC_API_URL: string;
  WEB_APP_URL: string;
  ANDROID_STORE_URL: string;
  IOS_STORE_URL: string;
  SESSION_TTL_DAYS: string;
  PASSWORD_ITERATIONS: string;
  ADMIN_API_TOKEN: string;
  RATE_LIMIT_SECRET: string;
  RECOVERY_EMAIL_KEY?: string;
}

export type SourcePlatform = 'android' | 'ios' | 'web';
export type WebSource = 'desktop_web' | 'mobile_web' | 'pwa' | 'embedded' | 'unknown';
export type DeviceType = 'phone' | 'tablet' | 'desktop' | 'tv' | 'handheld' | 'unknown';
export type ControlType = 'keyboard' | 'touch' | 'gamepad' | 'mixed' | 'unknown';

export interface PlatformMeta {
  installation_id?: string;
  source_platform: SourcePlatform;
  web_source: WebSource | null;
  device_type: DeviceType;
  device_model: string | null;
  os_name: string | null;
  os_version: string | null;
  app_version: string | null;
  control_type: ControlType | null;
}

export interface PlayerAuth {
  session_id: string;
  player_id: string;
  display_name: string;
  normalized_name: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
}

export interface AdminAuth {
  actor: string;
}

export interface BackupOutboxRow {
  id: string;
  entity_type: string;
  entity_id: string;
  subject_player_id: string | null;
  operation: 'upsert' | 'delete' | 'privacy_delete';
  payload_json: string | null;
  occurred_at: string;
  attempt_count: number;
}

export interface LeaderboardRow {
  rank: number;
  player_id: string;
  display_name: string;
  best_score: number;
  level: number | null;
  achieved_at: string;
  updated_at: string;
  source_platform: SourcePlatform;
  web_source: WebSource | null;
  device_type: DeviceType;
  control_type: ControlType | null;
  app_version: string | null;
  verification_status: string;
  manual_rank: number | null;
  admin_note?: string | null;
  deleted_at?: string | null;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
