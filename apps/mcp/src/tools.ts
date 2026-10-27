import { backgroundCatalog } from '@content-layer/render-contract';
import { preparationSave, preparationRead } from './preparation.js';
import { z } from "zod";
import { runSchema } from "./runs.js";
import { viewportSchema } from "./viewport.js";

export const TOOL_NAMES = [
  "preparation_save", "preparation_read", "queue_enqueue", "queue_status", "queue_cancel", "account_usage", "navigation_start", "navigation_status", "navigation_guide", "navigation_stop", "browser_select",
  "session_connect", "connection_status", "session_import_status", "session_open", "session_close", "browser_observe", "browser_navigate", "browser_click",
  "browser_move", "browser_point", "browser_trace", "browser_sweep", "browser_read", "browser_type", "browser_scroll", "browser_key", "browser_wait", "mark_demo_moment", "recording_start", "recording_stop",
  "recording_status", "recording_cancel", "recording_render", "recording_links", "recording_run", "recording_run_status", "recording_run_finish", "recording_run_cancel", "demo_accounts_list",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
const id = z.string().uuid();
const originList = z.array(z.string().url()).min(1).max(12).optional();

export const TOOL_SCHEMAS: Record<ToolName, Record<string, z.ZodType>> = {
  preparation_save: preparationSave.shape,
  preparation_read: preparationRead.shape,
  queue_enqueue: {version:z.literal(1),operation:z.enum(['session_open','recording_render']),requestId:id,arguments:z.record(z.string(),z.unknown())},
  queue_status: {jobId:id},
  queue_cancel: {jobId:id},
  account_usage: {},
  navigation_start: { id, requestId: z.string().uuid(), goal: z.string().min(3).max(4000), guidance: z.string().max(12000).optional(), maximumActions: z.number().int().min(1).max(60).optional(), values: z.record(z.string().max(200), z.string().max(2000)).optional() },
  navigation_status: { id, waitMs: z.number().int().min(0).max(25000).optional() },
  navigation_guide: { id, instruction: z.string().min(1).max(4000), inputId: z.string().uuid().optional(), value: z.string().max(2000).optional() },
  navigation_stop: { id },
  browser_select: { id, ref: z.string().min(1).max(200), value: z.string().max(2000) },
  session_connect: { requestId: id.optional(), url: z.string().url(), allowedOrigins: originList, loginEmail: z.string().trim().min(3).max(320).optional(), useDemoAccount: z.boolean().optional() },
  connection_status: { id, waitMs: z.number().int().min(0).max(25_000).optional() },
  session_import_status: { importId: id },
  session_open: { localConnectionId:id.optional(), requestId: id.optional(), url: z.string().url(), allowedOrigins: originList, importId: id.optional(), viewport: viewportSchema.optional() },
  session_close: { id },
  browser_observe: { id, mode: z.enum(["outline", "screenshot", "both"]).optional() },
  browser_navigate: { id, url: z.string().url() },
  browser_click: { id, ref: z.string().min(1).max(200).optional(), x: z.number().finite().optional(), y: z.number().finite().optional() },
  browser_move: { id, ref: z.string().min(1).max(200).optional(), x: z.number().finite().optional(), y: z.number().finite().optional() },
  browser_point: { id, ref: z.string().min(1).max(200).optional(), x: z.number().finite().optional(), y: z.number().finite().optional() },
  browser_trace: { id, ref: z.string().min(1).max(200).optional(), x: z.number().finite().optional(), y: z.number().finite().optional(), shape: z.enum(["circle", "underline"]) },
  browser_sweep: { id, ref: z.string().min(1).max(200).optional(), x: z.number().finite().optional(), y: z.number().finite().optional(), rows: z.number().int().min(1).max(5).optional() },
  browser_read: { id, amount: z.number().int().min(300).max(3000).optional(), x: z.number().finite().optional(), y: z.number().finite().optional() },
  browser_type: { id, ref: z.string().min(1).max(200).optional(), text: z.string().max(10_000) },
  browser_scroll: { id, direction: z.enum(["up", "down", "left", "right"]), amount: z.number().finite().optional(), x: z.number().finite().optional(), y: z.number().finite().optional() },
  browser_key: { id, key: z.string().min(1).max(50) },
  browser_wait: { id, ms: z.number().int().min(250).max(10_000).optional(), until: z.enum(['change', 'duration']).optional() },
  mark_demo_moment: { id, kind: z.enum(["setup", "action", "result"]), note: z.string().min(1).max(120),
    observationId: id.optional(),
    focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) })
      .refine(f => f.x + f.width <= 1 && f.y + f.height <= 1, "focus must fit within the viewport").optional() },
  recording_start: { id },
  recording_stop: { id },
  recording_status: { id, waitMs: z.number().int().min(0).max(25_000).optional() },
  recording_cancel: { id },
  recording_render: { id, requestId: id.optional(), background: z.enum(["midnight", "ocean", "sunset", ...backgroundCatalog.map(entry => entry.id)] as [string, ...string[]]).optional(), padding: z.number().finite().min(0).max(100).optional(), cursorScale: z.number().finite().min(0.5).max(3).optional(), compressPauses: z.boolean().optional(), acceptReview: z.boolean().optional(), gif: z.boolean().optional(), width: z.union([z.literal(1280), z.literal(1920), z.literal(2560)]).optional() },
  recording_links: { id },
  recording_run: runSchema.shape,
  recording_run_status: { runId: id, waitMs: z.number().int().min(0).max(25_000).optional() },
  recording_run_finish: { runId: id, outcome: z.enum(["reached", "stuck"]), note: z.string().trim().max(300).optional() },
  recording_run_cancel: { runId: id },
  demo_accounts_list: {},
};
