export type MonitoringStatus = "pending" | "up" | "down";
export type OverallStatus = "operational" | "degraded" | "unknown";
export type HistoryRange = "24h" | "7d" | "30d";
type IncidentEndReason = "recovered" | "disabled" | "deleted";

export interface PublicMonitorDto {
  id: string;
  name: string;
  status: MonitoringStatus;
  lastCheckedAt: number | null;
  latencyMs: number | null;
  uptime: Record<HistoryRange, number | null>;
}

export interface PublicIncidentDto {
  monitorName: string;
  startedAt: number;
  confirmedAt: number;
  endedAt: number | null;
  endedReason: IncidentEndReason | null;
}

export interface PublicStatusDto {
  generatedAt: number;
  site: { name: string; description: string };
  overallStatus: OverallStatus;
  monitors: PublicMonitorDto[];
  recentIncidents: PublicIncidentDto[];
}

export interface PublicHistoryPointDto {
  time: number;
  checks: number;
  successes: number;
  failures: number;
  latency: {
    min: number | null;
    max: number | null;
    average: number | null;
  };
}

export interface PublicHistoryDto {
  generatedAt: number;
  monitor: { id: string; name: string };
  range: HistoryRange;
  points: PublicHistoryPointDto[];
}
