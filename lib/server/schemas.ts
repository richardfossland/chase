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

export const teacherKey = z.string().regex(/^[A-Z0-9-]{16,40}$/);

export const createSessionBody = z.object({
  teacherKey: teacherKey.optional(),
  boundary: polygon,
  assembly: point,
  forbidden: multiPolygon.nullish(),
  teacherPhone: z.string().max(24).nullish(),
  // Shape only; chase._norm_plan() is the authority on limits (twin: lib/rules/game.ts).
  plan: z
    .object({
      rounds: z
        .array(z.object({ mode: z.enum(["free", "posts", "tag", "flag", "king"]), duration_s: z.number().int(), variant: z.enum(["convert", "swap"]).optional(), zone: z.boolean().optional(), team: z.boolean().optional() }))
        .min(1)
        .max(10),
      countdown_s: z.number().int().optional(),
      breather_s: z.number().int().optional(),
      qr_posts: z.number().int().optional(),
      event_every_s: z.number().int().optional(),
      teams: z.number().int().optional(),
      missions: z.array(z.string().max(200)).max(20).optional(),
    })
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
  // Informational only: an absurd value (sim teleport, broken sensor) must not drop the fix.
  speed: z.number().nullish().transform((v) => (v == null || !Number.isFinite(v) || v < 0 || v > 200 ? null : v)),
  ts: z.number().int().positive().optional(), // client epoch ms, ordering only
});

export const qrBody = playerAuth.extend({ code: z.string().min(3).max(16) });
export const catchBody = playerAuth.extend({ code: z.string().min(4).max(32) });

export const againBody = playerAuth.extend({ yes: z.boolean() });
export const eventBody = z.discriminatedUnion("action", [
  playerAuth.extend({ action: z.literal("powerup"), kind: z.enum(["shield", "radar", "decoy", "turbo"]) }),
  playerAuth.extend({ action: z.literal("mission") }),
  playerAuth.extend({ action: z.literal("team_msg"), kind: z.enum(["help", "come", "mine", "ok"]) }),
]);

export const sosBody = playerAuth.extend({ lat: lat.optional(), lng: lng.optional() });

export const hostAuth = z.object({ hostToken: token });

export const hostActionBody = hostAuth.extend({
  action: z.enum([
    "start", "next", "extend", "pause", "resume", "message", "gather", "end_gather",
    "check_in", "rename", "kick", "sit_out",
    "ceremony_start", "ceremony_next", "ceremony_back", "vote_again", "adjust_points", "set_role", "referee_award",
    "event_start", "event_stop", "mission_confirm", "events_auto",
    "teams_deal", "team_set",
  ]),
  payload: z
    .object({
      player_id: uuid.optional(),
      text: z.string().max(200).optional(),
      nickname: z.string().max(40).optional(),
      checked: z.boolean().optional(),
      on: z.boolean().optional(),
      seconds: z.number().int().optional(),
      delta: z.number().int().optional(),
      reason: z.string().max(80).optional(),
      role: z.enum(["hunter", "prey", "referee", "player"]).optional(),
      spread: z.boolean().optional(),
      yes: z.boolean().optional(),
      kind: z.enum(["sprint", "mission", "gather", "golden", "storm", "blackout"]).optional(),
      team: z.number().int().min(1).max(4).optional(),
    })
    .optional(),
});

export const snapshotBody = hostAuth.extend({ geo: z.boolean().optional() });
export const ackBody = hostAuth.extend({ alarmId: uuid });
export const endBody = hostAuth.extend({ force: z.boolean().optional() });

// Library + share links (0010). Shapes only; the RPCs validate content.
const libKind = z.enum(["area", "plan", "pack"]);
const shareCode = z.string().regex(/^[A-Za-z0-9]{8}$/);
export const libraryBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), teacherKey }),
  z.object({
    action: z.literal("save"),
    teacherKey,
    kind: libKind,
    id: uuid.nullish(),
    name: z.string().max(200),
    data: z.record(z.string(), z.unknown()).nullish(),
  }),
  z.object({ action: z.literal("delete"), teacherKey, kind: libKind, id: uuid }),
  z.object({ action: z.literal("share"), teacherKey, planId: uuid, areaId: uuid.nullish(), name: z.string().max(200).nullish() }),
  z.object({ action: z.literal("revoke"), teacherKey, code: shareCode }),
  z.object({ action: z.literal("copy"), teacherKey, code: shareCode }),
]);
