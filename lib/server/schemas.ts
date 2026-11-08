import { z } from "zod";

// Request bodies. Positions only ever arrive in POST bodies (never URLs).

const lng = z.number().min(-180).max(180);
const lat = z.number().min(-90).max(90);
const position = z.tuple([lng, lat]);
const ring = z.array(position).min(4).max(500);

export const polygon = z.object({ type: z.literal("Polygon"), coordinates: z.array(ring).length(1) });
export const multiPolygon = z.object({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(z.array(ring).length(1)).min(1).max(20),
});
export const point = z.object({ type: z.literal("Point"), coordinates: position });

export const token = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/);
export const uuid = z.uuid();

export const createSessionBody = z.object({
  teacherKey: z.string().regex(/^[A-Z0-9-]{16,40}$/).optional(),
  boundary: polygon,
  assembly: point,
  forbidden: multiPolygon.nullish(),
  teacherPhone: z.string().max(24).nullish(),
  plan: z
    .object({ rounds: z.array(z.object({ mode: z.literal("free"), duration_s: z.number().int().min(60).max(3600) })).min(1).max(1) })
    .optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  sim: z.boolean().optional(),
});

export const joinBody = z.object({
  pin: z.string().regex(/^\d{6}$/),
  nickname: z.string().min(1).max(40),
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
});

export const resumeBody = z.object({
  pin: z.string().regex(/^\d{6}$/),
  resumeCode: z.string().min(4).max(12),
});

export const playerAuth = z.object({ playerId: uuid, token });

export const tickBody = playerAuth.extend({
  lat,
  lng,
  acc: z.number().min(0).max(10_000),
  speed: z.number().min(0).max(200).nullish(),
  ts: z.number().int().positive().optional(), // client epoch ms, ordering only
});

export const sosBody = playerAuth.extend({ lat: lat.optional(), lng: lng.optional() });

export const hostAuth = z.object({ hostToken: token });

export const hostActionBody = hostAuth.extend({
  action: z.enum(["start", "pause", "resume", "message", "gather", "end_gather", "check_in", "rename", "kick", "sit_out"]),
  payload: z
    .object({
      player_id: uuid.optional(),
      text: z.string().max(200).optional(),
      nickname: z.string().max(40).optional(),
      checked: z.boolean().optional(),
      on: z.boolean().optional(),
    })
    .optional(),
});

export const snapshotBody = hostAuth.extend({ geo: z.boolean().optional() });
export const ackBody = hostAuth.extend({ alarmId: uuid });
export const endBody = hostAuth.extend({ force: z.boolean().optional() });
